import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as amqpApi from '@/api/amqp';
import { getNdjson } from '@/api/stream';
import { t } from '@/i18n';

/**
 * RabbitMQ 调试会话的运行时状态（第十六轮 T41）。
 *
 * 和 `stores/mqtt.js` 是同一套结构（状态按**标签页 key** 存放，切标签页不丢连接和日志），
 * 差别在「会话里在发生什么」：那边是「连接 / 订阅 / 发布 / 收消息」，这里是
 * 「连接 / 起停 consumer / 回确认 / 发布 / 收消息」，事件类型见 `lib/amqp-sessions.js` 的 `push`。
 *
 * 后端事件（每条都带 `seq` 和 `time`）：
 * - `connecting { url }`（地址里的密码已经被服务端遮成 `******`）
 * - `connected { server }`（`server.product` / `server.version`，就是 broker 的版本）
 * - `consuming { consumerTag, mode, queue, exchange?, routingKey?, resumed? }`
 * - `cancelled { consumerTag, byServer, reason?, queue? }`
 * - `message { consumerTag, deliveryTag, exchange, routingKey, redelivered, properties,
 *    payload?, payloadBase64?, size, truncated, pendingAck?, at }`
 * - `published { exchange, routingKey, size, at }`（confirm channel，broker 确认之后才有）
 * - `returned { exchange, routingKey, replyText }`（mandatory 的消息路由不到任何队列）
 * - `acked { deliveryTag, action: 'ack'|'nack'|'reject', requeue }`
 * - `closed { reason? }` / `error { error }`
 *
 * 三处和 MQTT 不同、容易写错的地方：
 * - **`closed` 有两种**：有 `reason` 的是 **channel** 被关（连接还在，不能把状态降成「已断开」），
 *   没有 `reason` 的才是连接真的断了；
 * - 出错事件里的字段叫 **`error`**；`closed` 是正常事件，出错只认 `error` 事件；
 * - 一个会话有**多个** consumer，`consumers` 这张表按 `consumerTag` 记，取消 / 被 broker
 *   取消（队列被删）时都要把对应那一项删掉 —— 界面上「这一行是不是在消费中」靠它算。
 */

/** 界面上最多保留多少条，超出丢最旧的 */
const MAX_EVENTS = 2000;

/** events 连接意外断开后的重连间隔；用完就一直用最后一个 */
const RETRY_DELAYS = [1000, 2000, 5000];

// 计时器、AbortController、重试次数不放进 reactive（同 stores/mqtt.js）
const timers = new Map();
const readers = new Map();
const attempts = new Map();

export const useAmqpStore = defineStore('amqp', function () {
  /** tabKey -> 会话状态 */
  const sessions = ref({});

  function ensure(key) {
    if (!sessions.value[key]) {
      sessions.value[key] = {
        // 闭包一律读 state.key：标签页「保存到目录」之后 key 会从 `amqp:N` 变成 `api:<id>`
        key: key,
        // idle / connecting / open / closed / error / ended
        status: 'idle',
        // events 长连接自己的状态：live / retrying / ended
        channel: 'idle',
        sessionId: '',
        url: '',
        note: '',
        error: '',
        events: [],
        dropped: 0,
        lastSeq: 0,
        /** broker 的 `connection.serverProperties`（`connected` 事件给）：界面上显示版本 */
        server: null,
        /**
         * consumerTag -> `{ consumerTag, mode, queue, exchange, routingKey }`。
         * 界面上「这一行在不在消费中」靠它算；`cancelled` 时删掉对应那一项。
         */
        consumers: {}
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
      state.note = event.note || '';
      return;
    }
    if (event.type === 'connected') {
      state.status = 'open';
      state.server = event.server || null;
      attempts.delete(state.key);
      return;
    }
    if (event.type === 'consuming') {
      state.consumers[event.consumerTag || ''] = {
        consumerTag: event.consumerTag || '',
        mode: event.mode === 'exchange' ? 'exchange' : 'queue',
        queue: event.queue || '',
        exchange: event.exchange || '',
        routingKey: event.routingKey || ''
      };
      return;
    }
    if (event.type === 'cancelled') {
      delete state.consumers[event.consumerTag || ''];
      return;
    }
    if (event.type === 'closed') {
      // 带 reason 的是 **channel** 被关（队列不存在、参数冲突之后的重建那一路）——
      // 连接还在，把状态降成「已断开」等于骗人
      if (event.reason) return;
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

    getNdjson(amqpApi.eventsPath(state.sessionId, state.lastSeq), {
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
   * `{ projectId, apiId?, environmentId?, url, username, password, heartbeat,
   *    connectTimeoutMs, tlsInsecure, consumers }`（见 `lib/api/amqp.js` 的 `prepareSession`）。
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
    state.sessionId = '';
    state.lastSeq = 0;
    state.events = [];
    state.dropped = 0;
    state.server = null;
    state.consumers = {};
    state.url = payload.url || '';

    // 没有先断开就直接重连：把上一个会话销毁掉，别在服务端留着
    if (previous) {
      amqpApi.destroySession(previous).catch(function () { /* 已经没了就算了 */ });
    }

    let data;
    try {
      data = await amqpApi.createSession(payload.projectId, {
        apiId: payload.apiId || undefined,
        environmentId: payload.environmentId || undefined,
        url: payload.url,
        username: payload.username,
        password: payload.password,
        heartbeat: payload.heartbeat,
        connectTimeoutMs: payload.connectTimeoutMs,
        tlsInsecure: payload.tlsInsecure,
        consumers: payload.consumers
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

  /** 运行中开一个 consumer：`{ mode, queue, exchange, routingKey, ack, prefetch }` */
  async function consume(key, spec) {
    const state = stateOf(key);
    if (!state || !state.sessionId) return false;

    try {
      await amqpApi.consume(state.sessionId, spec);
      state.error = '';
      return true;
    } catch (err) {
      state.error = err.message;
      return false;
    }
  }

  /** 取消一个 consumer（consumerTag 从 `consuming` 事件里来，见 state.consumers） */
  async function cancel(key, consumerTag) {
    const state = stateOf(key);
    if (!state || !state.sessionId) return false;

    try {
      await amqpApi.cancel(state.sessionId, { consumerTag: consumerTag });
      state.error = '';
      return true;
    } catch (err) {
      state.error = err.message;
      return false;
    }
  }

  /** 回确认：`{ deliveryTag, action, requeue }` */
  async function ack(key, payload) {
    const state = stateOf(key);
    if (!state || !state.sessionId) return false;

    try {
      await amqpApi.ack(state.sessionId, payload);
      state.error = '';
      return true;
    } catch (err) {
      state.error = err.message;
      return false;
    }
  }

  /** 发布一条消息：`{ exchange, routingKey, payload, properties, mandatory }` */
  async function publish(key, payload) {
    const state = stateOf(key);
    if (!state || !state.sessionId) return false;

    try {
      await amqpApi.publish(state.sessionId, payload);
      state.error = '';
      return true;
    } catch (err) {
      state.error = err.message;
      return false;
    }
  }

  /**
   * 查一个队列的堆积情况。**要拿返回值**（不是像别的动作那样只看成没成），
   * 所以返回 `{ ok, messageCount, consumerCount }` / `{ ok: false, error }`。
   */
  async function queueInfo(key, queue) {
    const state = stateOf(key);
    if (!state || !state.sessionId) return { ok: false, error: t('amqp.notConnected') };

    try {
      const data = await amqpApi.queueInfo(state.sessionId, { queue: queue });
      state.error = '';
      return {
        ok: true,
        messageCount: (data && data.messageCount) || 0,
        consumerCount: (data && data.consumerCount) || 0
      };
    } catch (err) {
      state.error = err.message;
      return { ok: false, error: err.message };
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
    state.consumers = {};
    pushLocal(state, t('amqp.disconnected'));

    if (id) {
      try {
        await amqpApi.destroySession(id);
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
   * 标签页 key 变了的时候，把会话状态整体搬到新 key 下（同 stores/mqtt.js）。
   *
   * 临时标签页「保存到目录」之后 key 会从 `amqp:N` 变成 `api:<id>`：
   * 不搬的话刚连上的会话、consumer 状态、消息日志全留在旧 key 上。
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
      amqpApi.destroySession(id).catch(function () { /* 已经没了就算了 */ });
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
    consume: consume,
    cancel: cancel,
    ack: ack,
    publish: publish,
    queueInfo: queueInfo,
    disconnect: disconnect,
    clearLog: clearLog,
    move: move,
    closeFor: closeFor,
    closeAll: closeAll
  };
});
