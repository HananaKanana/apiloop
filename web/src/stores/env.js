import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as envsApi from '@/api/envs';

/**
 * 环境列表 + 当前选中的环境。
 * 「当前选中哪个环境」是每个项目各自的界面状态，服务端不存，所以按项目分别记在
 * localStorage 的 apiloop.env.<pid> 里。空串表示「无环境」。
 */
export const useEnvStore = defineStore('env', function () {
  const environments = ref([]);
  const selectedId = ref('');
  const projectId = ref('');

  const selected = computed(function () {
    return environments.value.find(function (item) { return item.id === selectedId.value; }) || null;
  });

  function storageKey(pid) {
    return 'apiloop.env.' + pid;
  }

  function select(id) {
    selectedId.value = id || '';
    if (projectId.value) {
      if (id) localStorage.setItem(storageKey(projectId.value), id);
      else localStorage.removeItem(storageKey(projectId.value));
    }
  }

  async function load(pid) {
    projectId.value = pid || '';
    if (!pid) {
      environments.value = [];
      selectedId.value = '';
      return [];
    }

    const data = await envsApi.listEnvironments(pid);
    environments.value = data.environments || [];

    // 存的环境可能已经被删了，那就退回「无环境」
    const saved = localStorage.getItem(storageKey(pid)) || '';
    const exists = environments.value.some(function (item) { return item.id === saved; });
    selectedId.value = exists ? saved : '';
    return environments.value;
  }

  async function create(payload) {
    const data = await envsApi.createEnvironment(projectId.value, payload);
    await load(projectId.value);
    return data.environment;
  }

  async function update(id, patch) {
    const data = await envsApi.updateEnvironment(id, patch);
    const index = environments.value.findIndex(function (item) { return item.id === id; });
    if (index !== -1) environments.value[index] = data.environment;
    return data.environment;
  }

  async function remove(id) {
    await envsApi.removeEnvironment(id);
    if (selectedId.value === id) selectedId.value = '';
    await load(projectId.value);
  }

  return {
    environments: environments,
    selectedId: selectedId,
    selected: selected,
    projectId: projectId,
    load: load,
    select: select,
    create: create,
    update: update,
    remove: remove
  };
});
