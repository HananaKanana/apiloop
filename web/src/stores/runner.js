import { defineStore } from 'pinia';
import * as apisApi from '@/api/apis';
import { request } from '@/api/client';
import { specFromApi, useTabsStore } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import { useEnvStore } from '@/stores/env';
import { useProjectStore } from '@/stores/project';
import { mockBaseFor } from '@/utils/mock';
import { collectApiNodes } from '@/utils/tree';
import { applyRunnerResult, runnerRow } from '@/utils/runner';

/**
 * 批量运行（第 2 节）。
 *
 * **跑的那一段必须活在 store 里，不能活在组件里**：运行中切到别的标签页，工作台会把
 * 「运行」组件卸载掉（标签页正文是按 kind 渲染的），跑的逻辑要是在组件里，一卸载就断了。
 * 状态挂在 `tab.runner` 上（见 `utils/runner.js` 的 emptyRunner），组件只是它的一个视图。
 *
 * 每个请求都走**非流式**的 `POST /projects/:pid/send`：批量跑不需要边收边显示，
 * 而且这里要的是「一次拿到完整结果」——断言和控制台输出都在 `result` 里。
 *
 * 变量在请求之间是通的：脚本 `pm.environment.set` 写回的值由服务端落库
 * （`record` 里的 `writeBackVariables`，它**不受 `skipHistory` 影响**），
 * 下一个请求读库时自然就拿到了。跑完再刷一次环境 store，让界面上的值跟上。
 */
export const useRunnerStore = defineStore('runner', function () {
  const tree = useTreeStore();
  const envs = useEnvStore();
  const projects = useProjectStore();
  const tabs = useTabsStore();

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /** 这个标签页要跑的接口（按目录树顺序，WebSocket 不在里面） */
  function targets(tab) {
    return collectApiNodes(tree.nodes, tab.folderId);
  }

  /** 勾上的那些（默认全选，`excluded` 记的是勾掉的） */
  function selected(tab) {
    const excluded = tab.runner.excluded || [];
    return targets(tab).filter(function (node) {
      return excluded.indexOf(node.id) === -1;
    });
  }

  /**
   * 跑一个接口：取详情 → 转成发送用的 spec（复用打开接口标签页那一份转换，
   * 不再抄一遍）→ 调 `/send`。
   *
   * 详情**按接口缓存**：次数设成 3 时同一个接口要跑 3 遍，没必要拉 3 次详情。
   * 拉失败的那一次不进缓存，下一遍还会重试。
   */
  async function runOne(pid, environmentId, node, row, runner, cache) {
    const controller = new AbortController();
    runner.controller = controller;

    try {
      let spec = cache.get(node.id);
      if (!spec) {
        const data = await apisApi.getApi(node.id);
        spec = specFromApi(data.api);
        cache.set(node.id, spec);
      }

      const res = await request(
        'POST',
        '/projects/' + encodeURIComponent(pid) + '/send',
        {
          request: spec,
          apiId: node.id,
          environmentId: environmentId || undefined,
          // 选中内置 Mock 环境时才带：地址只有页面知道（见 utils/mock.js）
          mockBase: mockBaseFor(environmentId, projects.current),
          options: {
            cookies: true,
            proxy: true,
            scripts: true,
            // 「记到历史里」默认不勾：一次几十个请求，全记下来会把历史刷满
            skipHistory: runner.recordHistory !== true
          }
        },
        { signal: controller.signal }
      );

      applyRunnerResult(row, res.result);
    } catch (err) {
      row.pending = false;
      if (err && err.aborted) {
        row.aborted = true;
        row.error = '已停止';
      } else {
        row.error = (err && err.message) || '请求失败';
        row.failed = true;
      }
    } finally {
      if (runner.controller === controller) runner.controller = null;
    }
  }

  /** 跑完把环境和项目变量重新拉一遍：脚本写回的值要让界面跟上 */
  async function refreshVariables(pid) {
    try {
      await envs.load(pid);
    } catch (err) {
      // 拉不到不影响这次运行的结果，下个周期自己会重试
    }
    try {
      await projects.refresh();
    } catch (err) {
      // 同上
    }
  }

  async function start(tab) {
    const runner = tab && tab.runner;
    if (!runner || runner.running) return;

    const list = selected(tab);
    if (!list.length) {
      runner.error = '没有勾选任何接口';
      return;
    }

    const pid = projects.currentId;
    // 环境在开跑时定下来：跑的过程中用户改了当前环境也不影响这一次
    const environmentId = runner.envId === undefined ? envs.selectedId : runner.envId;
    // 输入框里的值可能还没被 clamp 过（打完字直接点开始），这里再兜一次
    const repeat = Math.min(100, Math.max(1, Math.floor(Number(runner.repeat) || 1)));
    const intervalMs = Math.max(0, Math.floor(Number(runner.intervalMs) || 0));

    runner.running = true;
    runner.stopRequested = false;
    runner.error = '';
    runner.results = [];
    runner.startedAt = Date.now();
    runner.finishedAt = 0;
    runner.done = 0;
    runner.total = list.length * repeat;

    const specCache = new Map();

    try {
      for (let round = 1; round <= repeat; round++) {
        for (let index = 0; index < list.length; index++) {
          if (runner.stopRequested) break;
          // 标签页被关掉了就停：里面的状态已经没人看了（关的时候还会 abort 在途请求）
          if (tabs.tabs.indexOf(tab) === -1) {
            runner.stopRequested = true;
            break;
          }

          runner.results.push(runnerRow(round, list[index]));

          /**
           * **必须拿数组里那一份（响应式代理）来填结果**，不能拿着 push 进去的原始对象改。
           * `push` 存进去的是普通对象，`results[i]` 读出来才是被 `reactive()` 包过的代理；
           * 直接改原始对象绕过了代理的 setter，**不会触发更新** —— 界面上的「…」
           * 只能靠别的字段（done / push 本身）顺带刷出来，很容易变成一直停在「…」。
           */
          const row = runner.results[runner.results.length - 1];

          await runOne(pid, environmentId, list[index], row, runner, specCache);
          runner.done += 1;

          if (row.aborted) runner.stopRequested = true;
          if (runner.stopRequested) break;
          if (row.failed && runner.stopOnFail) {
            runner.stopRequested = true;
            break;
          }

          // 间隔只加在两次请求之间，最后一条后面不等
          const more = round < repeat || index < list.length - 1;
          if (more && intervalMs > 0) await sleep(intervalMs);
        }
      }
    } finally {
      runner.running = false;
      runner.stopRequested = false;
      runner.finishedAt = Date.now();
      runner.controller = null;
      await refreshVariables(pid);
    }
  }

  /**
   * 停止：中断正在跑的那个请求，后面的不再发。已经跑完的结果留着 ——
   * 用户要看的正是「跑到哪儿停的」。
   */
  function stop(tab) {
    const runner = tab && tab.runner;
    if (!runner) return;
    runner.stopRequested = true;
    if (runner.controller) runner.controller.abort();
  }

  return {
    targets: targets,
    selected: selected,
    start: start,
    stop: stop
  };
});
