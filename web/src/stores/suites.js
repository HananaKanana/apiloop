import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as suitesApi from '@/api/suites';

/**
 * 测试集列表（第八轮第 1 节）。
 *
 * 侧栏「测试集」那一栏和测试集标签页都读它 —— 新建 / 删除 / 改名之后大家都要跟着变，
 * 所以放在 store 里，不各自拉一份。
 */
export const useSuitesStore = defineStore('suites', function () {
  const suites = ref([]);
  const loading = ref(false);
  /** 当前这份列表属于哪个项目（切项目时用来判断要不要重新拉） */
  const projectId = ref('');

  async function load(pid) {
    if (!pid) {
      suites.value = [];
      projectId.value = '';
      return [];
    }

    loading.value = true;
    try {
      const data = await suitesApi.listSuites(pid);
      suites.value = data.suites || [];
      projectId.value = pid;
      return suites.value;
    } finally {
      loading.value = false;
    }
  }

  /** 切项目时调：项目不一样就重新拉 */
  function ensure(pid) {
    if (!pid) {
      suites.value = [];
      projectId.value = '';
      return Promise.resolve([]);
    }
    if (projectId.value === pid && suites.value.length) return Promise.resolve(suites.value);
    return load(pid);
  }

  function byId(id) {
    return suites.value.find(function (item) { return item.id === id; }) || null;
  }

  /** 新建 / 改名 / 删除之后把这一份列表刷新（服务端返回的是单个对象，就地替换更快） */
  function put(suite) {
    if (!suite) return;

    const at = suites.value.findIndex(function (item) { return item.id === suite.id; });
    if (at === -1) suites.value = suites.value.concat([suite]);
    else suites.value.splice(at, 1, suite);
  }

  function drop(id) {
    suites.value = suites.value.filter(function (item) { return item.id !== id; });
  }

  return {
    suites: suites,
    loading: loading,
    projectId: projectId,
    load: load,
    ensure: ensure,
    byId: byId,
    put: put,
    drop: drop
  };
});
