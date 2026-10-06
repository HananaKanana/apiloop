import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as sioApi from '@/api/sio';
import { getNdjson } from '@/api/stream';
import { t } from '@/i18n';

/**
 * Socket.IO 调试会话的运行时状态（第九轮第 4 节）。
 *
 * 和 `stores/ws.js` 是同一套结构（状态按**标签页 key** 存放，切换标签页不丢连接和日志），
 * 差别只在「发出去的是什么」：那边是一段文本 / 二进制帧，这里是「事件名 + 参数数组 + 要不要 ack」。
 * 两个 store 各自独立 —— 硬合成一个会让两边的字段一半用不上一半要靠约定。
 */

const MAX_EVENTS = 2000;
const RETRY_DELAYS = [1000, 2000, 5000];

const timers = new Map();
const readers = new Map();
const attempts = new Map();

export const useSioStore = defineStore('sio', function () {
  /** tabKey -> 会话状态 */
  const sessions = ref({});

  function ensure(key) {
    if (!sessions.value[key]) {
      sessions.value[key] = {
        // 闭包一律读 state.key：标签页「保存到目录」之后 key 会从 `sio:N` 变成 `api:<id>`
        key: key,
        status: 'idle',
        channel: 'idle',
        sessionId: '',
        url: '',
        sid: '',
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

  function pushLocal(state, text) {
    push(state, { time: Date.now(), type: 'local', text: text });
  }

  function handleEvent(state, event) {
    if (!event || !event.type) return;
    push(state, event);

    if (event.type === 'open') {
      state.status = 'open';
      state.sid = event.sid || '';
      state.note = event.note || '';
      attempts.delete(state.key);
      return;
    }
    if (event.type === 'close') {
      state.status = 'closed';
      attempts.delete(state.key);
      return;
    }
    if (event.type === 'error') {
      state.status = 'error';
    }
  }

  function startEvents(state) {
    abortReader(state.key);

    const controller = new AbortController();
    readers.set(state.key, controller);

    function stale() {
      return readers.get(state.key) !== controller;
    }

    getNdjson(sioApi.eventsPath(state.sessionId, state.lastSeq), {
      signal: controller.signal,
      onEvent: function (event) { handleEvent(state, event); },
      onOpen: function () {
        if (stale()) return;
        if (state.channel !== 'ended') state.channel = 'live';
      }
    }).then(
      function () {
        if (stale()) return;
        readers.delete(state.key);
        scheduleRetry(state, null);
      },
      function (err) {
        if (stale()) return;
        readers.delete(state.key);
        if (err && err.aborted) return;
        scheduleRetry(state, err);
      }
    );
  }

  function scheduleRetry(state, err) {
    if (err && err.status === 404) {
      state.status = 'ended';
      state.channel = 'ended';
      state.error = '';
      return;
    }
    if (state.channel === 'ended' || state.channel === 'idle') return;

    const attempt = attempts.get(state.key) || 0;
    const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
    attempts.set(state.key, attempt + 1);

    state.channel = 'retrying';
    if (err && !state.sessionId) state.error = err.message;

    clearTimer(state.key);
    timers.set(state.key, setTimeout(function () {
      timers.delete(state.key);
      startEvents(state);
    }, delay));
  }

  /**
   * 建会话并开始收事件。返回是否建成功（失败时 state.error 里有中文原因）。
   *
   * spec 的形状：`{ url, params: { headers, query }, auth, sio: { path, namespace,
   * transports, listenEvents, auth } }`。
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
    state.sid = '';
    state.sessionId = '';
    state.lastSeq = 0;
    state.events = [];
    state.dropped = 0;
    state.url = (payload.spec && payload.spec.url) || '';

    if (previous) {
      sioApi.destroySession(previous).catch(function () { /* 已经没了就算了 */ });
    }

    let data;
    try {
      data = await sioApi.createSession(payload.projectId, {
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
    startEvents(state);
    return true;
  }

  /** 发一个事件：`{ event, args, ack }` */
  async function emit(key, payload) {
    const state = stateOf(key);
    if (!state || !state.sessionId) return false;

    try {
      await sioApi.emitEvent(state.sessionId, payload);
      state.error = '';
      return true;
    } catch (err) {
      state.error = err.message;
      return false;
    }
  }

  async function disconnect(key) {
    const state = stateOf(key);
    if (!state) return;

    stop(key);
    const id = state.sessionId;
    state.sessionId = '';
    state.status = 'closed';
    state.channel = 'idle';
    pushLocal(state, t('stores.disconnected'));

    if (id) {
      try {
        await sioApi.destroySession(id);
      } catch (err) {
        // 会话可能已经被服务端回收了，断开这个动作本身算成功
      }
    }
  }

  function clearLog(key) {
    const state = stateOf(key);
    if (!state) return;
    state.events = [];
    state.dropped = 0;
  }

  /** 标签页 key 变了的时候，把会话状态整体搬到新 key 下（同 stores/ws.js） */
  function move(fromKey, toKey) {
    if (!fromKey || !toKey || fromKey === toKey) return;

    const state = sessions.value[fromKey];
    if (state) {
      sessions.value[toKey] = state;
      delete sessions.value[fromKey];
      state.key = toKey;
    }

    [timers, readers, attempts].forEach(function (map) {
      if (!map.has(fromKey)) return;
      map.set(toKey, map.get(fromKey));
      map.delete(fromKey);
    });
  }

  function closeFor(key) {
    const state = stateOf(key);
    stop(key);
    attempts.delete(key);

    if (state && state.sessionId) {
      const id = state.sessionId;
      state.sessionId = '';
      sioApi.destroySession(id).catch(function () { /* 已经没了就算了 */ });
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
    emit: emit,
    disconnect: disconnect,
    clearLog: clearLog,
    move: move,
    closeFor: closeFor,
    closeAll: closeAll
  };
});
