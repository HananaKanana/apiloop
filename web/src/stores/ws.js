import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as wsApi from '@/api/ws';
import { getNdjson } from '@/api/stream';

/**
 * WebSocket 调试会话的运行时状态（契约第 15 节）。
 *
 * 状态按**标签页 key** 存放，而不是放在组件里：标签页一切换，RequestTab / WsTab
 * 这类组件就会卸载重建（WorkbenchView 上是按 activeKey 加的 key），
 * 状态放组件里等于「切走就断线、日志也没了」。
 *
 * 这里只管会话和事件流，界面在 components/ws/ 下。
 */

/** 界面上最多保留多少条，超出丢最旧的 */
const MAX_EVENTS = 2000;

/** events 连接意外断开后的重连间隔；用完就一直用最后一个 */
const RETRY_DELAYS = [1000, 2000, 5000];

// 计时器、AbortController、重试次数都不放进 reactive：它们不参与渲染，
// 放进响应式对象只会多包一层代理，清理时还容易漏。
const timers = new Map();
const readers = new Map();
const attempts = new Map();

export const useWsStore = defineStore('ws', function () {
  /** tabKey -> 会话状态 */
  const sessions = ref({});

  function ensure(key) {
    if (!sessions.value[key]) {
      sessions.value[key] = {
        // status 只跟着上游 socket 走：connecting → open → closed / error
        status: 'idle',
        // channel 是 events 长连接自己的状态：live / retrying / ended。
        // 两者要分开：上游关了之后 socket 是 closed，但事件流还在（还能看到 close 事件），
        // 反过来事件流断了要重连，也不能因此说 socket 断了。
        channel: 'idle',
        sessionId: '',
        url: '',
        protocol: '',
        note: '',
        error: '',
        events: [],
        dropped: 0,
        lastSeq: 0
      };
    }
    return sessions.value[key];
  }

  function stateOf(key) {
    return sessions.value[key] || null;
  }

  function clearTimer(key) {
    const id = timers.get(key);
    if (id) {
      clearTimeout(id);
      timers.delete(key);
    }
  }

  function abortReader(key) {
    const controller = readers.get(key);
    if (controller) {
      readers.delete(key);
      controller.abort();
    }
  }

  function stop(key) {
    clearTimer(key);
    abortReader(key);
  }

  function push(state, event) {
    state.events.push(event);
    const overflow = state.events.length - MAX_EVENTS;
    if (overflow > 0) {
      state.events.splice(0, overflow);
      state.dropped += overflow;
    }
    if (typeof event.seq === 'number') state.lastSeq = event.seq;
  }

  /** 界面上自己记一条（比如用户点了断开），和上游来的事件区分开 */
  function pushLocal(state, text) {
    push(state, { time: Date.now(), type: 'local', text: text });
  }

  function handleEvent(key, state, event) {
    if (!event || !event.type) return;
    push(state, event);

    if (event.type === 'open') {
      state.status = 'open';
      state.protocol = event.protocol || '';
      state.note = event.note || '';
      attempts.delete(key);
      return;
    }
    if (event.type === 'close') {
      state.status = 'closed';
      attempts.delete(key);
      return;
    }
    if (event.type === 'error') {
      state.status = 'error';
    }
  }

  function startEvents(key, state) {
    abortReader(key);

    const controller = new AbortController();
    readers.set(key, controller);

    function stale() {
      return readers.get(key) !== controller;
    }

    getNdjson(wsApi.eventsPath(state.sessionId, state.lastSeq), {
      signal: controller.signal,
      onEvent: function (event) { handleEvent(key, state, event); },
      onOpen: function () {
        if (stale()) return;
        // 重连成功。服务端只补发 seq 之后的事件，不会再发一次 open 事件，
        // 所以「重连中」这个状态得在这里收回来。
        if (state.channel !== 'ended') state.channel = 'live';
      }
    }).then(
      function () {
        if (stale()) return;
        readers.delete(key);
        scheduleRetry(key, state, null);
      },
      function (err) {
        if (stale()) return;
        readers.delete(key);
        // 自己断开（关标签页 / 点断开 / 切项目）时不重连
        if (err && err.aborted) return;
        scheduleRetry(key, state, err);
      }
    );
  }

  function scheduleRetry(key, state, err) {
    // 404：会话已经不存在了（服务端回收了，或者被别人删了），不用再试
    if (err && err.status === 404) {
      state.status = 'ended';
      state.channel = 'ended';
      state.error = '';
      return;
    }
    if (state.channel === 'ended' || state.channel === 'idle') return;

    const attempt = attempts.get(key) || 0;
    const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
    attempts.set(key, attempt + 1);

    state.channel = 'retrying';
    if (err && !state.sessionId) state.error = err.message;

    clearTimer(key);
    timers.set(key, setTimeout(function () {
      timers.delete(key);
      startEvents(key, state);
    }, delay));
  }

  /**
   * 建会话并开始收事件。返回是否建成功（失败时 state.error 里有中文原因）。
   * spec 的形状见契约第 15 节：`{ url, params: { headers, query }, auth }`。
   */
  async function connect(key, payload) {
    stop(key);
    attempts.delete(key);

    const state = ensure(key);
    const previous = state.sessionId;

    state.status = 'connecting';
    state.channel = 'live';
    state.error = '';
    state.note = '';
    state.protocol = '';
    state.sessionId = '';
    state.lastSeq = 0;
    state.events = [];
    state.dropped = 0;
    state.url = (payload.spec && payload.spec.url) || '';

    // 没有先断开就直接重连：把上一个会话销毁掉，别在服务端留着
    if (previous) {
      wsApi.destroySession(previous).catch(function () { /* 已经没了就算了 */ });
    }

    let data;
    try {
      data = await wsApi.createSession(payload.projectId, {
        spec: payload.spec,
        environmentId: payload.environmentId || undefined,
        options: payload.options
      });
    } catch (err) {
      state.status = 'idle';
      state.channel = 'idle';
      state.error = err.message;
      return false;
    }

    state.sessionId = data.session.id;
    state.url = data.session.url || state.url;
    startEvents(key, state);
    return true;
  }

  async function send(key, text) {
    const state = stateOf(key);
    if (!state || !state.sessionId) return false;

    try {
      await wsApi.sendMessage(state.sessionId, { text: text });
      state.error = '';
      return true;
    } catch (err) {
      state.error = err.message;
      return false;
    }
  }

  /** 用户点「断开」：先断事件流再销毁会话，顺序反了会白等一次重连 */
  async function disconnect(key) {
    const state = stateOf(key);
    if (!state) return;

    stop(key);
    const id = state.sessionId;
    state.sessionId = '';
    state.status = 'closed';
    state.channel = 'idle';
    pushLocal(state, '已断开连接');

    if (id) {
      try {
        await wsApi.destroySession(id);
      } catch (err) {
        // 会话可能已经被服务端回收了，断开这个动作本身算成功
      }
    }
  }

  /** 只清空界面上的显示：服务端缓冲还在，重连时按 after=lastSeq 也补不回这些 */
  function clearLog(key) {
    const state = stateOf(key);
    if (!state) return;
    state.events = [];
    state.dropped = 0;
  }

  /**
   * 标签页 key 变了的时候，把会话状态整体搬到新 key 下。
   *
   * 临时 WebSocket 标签页「保存到目录」之后，key 会从 `ws:N` 变成 `api:<id>`，
   * 而会话状态是按 key 存的 —— 不搬的话，刚录下来的消息日志、还连着的会话、
   * 重连计时器全都留在旧 key 上：界面上日志变空（「保存为 mock」跟着不可用），
   * 旧会话还会一直挂在服务端。
   */
  function move(fromKey, toKey) {
    if (!fromKey || !toKey || fromKey === toKey) return;

    const state = sessions.value[fromKey];
    if (state) {
      sessions.value[toKey] = state;
      delete sessions.value[fromKey];
    }

    [timers, readers, attempts].forEach(function (map) {
      if (!map.has(fromKey)) return;
      map.set(toKey, map.get(fromKey));
      map.delete(fromKey);
    });
  }

  /** 标签页被关掉 / 切项目时调用：不保留任何东西 */
  function closeFor(key) {
    const state = stateOf(key);
    stop(key);
    attempts.delete(key);

    if (state && state.sessionId) {
      const id = state.sessionId;
      state.sessionId = '';
      wsApi.destroySession(id).catch(function () { /* 已经没了就算了 */ });
    }
    delete sessions.value[key];
  }

  function closeAll() {
    Object.keys(sessions.value).forEach(closeFor);
  }

  return {
    sessions: sessions,
    ensure: ensure,
    stateOf: stateOf,
    connect: connect,
    send: send,
    disconnect: disconnect,
    clearLog: clearLog,
    move: move,
    closeFor: closeFor,
    closeAll: closeAll
  };
});
