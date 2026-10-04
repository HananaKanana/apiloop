import { defineStore } from 'pinia';
import * as apisApi from '@/api/apis';
import * as loadApi from '@/api/load';
import { specFromApi, useTabsStore } from '@/stores/tabs';
import { useProjectStore } from '@/stores/project';
import { useEnvStore } from '@/stores/env';
import { mockBaseFor } from '@/utils/mock';
import { emptyLive, loadPayload, tickPoint } from '@/utils/load';

/**
 * 简单压测（第八轮第 2 节）。
 *
 * **跑的那一段必须活在 store 里，不能活在组件里**：运行中切到别的标签页，工作台会把
 * 正文组件卸载掉（标签页正文是按 kind 渲染的），跑的逻辑要是在组件里，一卸载就断了。
 * 状态挂在 `tab.load` 上，组件只是它的一个视图。
 *
 * 两件事在**开始那一刻**定下来，之后改什么都不影响正在跑的这一次：
 * - **请求内容**：优先用那个接口标签页里编辑中的内容（没保存的修改也算），
 *   接口标签页没开着就现拉一份详情 —— 拍下来之后整轮都用这一份；
 * - **环境**：`envId` 是 `undefined` 时取「当前环境」，取了就定住。
 */
export const useLoadStore = defineStore('load', function () {
  const projects = useProjectStore();
  const envs = useEnvStore();
  const tabs = useTabsStore();

  /** 这个接口在标签页里编辑中的 spec（没保存的修改也在里面），没有再回库里拉一份 */
  async function requestSnapshot(apiId) {
    const open = tabs.tabs.find(function (tab) {
      return tab.apiId === apiId && (tab.kind === 'api' || tab.kind === 'ws');
    });
    if (open && open.spec) return JSON.parse(JSON.stringify(open.spec));

    const data = await apisApi.getApi(apiId);
    return specFromApi(data.api);
  }

  function applyEvent(state, event) {
    if (!event || !event.type) return;

    if (event.type === 'start') {
      state.missingVariables = event.missingVariables || [];
      return;
    }

    if (event.type === 'tick') {
      state.live = {
        sent: event.sent || 0,
        ok: event.ok || 0,
        failed: event.failed || 0,
        active: event.active || 0,
        qps: event.qps || 0,
        avgMs: event.avgMs || 0,
        p95Ms: event.p95Ms || 0,
        elapsedMs: event.elapsedMs || 0
      };
      state.ticks.push(tickPoint(event));
      return;
    }

    if (event.type === 'done') {
      state.summary = event.summary || null;
      state.status = event.status || '';
      if (event.warning) state.error = event.warning;
    }
  }

  /**
   * 开始压测。参数（并发数之类）从 `tab.load.settings` 里取，界面上的输入框直接绑它。
   */
  async function start(tab) {
    const state = tab && tab.load;
    if (!state || state.running) return;

    const pid = projects.currentId;
    if (!pid) {
      state.error = '还没有选中项目';
      return;
    }

    const checked = loadPayload(state.settings);
    if (checked.error) {
      state.error = checked.error;
      return;
    }

    const environmentId = state.envId === undefined ? envs.selectedId : state.envId;

    state.running = true;
    state.status = '';
    state.error = '';
    state.missingVariables = [];
    state.live = emptyLive();
    state.ticks = [];
    // 上一次的汇总留在下面「上次结果」里对齐
    state.previous = state.summary;
    state.summary = null;
    state.startedAt = Date.now();
    state.finishedAt = 0;

    const controller = new AbortController();
    state.controller = controller;
    // 停止时要知道往哪个项目发（跑的时候用户可能已经切了项目）
    state.pid = pid;

    try {
      const request = await requestSnapshot(tab.apiId);
      state.request = request;

      await loadApi.startLoad(pid, {
        request: request,
        apiId: tab.apiId || undefined,
        environmentId: environmentId || undefined,
        // 选中内置 Mock 环境时才带：地址只有页面知道（见 utils/mock.js）
        mockBase: mockBaseFor(environmentId, projects.current),
        load: checked.value
      }, {
        signal: controller.signal,
        onEvent: function (event) { applyEvent(state, event); }
      });
    } catch (err) {
      if (err && err.aborted) {
        state.status = 'stopped';
      } else {
        state.error = (err && err.message) || '压测失败';
      }
    } finally {
      state.running = false;
      state.controller = null;
      state.finishedAt = Date.now();
      if (!state.status) state.status = 'finished';
    }
  }

  /**
   * 停止：在途的全部取消，后面不再发。**已经跑完的统计留着** ——
   * 用户要看的正是「跑到哪儿停的」。服务端会把这一轮记成 `stopped`。
   */
  function stop(tab) {
    const state = tab && tab.load;
    if (!state || !state.controller) return;

    const controller = state.controller;
    /**
     * 先请服务端停：它收尾后照常发 `done`，汇总表才出得来。服务端没响应、或者
     * 5 秒内流还没结束（网关卡住了之类），再直接断开兜底 —— 不能让「停止」按了没反应。
     */
    function hardStop() {
      if (state.controller === controller) controller.abort();
    }
    loadApi.stopLoad(state.pid || projects.currentId).catch(hardStop);
    setTimeout(hardStop, 5000);
  }

  return {
    start: start,
    stop: stop
  };
});
