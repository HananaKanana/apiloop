import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as envsApi from '@/api/envs';
import { useProjectStore } from '@/stores/project';
import { useGatewayStore } from '@/stores/gateway';
import { MOCK_ENV_ID, MOCK_VARIABLE, mockBaseUrl } from '@/utils/mock';

/** 内置的 Mock 环境。定义在 utils/mock.js，这里转出去给界面用 */
export { MOCK_ENV_ID };

/**
 * 环境列表 + 当前选中的环境。
 * 「当前选中哪个环境」是每个项目各自的界面状态，服务端不存，所以按项目分别记在
 * localStorage 的 apiloop.env.<pid> 里。空串表示「无环境」。
 *
 * 下拉里除了「无环境」和真实环境，还固定有一项**内置的 Mock 环境**：选中后变量 `host`
 * 等于这个项目的 mock 地址，请求地址写成 `{{host}}/路径` 就直接打到 mock 上。
 * 它不在 `environments` 列表里（不存库），只在 `selected` 上临时拼出来。
 */
export const useEnvStore = defineStore('env', function () {
  const environments = ref([]);
  const selectedId = ref('');
  const projectId = ref('');

  /**
   * 环境编辑区（侧栏切到「环境」时右边那一块）正在编辑哪个环境。
   * 环境不再占请求标签页（用户 2026-09-30：环境和接口不要混在一排）。
   */
  const editingId = ref('');

  /**
   * 每个环境各自的未保存草稿：`{ [envId]: { name, variables } }`。
   * 放在 store 里而不是编辑组件里，这样切回目录、换一个环境再回来，改了一半的内容都还在。
   * 切项目时清空；删掉环境时删掉它那份。
   */
  const drafts = ref({});

  /**
   * 内置 Mock 环境：只有 `host` 一个变量，值是当前项目的 mock 地址。
   *
   * 临时拼出来而不是从 `environments` 里找 —— 它不存库，值还要跟着云端地址走。
   * 变量高亮、悬停看值、缺失变量提示都读 `selected`，所以拼在这里它们自动就对。
   */
  function mockEnvironment() {
    return {
      id: MOCK_ENV_ID,
      name: 'Mock',
      builtin: true,
      variables: [
        { key: MOCK_VARIABLE, value: mockBaseUrl(useProjectStore().current), enabled: true }
      ]
    };
  }

  const selected = computed(function () {
    if (selectedId.value === MOCK_ENV_ID) return mockEnvironment();
    return environments.value.find(function (item) { return item.id === selectedId.value; }) || null;
  });

  /**
   * 编辑区实际显示的环境：点过哪个就是哪个，否则退到当前环境，再否则第一个。
   * **内置的 Mock 环境不能编辑**（它不在库里），所以不当退路。
   */
  const editing = computed(function () {
    const list = environments.value;
    const picked = list.find(function (item) { return item.id === editingId.value; });
    if (picked) return picked;
    if (selected.value && !selected.value.builtin) return selected.value;
    return list[0] || null;
  });

  function edit(id) {
    editingId.value = id || '';
  }

  /** 这个环境有没有没保存的修改 */
  function isDirty(id) {
    const draft = drafts.value[id];
    if (!draft) return false;
    const saved = environments.value.find(function (item) { return item.id === id; });
    if (!saved) return false;
    return draft.name !== saved.name ||
      JSON.stringify(draft.variables) !== JSON.stringify(saved.variables || []);
  }

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
    // 换了项目：上一个项目的草稿和编辑位置都作废（create / remove 也会调 load，项目没变就保留）
    if ((pid || '') !== projectId.value) {
      drafts.value = {};
      editingId.value = '';
    }
    projectId.value = pid || '';
    if (!pid) {
      environments.value = [];
      selectedId.value = '';
      return [];
    }

    const data = await envsApi.listEnvironments(pid);
    environments.value = data.environments || [];

    // 存的环境可能已经被删了，那就退回「无环境」。
    // 内置的 Mock 环境不在列表里，要单独认；本机模式下 mock 用不了，退成「无环境」。
    const saved = localStorage.getItem(storageKey(pid)) || '';
    if (saved === MOCK_ENV_ID) {
      selectedId.value = useGatewayStore().isLocal ? '' : MOCK_ENV_ID;
      return environments.value;
    }

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
    if (editingId.value === id) editingId.value = '';
    delete drafts.value[id];
    await load(projectId.value);
  }

  return {
    environments: environments,
    selectedId: selectedId,
    selected: selected,
    projectId: projectId,
    editingId: editingId,
    editing: editing,
    drafts: drafts,
    edit: edit,
    isDirty: isDirty,
    load: load,
    select: select,
    create: create,
    update: update,
    remove: remove
  };
});
