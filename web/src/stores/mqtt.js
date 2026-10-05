import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as mqttApi from '@/api/mqtt';
import { getNdjson } from '@/api/stream';

/**
 * MQTT 调试会话的运行时状态（第十三轮）。
 *
 * 和 `stores/sio.js` 是同一套结构（状态按**标签页 key** 存放，切标签页不丢连接和日志），
 * 差别在「会话里在发生什么」：那边是「事件名 + 参数数组」，这里是
 * 「连接 / 订阅 / 发布 / 收消息」四种，事件类型见 `lib/mqtt-sessions.js` 的 `push`。
 *
 * 后端事件（每条都带 `seq` 和 `time`）：
 * - `connecting { url, clientId, note? }` / `connected { sessionPresent }` / `reconnecting`
 * - `subscribed { topic, qos, granted, error? }`（`granted >= 128` 是 broker 拒绝）
 * - `unsubscribed { topic }`
 * - `message { topic, qos, retain, payload?, payloadBase64?, size, truncated, properties, at }`
 * - `published { topic, payload, qos, retain, at }`
 * - `closed { reason? }` / `error { error }`
 *
 * 两处和 Socket.IO 不同、容易写错的地方：
 * - 错误事件里的字段叫 **`error`**（不是 `message`），关闭事件里的原因叫 **`reason`**；
 * - `closed` 是**正常事件**（用户点断开、broker 正常下线都会走到它），不能当成错误弹出来 ——
 *   出错只认 `error` 事件，`closed` 的原因只写进消息日志。
 */

/** 界面上最多保留多少条，超出丢最旧的 */
const MAX_EVENTS = 2000;

/** events 连接意外断开后的重连间隔；用完就一直用最后一个 */
const RETRY_DELAYS = [1000, 2000, 5000];

// 计时器、AbortController、重试次数不放进 reactive（同 stores/sio.js）
const timers = new Map();
const readers = new Map();
const attempts = new Map();

export const useMqttStore = defineStore('mqtt', function () {
  /** tabKey -> 会话状态 */
  const sessions = ref({});

  function ensure(key) {
    if (!sessions.value[key]) {
      sessions.value[key] = {
        // 闭包一律读 state.key：标签页「保存到目录」之后 key 会从 `mqtt:N` 变成 `api:<id>`
        key: key,
        // idle / connecting / open / reconnecting / closed / error / ended
        status: 'idle',
        // events 长连接自己的状态：live / retrying / ended
        channel: 'idle',
        sessionId: '',
        url: '',
        clientId: '',
        note: '',
        error: '',
        events: [],
        dropped: 0,
        lastSeq: 0,
        /**
         * 主题 -> 最后一次订阅结果 `{ topic, qos, granted, error }`。
         * 订阅页签靠它显示「已订阅 / broker 拒绝」；取消订阅时把这一项删掉。
         * 重连后服务端会再自动订阅一轮，这里跟着被覆盖成最新一次的结果。
         */
        subs: {}
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

  /** 界面上自己记一条（比如用户点了断开），和 broker 来的事件区分开 */
  function pushLocal(state, text) {
    push(state, { time: Date.now(), type: 'local', text: text });
  }

  function handleEvent(state, event) {
    if (!event || !event.type) return;
    push(state, event);

    if (event.type === 'connecting') {
      state.status = 'connecting';
      state.url = event.url || state.url;
      state.clientId = event.clientId || '';
      state.note = event.note || '';
      return;
    }
    if (event.type === 'connected') {
      state.status = 'open';
      attempts.delete(state.key);
      return;
    }
    if (event.type === 'reconnecting') {
      state.status = 'reconnecting';
      return;
    }
    if (event.type === 'subscribed') {
      state.subs[event.topic] = {
        topic: event.topic,
        qos: event.qos,
        granted: event.granted,
        error: event.error || ''
      };
      return;
    }
    if (event.type === 'unsubscribed') {
      delete state.subs[event.topic];
      return;
    }
    // closed 是正常事件（点断开、broker 正常下线都会走到），原因只写进日志，不当错误。
    // 但**出错之后紧跟着的那个 closed 不改状态**：连不上 broker 时服务端是
    // error + closed 两条连着发，把状态从「出错」降成「已断开」等于把真正的原因藏起来。
    if (event.type === 'closed') {
      if (state.status !== 'error') state.status = 'closed';
      attempts.delete(state.key);
      return;
    }
    if (event.type === 'error') {
      state.status = 'error';
      state.error = event.error || '';
    }
  }

  function startEvents(state) {
    abortReader(state.key);

    const controller = new AbortController();
    readers.set(state.key, controller);

    function stale() {
      return readers.get(state.key) !== controller;
    }

    getNdjson(mqttApi.eventsPath(state.sessionId, state.lastSeq), {
      signal: controller.signal,
      onEvent: function (event) { handleEvent(state, event); },
      onOpen: function () {
        if (stale()) return;
        // 重连成功。服务端只补发 seq 之后的事件，不会再发一次 connecting，
        // 所以「重连中」这个状态得在这里收回来。
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
        // 自己断开（关标签页 / 点断开 / 切项目）时不重连
        if (err && err.aborted) return;
        scheduleRetry(state, err);
      }
    );
  }

  function scheduleRetry(state, err) {
    // 404：会话已经不存在了（服务端回收了，或者被别人删了），不用再试
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
   * `payload` 的形状就是服务端要的那份平铺请求体：
   * `{ projectId, apiId?, environmentId?, url, clientId, username, password,
   *    protocolVersion, clean, keepalive, connectTimeoutMs, will, subscriptions }`
   * （见 `lib/api/mqtt.js` 的 `prepareSession`）。
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
    state.clientId = '';
    state.sessionId = '';
    state.lastSeq = 0;
    state.events = [];
    state.dropped = 0;
    state.subs = {};
    state.url = payload.url || '';

    // 没有先断开就直接重连：把上一个会话销毁掉，别在服务端留着
    if (previous) {
      mqttApi.destroySession(previous).catch(function () { /* 已经没了就算了 */ });
    }

    let data;
    try {
      data = await mqttApi.createSession(payload.projectId, {
        apiId: payload.apiId || undefined,
        environmentId: payload.environmentId || undefined,
        url: payload.url,
        clientId: payload.clientId,
        username: payload.username,
        password: payload.password,
        protocolVersion: payload.protocolVersion,
        clean: payload.clean,
        keepalive: payload.keepalive,
        connectTimeoutMs: payload.connectTimeoutMs,
        will: payload.will,
        subscriptions: payload.subscriptions
      });
    } catch (err) {
      state.status = 'idle';
      state.channel = 'idle';
      state.error = err.message;
      return false;
    }

    state.sessionId = data.id;
    startEvents(state);
    return true;
  }

  /** 运行中订阅一个主题：`{ topic, qos }` */
  async function subscribe(key, payload) {
    const state = stateOf(key);
    if (!state || !state.sessionId) return false;

    try {
      await mqttApi.subscribe(state.sessionId, payload);
      state.error = '';
      return true;
    } catch (err) {
      state.error = err.message;
      return false;
    }
  }

  async function unsubscribe(key, topic) {
    const state = stateOf(key);
    if (!state || !state.sessionId) return false;

    try {
      await mqttApi.unsubscribe(state.sessionId, { topic: topic });
      state.error = '';
      return true;
    } catch (err) {
      state.error = err.message;
      return false;
    }
  }

  /** 发布一条消息：`{ topic, payload, qos, retain }` */
  async function publish(key, payload) {
    const state = stateOf(key);
    if (!state || !state.sessionId) return false;

    try {
      await mqttApi.publish(state.sessionId, payload);
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
        await mqttApi.destroySession(id);
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
   * 标签页 key 变了的时候，把会话状态整体搬到新 key 下（同 stores/sio.js）。
   *
   * 临时 MQTT 标签页「保存到目录」之后 key 会从 `mqtt:N` 变成 `api:<id>`：
   * 不搬的话刚连上的会话、订阅状态、消息日志全留在旧 key 上。
   */
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

  /** 标签页被关掉 / 切项目时调用：不保留任何东西 */
  function closeFor(key) {
    const state = stateOf(key);
    stop(key);
    attempts.delete(key);

    if (state && state.sessionId) {
      const id = state.sessionId;
      state.sessionId = '';
      mqttApi.destroySession(id).catch(function () { /* 已经没了就算了 */ });
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
    subscribe: subscribe,
    unsubscribe: unsubscribe,
    publish: publish,
    disconnect: disconnect,
    clearLog: clearLog,
    move: move,
    closeFor: closeFor,
    closeAll: closeAll
  };
});
