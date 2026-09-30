import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as projectsApi from '@/api/projects';

const STORAGE_KEY = 'apiloop.project';

/**
 * 项目列表 + 当前项目。
 * 当前项目 id 存在 localStorage 里；存的那个项目可能已经被删掉了，所以要兜一下，
 * 退回列表里的第一个，不能白屏。
 */
export const useProjectStore = defineStore('project', function () {
  const projects = ref([]);
  const currentId = ref(localStorage.getItem(STORAGE_KEY) || '');
  const loading = ref(false);

  const current = computed(function () {
    return projects.value.find(function (item) { return item.id === currentId.value; }) || null;
  });

  function setCurrent(id) {
    currentId.value = id || '';
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  }

  function ensureCurrent() {
    if (!projects.value.length) {
      setCurrent('');
      return;
    }
    const exists = projects.value.some(function (item) { return item.id === currentId.value; });
    if (!exists) setCurrent(projects.value[0].id);
  }

  async function load() {
    loading.value = true;
    try {
      const data = await projectsApi.listProjects();
      projects.value = data.projects || [];
      ensureCurrent();
      return projects.value;
    } finally {
      loading.value = false;
    }
  }

  async function create(payload) {
    const data = await projectsApi.createProject(payload);
    await load();
    setCurrent(data.project.id);
    return data.project;
  }

  async function update(id, patch) {
    const data = await projectsApi.updateProject(id, patch);
    const index = projects.value.findIndex(function (item) { return item.id === id; });
    if (index !== -1) projects.value[index] = data.project;
    return data.project;
  }

  async function remove(id) {
    await projectsApi.removeProject(id);
    await load();
    return current.value;
  }

  async function refresh() {
    const data = await projectsApi.listProjects();
    projects.value = data.projects || [];
    ensureCurrent();
    return current.value;
  }

  return {
    projects: projects,
    currentId: currentId,
    current: current,
    loading: loading,
    load: load,
    create: create,
    update: update,
    remove: remove,
    refresh: refresh,
    setCurrent: setCurrent
  };
});
