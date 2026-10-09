import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as treeApi from '@/api/tree';
import * as apisApi from '@/api/apis';
import { buildTree } from '@/utils/tree';

/**
 * 目录树。
 *
 * 服务端给的是扁平的两个列表（folders / apis），树是前端按 position 组装的，
 * 所以任何写操作之后都要重新拉一遍 —— 以服务端返回的为准，不在前端自己拼顺序。
 */
export const useTreeStore = defineStore('tree', function () {
  const folders = ref([]);
  const apis = ref([]);
  const loading = ref(false);
  const projectId = ref('');
  /** 树里当前选中的目录，导入 cURL / OpenAPI 时当作落点 */
  const selectedFolderId = ref(null);

  function setSelectedFolder(id) {
    selectedFolderId.value = id || null;
  }

  const nodes = computed(function () {
    return buildTree(folders.value, apis.value);
  });

  const apiById = computed(function () {
    const map = new Map();
    apis.value.forEach(function (api) { map.set(api.id, api); });
    return map;
  });

  const folderById = computed(function () {
    const map = new Map();
    folders.value.forEach(function (folder) { map.set(folder.id, folder); });
    return map;
  });

  function apply(data) {
    folders.value = data.folders || [];
    apis.value = data.apis || [];

    // 选中的目录不在这棵树里了（切了项目，或者目录被删了）就清掉。
    // 不清的话，导入 cURL / 新建目录会带着上一个项目的目录 id，云端报「目录不存在或不属于这个项目」
    if (selectedFolderId.value && !folders.value.some(function (folder) {
      return folder.id === selectedFolderId.value;
    })) {
      selectedFolderId.value = null;
    }
  }

  async function load(pid) {
    // 换了项目：上一个项目里选中的目录立刻作废，别等新树加载完（那段时间里点导入也会带错）
    if ((pid || '') !== projectId.value) selectedFolderId.value = null;
    projectId.value = pid || '';
    if (!pid) {
      folders.value = [];
      apis.value = [];
      return;
    }

    loading.value = true;
    try {
      apply(await treeApi.getTree(pid));
    } finally {
      loading.value = false;
    }
  }

  async function refresh() {
    if (!projectId.value) return;
    apply(await treeApi.getTree(projectId.value));
  }

  async function createFolder(name, parentId) {
    const data = await treeApi.createFolder(projectId.value, { name: name, parentId: parentId || null });
    await refresh();
    return data.folder;
  }

  async function renameFolder(id, name) {
    const data = await treeApi.updateFolder(id, { name: name });
    await refresh();
    return data.folder;
  }

  /**
   * 保存目录设置（名称 / 描述 / 鉴权 / 变量）。契约第 3 节 `PUT /folders/:id` 是部分更新，
   * 所以调用方只传改动过的字段也可以。
   */
  async function saveFolder(id, patch) {
    const data = await treeApi.updateFolder(id, patch);
    await refresh();
    return data.folder;
  }

  async function removeFolder(id, mode) {
    await treeApi.removeFolder(id, mode);
    await refresh();
  }

  async function move(payload) {
    const data = await treeApi.moveNode(projectId.value, payload);
    apply(data);
  }

  async function moveMany(payload) {
    const data = await treeApi.moveMany(projectId.value, payload);
    apply(data);
  }

  async function removeMany(items) {
    const data = await treeApi.removeMany(projectId.value, items);
    apply(data);
    return data.removed || 0;
  }

  async function duplicateApi(id) {
    const data = await apisApi.duplicateApi(id);
    await refresh();
    return data.api;
  }

  async function renameApi(id, name) {
    const data = await apisApi.updateApi(id, { name: name });
    await refresh();
    return data.api;
  }

  async function removeApi(id) {
    await apisApi.removeApi(id);
    await refresh();
  }

  async function createApi(payload) {
    const data = await apisApi.createApi(projectId.value, payload);
    await refresh();
    return data.api;
  }

  return {
    folders: folders,
    apis: apis,
    nodes: nodes,
    apiById: apiById,
    folderById: folderById,
    loading: loading,
    projectId: projectId,
    selectedFolderId: selectedFolderId,
    setSelectedFolder: setSelectedFolder,
    load: load,
    refresh: refresh,
    createFolder: createFolder,
    renameFolder: renameFolder,
    saveFolder: saveFolder,
    removeFolder: removeFolder,
    move: move,
    duplicateApi: duplicateApi,
    renameApi: renameApi,
    removeApi: removeApi,
    moveMany: moveMany,
    removeMany: removeMany,
    createApi: createApi
  };
});
