import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as projectsApi from '@/api/projects';

const STORAGE_KEY = 'apiloop.project';

function readSavedId() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch (err) {
    return '';
  }
}

/**
 * 项目列表 + 当前项目。
 * 当前项目 id 存在 localStorage 里；存的那个项目可能已经被删掉了，所以要兜一下，
 * 退回列表里的第一个，不能白屏。
 *
 * **列表加载完之前 `currentId` 是空的**，记住的那个 id 只在 `ensureCurrent` 里用。
 * 目录树、环境、Mock 日志都 watch 着 `currentId`（还带 immediate），如果一开始就把
 * 记住的 id 放进去，它们会拿一个可能已经不存在的项目去请求 —— 网关上从云端切到本机库时，
 * 记住的是云端的项目，本机库里没有，页面一打开就弹「项目不存在」（2026-10-01 用户遇到）。
 */
export const useProjectStore = defineStore('project', function () {
  const projects = ref([]);
  /** 上次选中的项目。只在列表回来以后拿来挑当前项目，见文件头 */
  const savedId = readSavedId();
  const currentId = ref('');
  const loading = ref(false);

  const current = computed(function () {
    return projects.value.find(function (item) { return item.id === currentId.value; }) || null;
  });

  /**
   * 当前项目里「我」的角色。admin 是系统角色，服务端对任何项目都返回 'admin'，
   * 它的能力等同 owner。
   *
   * 注意：按角色隐藏或禁用只是体验优化，真正的拦截在服务端的 guard 上。
   * 所以所有写操作仍然要处理 403，把服务端返回的中文错误原样提示出来。
   */
  const myRole = computed(function () {
    return (current.value && current.value.myRole) || '';
  });

  /** 能改数据：editor 及以上 */
  const canEdit = computed(function () {
    return myRole.value === 'admin' || myRole.value === 'owner' || myRole.value === 'editor';
  });

  /** 能改项目本身：改名称 / 标识、管成员、删项目 */
  const isOwner = computed(function () {
    return myRole.value === 'admin' || myRole.value === 'owner';
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
    const wanted = currentId.value || savedId;
    const exists = projects.value.some(function (item) { return item.id === wanted; });
    setCurrent(exists ? wanted : projects.value[0].id);
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
    myRole: myRole,
    canEdit: canEdit,
    isOwner: isOwner,
    loading: loading,
    load: load,
    create: create,
    update: update,
    remove: remove,
    refresh: refresh,
    setCurrent: setCurrent
  };
});
