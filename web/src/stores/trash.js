import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import * as trashApi from '@/api/trash';
import { useTreeStore } from '@/stores/tree';

/**
 * 回收站（第三轮第 1 节）。
 *
 * 侧栏底部的入口要显示「有东西时的条数」，所以这里存着一份列表；恢复 / 彻底删除 /
 * 清空之后重新拉一遍。恢复会往目录树里插回节点，所以顺带让目录树刷新一次。
 */
export const useTrashStore = defineStore('trash', function () {
  const items = ref([]);
  const loading = ref(false);
  const projectId = ref('');

  const count = computed(function () { return items.value.length; });

  async function load(pid) {
    projectId.value = pid || '';
    if (!pid) {
      items.value = [];
      return [];
    }

    loading.value = true;
    try {
      const data = await trashApi.getTrash(pid);
      items.value = data.items || [];
    } finally {
      loading.value = false;
    }
    return items.value;
  }

  async function refresh() {
    if (projectId.value) await load(projectId.value);
  }

  async function restore(id) {
    const data = await trashApi.restoreTrash(id);
    await refresh();
    // 恢复出来的接口 / 目录要立刻出现在左侧树里
    await useTreeStore().refresh();
    return data;
  }

  async function remove(id) {
    await trashApi.removeTrash(id);
    await refresh();
  }

  async function clear() {
    if (!projectId.value) return 0;
    const data = await trashApi.clearTrash(projectId.value);
    await refresh();
    return data.removed || 0;
  }

  return {
    items: items,
    loading: loading,
    projectId: projectId,
    count: count,
    load: load,
    refresh: refresh,
    restore: restore,
    remove: remove,
    clear: clear
  };
});
