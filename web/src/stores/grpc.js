import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import * as grpcApi from '@/api/grpc';

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
      state.phase = (state.status && state.status.code === 0) ? 'done' : 'error';
      return;
    }
    if (event.type === 'error') {
      state.error = String(event.error || '调用失败');
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
        state.error = (err && err.message) || '调用失败';
        state.phase = 'error';
      }
    } finally {
      if (controllers.value.get(key) === owner) controllers.value.delete(key);
      // 事件流断了但一条 end / error 都没收到（服务端进程没了、连接被掐）：
      // 别让界面一直停在「调用中」
      if (state.phase === 'running') {
        state.error = state.error || '连接中断了，没有收到调用结果';
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
  }

  /** 关标签页：在途的调用直接取消（服务端那边跟着 call.cancel()） */
  function closeFor(key) {
    cancel(key);
    delete sessions.value[key];
  }

  function closeAll() {
    Object.keys(sessions.value).forEach(closeFor);
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
    closeAll: closeAll
  };
});
