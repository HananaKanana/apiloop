import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { postNdjson } from '@/api/stream';
import { stopSuite } from '@/api/suites';
import { t } from '@/i18n';

/**
 * 测试集运行的状态（第八轮第 1 节）。
 *
 * **放在 store 里而不是组件里**：切标签页时组件会被卸载，运行不能跟着断
 * （和 `stores/runner.js` 一个道理）。一个测试集一份，按 suiteId 存。
 *
 * 服务端推 NDJSON：`start`（轮数 / 步骤数）→ 每步一条 `step` → 一条 `done`。
 */
export const useSuiteRunStore = defineStore('suiteRun', function () {
  /** suiteId → 这次运行的进度 */
  const states = ref({});
  /** suiteId → AbortController（停止用；不进 state，它不是要渲染的数据） */
  const controllers = {};

  function stateOf(suiteId) {
    if (!states.value[suiteId]) {
      states.value[suiteId] = {
        phase: 'idle',        // idle | running | done | error
        runId: '',
        iterations: 0,
        stepCount: 0,
        /** 每步的结果（服务端那条 step 事件原样留着，多带 iteration / index） */
        steps: [],
        summary: null,
        /** `done` 事件带回来的整份结果（停止后断开兜底时没有，报告退回用 steps 拼） */
        result: null,
        status: '',           // passed | failed | stopped | error
        saved: false,
        warning: '',
        error: '',
        startedAt: 0,
        finishedAt: 0
      };
    }
    return states.value[suiteId];
  }

  /**
   * 跑一次。
   *
   * @param {string} suiteId
   * @param {{environmentId?: string, mockBase?: string}} payload
   */
  function start(suiteId, payload) {
    const state = stateOf(suiteId);
    if (state.phase === 'running') return Promise.resolve();

    Object.assign(state, {
      phase: 'running',
      runId: '',
      iterations: 0,
      stepCount: 0,
      steps: [],
      summary: null,
      result: null,
      status: '',
      saved: false,
      warning: '',
      error: '',
      startedAt: Date.now(),
      finishedAt: 0
    });

    const controller = new AbortController();
    controllers[suiteId] = controller;

    return postNdjson('/suites/' + encodeURIComponent(suiteId) + '/run', payload || {}, {
      signal: controller.signal,
      onEvent: function (event) {
        if (!event || !event.type) return;

        if (event.type === 'start') {
          state.iterations = Number(event.iterations) || 0;
          state.stepCount = Number(event.steps) || 0;
          state.runId = event.runId || '';
          return;
        }

        if (event.type === 'step') {
          state.steps = state.steps.concat([event]);
          return;
        }

        if (event.type === 'done') {
          state.status = event.status || '';
          state.summary = event.summary || null;
          // 整份结果（服务端裁过）：报告直接用它，每一轮的数据行也在里面
          state.result = event.result || null;
          state.saved = event.saved === true;
          state.warning = event.warning || '';
          state.phase = 'done';
          state.finishedAt = Date.now();
        }
      }
    }).then(function () {
      // 流正常结束但没收到 done（连接被中间层掐了之类）：别一直转圈
      if (state.phase === 'running') {
        state.phase = 'done';
        state.status = state.status || 'stopped';
        state.finishedAt = Date.now();
      }
    }).catch(function (err) {
      state.finishedAt = Date.now();

      if (err && err.aborted) {
        // 用户点了「停止」：不是错误，状态记 stopped
        state.phase = 'done';
        state.status = 'stopped';
        return;
      }
      state.phase = 'error';
      state.error = (err && err.message) || t('stores.suiteRunFailed');
    }).then(function () {
      delete controllers[suiteId];
    });
  }

  /**
   * 停止。先请服务端停：它收尾、存记录后照常发 `done`，界面才知道记录存没存上。
   * 服务端没响应、或者 5 秒内流还没结束，再直接断开兜底。
   */
  function stop(suiteId) {
    const controller = controllers[suiteId];
    if (!controller) return;

    function hardStop() {
      if (controllers[suiteId] === controller) controller.abort();
    }
    stopSuite(suiteId).catch(hardStop);
    setTimeout(hardStop, 5000);
  }

  function clear(suiteId) {
    if (controllers[suiteId]) controllers[suiteId].abort();
    delete controllers[suiteId];
    delete states.value[suiteId];
  }

  function isRunning(suiteId) {
    return stateOf(suiteId).phase === 'running';
  }

  /**
   * 侧栏那一行的小圆点：绿 / 红 / 灰。
   * 只在这次会话里跑过才有点 —— 历史记录在云端，侧栏不为它多拉一遍接口。
   */
  const lastStatus = computed(function () {
    return function (suiteId) {
      const state = states.value[suiteId];
      if (!state || state.phase === 'idle') return '';
      if (state.phase === 'running') return 'running';
      if (state.phase === 'error') return 'failed';
      return state.status || '';
    };
  });

  return {
    states: states,
    stateOf: stateOf,
    start: start,
    stop: stop,
    clear: clear,
    isRunning: isRunning,
    lastStatus: lastStatus
  };
});
