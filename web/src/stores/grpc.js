import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import * as grpcApi from '@/api/grpc';
import { t } from '@/i18n';

/**
 * gRPC 调用的运行时状态（第十一轮第 3 节）。
 *
 * 和 `stores/sio.js` 一样：状态按**标签页 key** 存（组件会随标签页切换被卸载重建，
 * 状态放在组件里等于一切走就丢）。但两者结构不一样 —— Socket.IO 是「先建会话、
 * 再开一条长连接收事件」，gRPC 是「一次调用 = 一次 POST + 一串 NDJSON 事件」，
 * 所以这里没有 sessionId，只有一个 abort 用的 controller。
 *
 * 服务端**一定会**在断开前给一行 `end` 或 `error`，所以「跑完了没有」看的是
 * `phase`，不是事件流关没关。
 */

const MAX_MESSAGES = 2000;

export const useGrpcStore = defineStore('grpc', function () {
  /** tabKey -> 调用状态 */
  const sessions = ref({});
  /** 取消函数按 key 放（AbortController 不该进响应式，包一层也没有意义） */
  const controllers = shallowRef(new Map());

  function ensure(key) {
    if (!sessions.value[key]) {
      sessions.value[key] = {
        // 闭包一律读 state.key：标签页保存到目录之后 key 会从 `grpc:N` 变成 `api:<id>`
        key: key,
        /** idle（还没调过）/ running / done / error / cancelled */
        phase: 'idle',
        /** 这次生效的目标地址（服务端 start 事件里给的） */
        target: '',
        tls: false,
        note: '',
        /** start.missing：没替换掉的变量名 */
        missing: [],
        /** 收到的响应消息，服务端流会有很多条 */
        messages: [],
        dropped: 0,
        /** 握手的 metadata（服务端发回来的那一份） */
        metadata: null,
        /** end 事件：`{ code, name, details }` */
        status: null,
        trailers: null,
        durationMs: null,
        /** 断言结果和提取到的变量（第十二轮第 1 节），跟着 end 那一行回来 */
        tests: [],
        extracted: [],
        /** 中文错误说明（error 行，或者本机这边出的错） */
        error: ''
      };
    }
    return sessions.value[key];
  }

  function stateOf(key) {
    return sessions.value[key] || null;
  }

  function reset(state) {
    state.phase = 'running';
    state.target = '';
    state.tls = false;
    state.note = '';
    state.missing = [];
    state.messages = [];
    state.dropped = 0;
    state.metadata = null;
    state.status = null;
    state.trailers = null;
    state.durationMs = null;
    state.tests = [];
    state.extracted = [];
    state.error = '';
  }

  function pushMessage(state, data, at) {
    state.messages.push({ data: data, at: at || Date.now() });

    const overflow = state.messages.length - MAX_MESSAGES;
    if (overflow > 0) {
      state.messages.splice(0, overflow);
      state.dropped += overflow;
    }
  }

  function handleEvent(state, event) {
    if (!event || !event.type) return;

    if (event.type === 'start') {
      state.target = event.target || '';
      state.tls = event.tls === true;
      state.note = event.note || '';
      state.missing = Array.isArray(event.missing) ? event.missing.slice() : [];
      return;
    }
    if (event.type === 'metadata') {
      state.metadata = event.metadata || null;
      return;
    }
    if (event.type === 'message') {
      pushMessage(state, event.data, event.at);
      return;
    }
    if (event.type === 'end') {
      state.status = event.status || null;
      state.trailers = event.trailers || null;
      state.durationMs = typeof event.durationMs === 'number' ? event.durationMs : null;
      // 断言和提取变量（第十二轮第 1 节）：跟在 end 那一行里
      state.tests = Array.isArray(event.tests) ? event.tests : [];
      state.extracted = Array.isArray(event.extracted) ? event.extracted : [];
      state.phase = (state.status && state.status.code === 0) ? 'done' : 'error';
      return;
    }
    if (event.type === 'error') {
      state.error = String(event.error || t('stores.grpcCallFailed'));
      state.phase = 'error';
    }
  }

  /**
   * 发起一次调用。返回是否真的发出去了（建连之前就失败时 phase 是 error）。
   *
   * @param {string} key 标签页 key
   * @param {object} payload `{ projectId, body }`
   */
  async function run(key, payload) {
    cancel(key);

    const state = ensure(key);
    reset(state);

    const controller = new AbortController();
    controllers.value.set(key, controller);

    // 闭包读 state.key：调用还在路上时用户点了「保存」，key 会变成 api:<id>
    const owner = controller;

    try {
      const result = await grpcApi.call(payload.projectId, payload.body, {
        signal: controller.signal,
        onEvent: function (event) { handleEvent(state, event); }
      });
      void result;
    } catch (err) {
      if (err && err.aborted) {
        // 用户在界面上点了「取消」：这不算错
        state.phase = 'cancelled';
      } else {
        state.error = (err && err.message) || t('stores.grpcCallFailed');
        state.phase = 'error';
      }
    } finally {
      if (controllers.value.get(key) === owner) controllers.value.delete(key);
      // 事件流断了但一条 end / error 都没收到（服务端进程没了、连接被掐）：
      // 别让界面一直停在「调用中」
      if (state.phase === 'running') {
        state.error = state.error || t('stores.grpcNoResult');
        state.phase = 'error';
      }
    }

    return state;
  }

  /** 取消这次调用：前端断开连接，服务端看到断开后会 call.cancel() */
  function cancel(key) {
    const controller = controllers.value.get(key);
    if (!controller) return false;
    controllers.value.delete(key);
    controller.abort();
    return true;
  }

  /** 清掉这次调用的结果（换接口 / 重新调之前） */
  function clear(key) {
    const state = stateOf(key);
    if (!state) return;
    reset(state);
    state.phase = 'idle';
  }

  /** 标签页 key 变了的时候把状态整体搬到新 key 下（同 stores/sio.js） */
  function move(fromKey, toKey) {
    if (!fromKey || !toKey || fromKey === toKey) return;

    const state = sessions.value[fromKey];
    if (state) {
      sessions.value[toKey] = state;
      delete sessions.value[fromKey];
      state.key = toKey;
    }

    if (controllers.value.has(fromKey)) {
      controllers.value.set(toKey, controllers.value.get(fromKey));
      controllers.value.delete(fromKey);
    }

    // 流式会话的状态和读事件的那条连接也跟着搬
    const stream = streams.value[fromKey];
    if (stream) {
      streams.value[toKey] = stream;
      delete streams.value[fromKey];
      stream.key = toKey;
    }
    if (streamReaders.value.has(fromKey)) {
      streamReaders.value.set(toKey, streamReaders.value.get(fromKey));
      streamReaders.value.delete(fromKey);
    }
  }

  /** 关标签页：在途的调用直接取消（服务端那边跟着 call.cancel()） */
  function closeFor(key) {
    cancel(key);
    closeStreamFor(key);
    delete sessions.value[key];
  }

  function closeAll() {
    Object.keys(sessions.value).forEach(closeFor);
    Object.keys(streams.value).forEach(closeStreamFor);
  }

  /* ================================================================
   * 客户端流 / 双向流（第十二轮第 2 节）：这块是**会话**，不是一次调用
   *
   * 和上面那套的区别：连接一直开着，可以逐条发、随时结束发送（half-close），
   * 服务端还能继续回消息。所以状态里有一个 id、一条按 seq 补发的事件流，
   * 以及一个「发出 / 收到 / 系统提示」混在一起的消息列表（照 Socket.IO 那个体验）。
   * ================================================================ */

  /** tabKey -> 流式会话状态 */
  const streams = ref({});
  const streamReaders = shallowRef(new Map());
  const streamAttempts = new Map();
  const streamTimers = new Map();

  const STREAM_RETRY_DELAYS = [1000, 2000, 5000];

  function ensureStream(key) {
    if (!streams.value[key]) {
      streams.value[key] = {
        key: key,
        id: '',
        /** idle / connecting / open / closed / error */
        phase: 'idle',
        target: '',
        tls: false,
        note: '',
        missing: [],
        /** 消息列表：{ id, kind: 'system' | 'sent' | 'received', text, data, at } */
        entries: [],
        dropped: 0,
        /** 结束发送（half-close）之后不让再发了 */
        halfClosed: false,
        status: null,
        trailers: null,
        tests: [],
        extracted: [],
        durationMs: null,
        error: '',
        lastSeq: 0
      };
    }
    return streams.value[key];
  }

  function streamOf(key) {
    return streams.value[key] || null;
  }

  let entrySeq = 0;

  function pushEntry(state, entry) {
    entrySeq += 1;
    state.entries.push(Object.assign({ id: entrySeq, at: Date.now() }, entry));

    const overflow = state.entries.length - MAX_MESSAGES;
    if (overflow > 0) {
      state.entries.splice(0, overflow);
      state.dropped += overflow;
    }
  }

  function handleStreamEvent(state, event) {
    if (!event || !event.type) return;

    if (event.type === 'start') {
      state.target = event.target || '';
      state.tls = event.tls === true;
      state.note = event.note || '';
      state.missing = Array.isArray(event.missing) ? event.missing.slice() : [];
      state.phase = 'open';
      pushEntry(state, {
        kind: 'system',
        text: t('stores.grpcConnected', { target: state.target }) + (state.tls ? t('stores.grpcTls') : '') +
          (state.missing.length ? t('stores.grpcMissing', { list: state.missing.join('、') }) : '')
      });
      return;
    }
    if (event.type === 'metadata') {
      state.metadata = event.metadata || null;
      pushEntry(state, { kind: 'system', text: t('stores.grpcMetadata') });
      return;
    }
    if (event.type === 'sent') {
      pushEntry(state, { kind: 'sent', data: event.data, at: event.at || Date.now() });
      return;
    }
    if (event.type === 'message') {
      pushEntry(state, { kind: 'received', data: event.data, at: event.at || Date.now() });
      return;
    }
    if (event.type === 'end') {
      state.status = event.status || null;
      state.trailers = event.trailers || null;
      state.durationMs = typeof event.durationMs === 'number' ? event.durationMs : null;
      state.tests = Array.isArray(event.tests) ? event.tests : [];
      state.extracted = Array.isArray(event.extracted) ? event.extracted : [];
      state.phase = (state.status && state.status.code === 0) ? 'closed' : 'error';
      pushEntry(state, {
        kind: 'system',
        text: t('stores.grpcCallEnd', { status: (state.status && state.status.name) || t('stores.grpcUnknownStatus') }) +
          (state.status && state.status.details ? t('stores.grpcDetails', { details: state.status.details }) : '') +
          (state.durationMs === null ? '' : t('stores.grpcDuration', { ms: state.durationMs })) +
          (state.tests.length ? t('stores.grpcTests', { passed: state.tests.filter(function (item) { return item.passed; }).length, total: state.tests.length }) : '') +
          (state.extracted.length ? t('stores.grpcExtracted', { n: state.extracted.length }) : '')
      });
      return;
    }
    if (event.type === 'error') {
      state.error = String(event.error || t('stores.grpcStreamFailed'));
      state.phase = 'error';
      pushEntry(state, { kind: 'system', text: state.error });
    }
  }

  function abortStreamReader(key) {
    const controller = streamReaders.value.get(key);
    if (controller) {
      streamReaders.value.delete(key);
      controller.abort();
    }
  }

  function clearStreamTimer(key) {
    const timer = streamTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      streamTimers.delete(key);
    }
  }

  /** 收事件。断了（不是我们主动取消的）就按退避重连，靠 after=lastSeq 补齐那一段 */
  async function readStreamEvents(key) {
    const state = streamOf(key);
    if (!state || !state.id) return;

    const controller = new AbortController();
    streamReaders.value.set(key, controller);

    try {
      await grpcApi.readStreamEvents(state.id, {
        after: state.lastSeq,
        signal: controller.signal,
        onEvent: function (event) {
          if (typeof event.seq === 'number') state.lastSeq = event.seq;
          handleStreamEvent(state, event);
        }
      });

      if (controller.signal.aborted) return;
      if (state.phase === 'open' || state.phase === 'connecting') {
        state.error = state.error || t('stores.grpcNoEndStatus');
        state.phase = 'error';
      }
    } catch (err) {
      if (err && err.aborted) return;
      if (controller.signal.aborted) return;

      const attempt = (streamAttempts.get(key) || 0);
      if (attempt < STREAM_RETRY_DELAYS.length) {
        streamAttempts.set(key, attempt + 1);
        clearStreamTimer(key);
        streamTimers.set(key, setTimeout(function () {
          streamTimers.delete(key);
          readStreamEvents(key);
        }, STREAM_RETRY_DELAYS[attempt]));
        return;
      }

      state.error = (err && err.message) || t('stores.grpcDisconnected');
      state.phase = 'error';
    } finally {
      if (streamReaders.value.get(key) === controller) streamReaders.value.delete(key);
    }
  }

  /** 建会话（连接 + 收事件） */
  async function openStream(key, payload) {
    cancelStream(key);

    const state = ensureStream(key);
    state.id = '';
    state.phase = 'connecting';
    state.target = '';
    state.tls = false;
    state.note = '';
    state.missing = [];
    state.entries = [];
    state.dropped = 0;
    state.halfClosed = false;
    state.status = null;
    state.trailers = null;
    state.tests = [];
    state.extracted = [];
    state.durationMs = null;
    state.error = '';
    state.lastSeq = 0;
    streamAttempts.set(key, 0);

    try {
      const data = await grpcApi.createStream(payload.projectId, payload.body);
      state.id = data.id || '';
      if (!state.id) throw new Error(t('stores.grpcNoSessionId'));
      readStreamEvents(key);
    } catch (err) {
      state.error = (err && err.message) || t('stores.grpcCreateFailed');
      state.phase = 'error';
    }

    return state;
  }

  /** 发一条消息（服务端会回一行 sent，界面不自己塞，免得重复） */
  async function sendStream(key, message) {
    const state = streamOf(key);
    if (!state || !state.id) return;
    await grpcApi.sendStreamMessage(state.id, message);
  }

  /** 结束发送（half-close）：之后还能继续收 */
  async function endStreamSend(key) {
    const state = streamOf(key);
    if (!state || !state.id || state.halfClosed) return;
    await grpcApi.endStream(state.id);
    state.halfClosed = true;
    pushEntry(state, { kind: 'system', text: t('stores.grpcHalfClosed') });
  }

  /** 取消 / 断开：删会话，服务端那边 call.cancel() */
  function cancelStream(key) {
    const state = streamOf(key);
    if (!state || !state.id) return false;

    clearStreamTimer(key);
    abortStreamReader(key);

    const id = state.id;
    state.id = '';
    if (state.phase === 'open' || state.phase === 'connecting') state.phase = 'closed';

    grpcApi.destroyStream(id).catch(function () { /* 会话可能已经没了 */ });
    return true;
  }

  /** 关标签页 / 切走：断掉会话 */
  function closeStreamFor(key) {
    cancelStream(key);
    clearStreamTimer(key);
    streamAttempts.delete(key);
    delete streams.value[key];
  }

  return {
    sessions: sessions,
    ensure: ensure,
    stateOf: stateOf,
    run: run,
    cancel: cancel,
    clear: clear,
    move: move,
    closeFor: closeFor,
    closeAll: closeAll,

    // 流式会话（客户端流 / 双向流）
    streams: streams,
    ensureStream: ensureStream,
    streamOf: streamOf,
    openStream: openStream,
    sendStream: sendStream,
    endStreamSend: endStreamSend,
    cancelStream: cancelStream,
    closeStreamFor: closeStreamFor
  };
});
