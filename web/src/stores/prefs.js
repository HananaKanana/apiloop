import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as prefsApi from '@/api/prefs';
import { getTree } from '@/api/tree';
import { t } from '@/i18n';

/**
 * 个人偏好（第七轮第 2 节）：项目分组、收藏、最近打开。
 *
 * 三项都**只属于你自己**，不影响同事，在你登录的设备之间同步；没登录（本机空间）时
 * 也能用，只存在这台电脑，登录后合并上去。
 *
 * 写入策略：
 * - 分组、收藏是用户一次点击一个动作，**立刻 PUT**，改完就用服务端返回的值（它理过一遍）；
 * - 「最近打开」点一下就开一个接口，太频繁，所以先在内存里改、**防抖 2 秒合成一次 PUT**
 *   （计划里写明了，别每次打开都写）。
 *
 * 名字解析：偏好里只存 id，界面要显示「项目名 / 接口名」。接口名按项目拉一次目录树缓存起来
 * （`ensureApis`），**找不到的 id 就当它被删了**，显示时过滤掉 —— 不用专门去清理。
 */

/** 和 `lib/db/repos/user-prefs.js` 的 MAX_RECENT 对齐 */
export const RECENT_MAX = 20;

/** 「最近打开」合并成一次 PUT 的等待时间 */
export const RECENT_DEBOUNCE_MS = 2000;

export const usePrefsStore = defineStore('prefs', function () {
  const projectGroups = ref([]);
  const favorites = ref({ projects: [], apis: [] });
  const recent = ref([]);
  const loaded = ref(false);

  /** 已经拉过目录树的项目：`pid → Map(apiId → api)`。只为了把接口名显示出来 */
  const apiIndex = ref(new Map());

  let recentTimer = null;

  function applyPrefs(prefs) {
    const source = prefs || {};
    projectGroups.value = Array.isArray(source.projectGroups) ? source.projectGroups : [];
    favorites.value = source.favorites && typeof source.favorites === 'object'
      ? { projects: source.favorites.projects || [], apis: source.favorites.apis || [] }
      : { projects: [], apis: [] };
    recent.value = Array.isArray(source.recent) ? source.recent : [];
  }

  /**
   * 拉一次偏好（页面启动时、以及后台同步拉下来别的设备的改动之后）。
   * 顺手把接口名缓存清掉 —— 那些项目可能刚被改过。
   */
  async function load() {
    const data = await prefsApi.getPrefs();
    applyPrefs(data.prefs);
    apiIndex.value = new Map();
    loaded.value = true;
  }

  /** 登录态变了、切了空间之类的场景：下一次再拉 */
  function reset() {
    projectGroups.value = [];
    favorites.value = { projects: [], apis: [] };
    recent.value = [];
    loaded.value = false;
    apiIndex.value = new Map();
  }

  /* ------------------------------------------------------------------ 接口名解析 */

  /**
   * 把某个项目的接口列表拉下来并缓存，返回 `Map(apiId → api)`。
   * 拉不到（项目被删了、没权限）就给一个空 Map —— 显示时那些条目会被过滤掉。
   */
  async function ensureApis(pid) {
    if (!pid) return new Map();
    if (apiIndex.value.has(pid)) return apiIndex.value.get(pid);

    let map = new Map();
    try {
      const data = await getTree(pid);
      (data.apis || []).forEach(function (api) { map.set(api.id, api); });
    } catch (err) {
      // 看不到的项目当作空的：不是错误，界面上那几条不显示就是了
    }

    // Map 是同一个引用，直接 set 不会触发依赖它的 computed，所以要换一个新 Map
    const next = new Map(apiIndex.value);
    next.set(pid, map);
    apiIndex.value = next;
    return map;
  }

  /** 某个接口在缓存里的那条摘要，没拉到 / 已经被删了给 null */
  function apiOf(pid, apiId) {
    const map = apiIndex.value.get(pid);
    return map ? (map.get(apiId) || null) : null;
  }

  /* ------------------------------------------------------------------ 分组 */

  function groupOf(projectId) {
    return projectGroups.value.find(function (group) {
      return (group.projectIds || []).indexOf(projectId) > -1;
    }) || null;
  }

  async function saveGroups(list) {
    const data = await prefsApi.savePref('projectGroups', list || []);
    projectGroups.value = data.value || [];
    return projectGroups.value;
  }

  /** 新建一个空分组。名字重了不拦着（都是自己的东西），但空名字补一个默认的 */
  function addGroup(name) {
    const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return saveGroups(projectGroups.value.concat([{
      id: id,
      name: String(name || '').trim() || t('stores.newGroup'),
      projectIds: [],
      collapsed: false
    }]));
  }

  function renameGroup(id, name) {
    return saveGroups(projectGroups.value.map(function (group) {
      if (group.id !== id) return group;
      return Object.assign({}, group, { name: String(name || '').trim() || group.name });
    }));
  }

  /** 删掉分组：里面的项目回到「未分组」（项目本身不动） */
  function removeGroup(id) {
    return saveGroups(projectGroups.value.filter(function (group) { return group.id !== id; }));
  }

  function toggleGroupCollapsed(id) {
    return saveGroups(projectGroups.value.map(function (group) {
      if (group.id !== id) return group;
      return Object.assign({}, group, { collapsed: !group.collapsed });
    }));
  }

  /**
   * 把一个项目放进某个分组（`groupId` 为 null 表示移出去、回到「未分组」）。
   * 一个项目只属于一个分组，所以先从别的分组里摘掉。
   */
  function assignProject(projectId, groupId) {
    return saveGroups(projectGroups.value.map(function (group) {
      const has = (group.projectIds || []).indexOf(projectId) > -1;
      if (group.id === groupId) {
        if (has) return group;
        return Object.assign({}, group, { projectIds: (group.projectIds || []).concat([projectId]) });
      }
      if (!has) return group;
      return Object.assign({}, group, {
        projectIds: (group.projectIds || []).filter(function (id) { return id !== projectId; })
      });
    }));
  }

  /**
   * 一次设定某个分组里有哪些项目（管理分组弹窗里的多选框用）：
   * 选进来的项目从别的分组里拿掉（一个项目只属于一个分组），去掉的回到「未分组」。
   * 原来就在里面的保持原来的顺序，新加的排在后面。
   */
  function setGroupProjects(groupId, projectIds) {
    const wanted = new Set(projectIds);
    return saveGroups(projectGroups.value.map(function (group) {
      const current = group.projectIds || [];
      if (group.id !== groupId) {
        const kept = current.filter(function (id) { return !wanted.has(id); });
        return kept.length === current.length ? group : Object.assign({}, group, { projectIds: kept });
      }
      const kept = current.filter(function (id) { return wanted.has(id); });
      const added = projectIds.filter(function (id) { return kept.indexOf(id) === -1; });
      return Object.assign({}, group, { projectIds: kept.concat(added) });
    }));
  }

  /* ------------------------------------------------------------------ 收藏 */

  function isProjectFavorite(projectId) {
    return favorites.value.projects.indexOf(projectId) > -1;
  }

  function isApiFavorite(projectId, apiId) {
    return favorites.value.apis.some(function (item) {
      return item.projectId === projectId && item.apiId === apiId;
    });
  }

  async function saveFavorites(next) {
    const data = await prefsApi.savePref('favorites', next);
    favorites.value = data.value || { projects: [], apis: [] };
    return favorites.value;
  }

  function toggleProjectFavorite(projectId) {
    if (!projectId) return Promise.resolve(favorites.value);
    const projects = isProjectFavorite(projectId)
      ? favorites.value.projects.filter(function (id) { return id !== projectId; })
      : favorites.value.projects.concat([projectId]);
    return saveFavorites({ projects: projects, apis: favorites.value.apis });
  }

  function toggleApiFavorite(projectId, apiId) {
    if (!projectId || !apiId) return Promise.resolve(favorites.value);
    const apis = isApiFavorite(projectId, apiId)
      ? favorites.value.apis.filter(function (item) {
        return !(item.projectId === projectId && item.apiId === apiId);
      })
      : favorites.value.apis.concat([{ projectId: projectId, apiId: apiId }]);
    return saveFavorites({ projects: favorites.value.projects, apis: apis });
  }

  /** 这个项目里收藏的接口 id（顺序就是收藏的先后） */
  function favoriteApiIdsOf(projectId) {
    return favorites.value.apis
      .filter(function (item) { return item.projectId === projectId; })
      .map(function (item) { return item.apiId; });
  }

  /* ------------------------------------------------------------------ 最近打开 */

  /** 防抖用的那份待写值 */
  let recentPending = null;

  function flushRecent() {
    if (recentTimer) {
      clearTimeout(recentTimer);
      recentTimer = null;
    }
    if (!recentPending) return Promise.resolve();
    const value = recentPending;
    recentPending = null;
    return prefsApi.savePref('recent', value).then(function (data) {
      recent.value = data.value || [];
    }).catch(function () {
      // 记「最近打开」是顺手的事，写不上去就算了，别打扰用户
    });
  }

  /**
   * 记一笔「最近打开」。同一个接口再打开就挪到最前（不新增一条）。
   *
   * 本地立刻生效（界面马上能看到），真正写库防抖 2 秒 —— 连着开好几个接口只写一次。
   */
  function rememberOpened(projectId, apiId) {
    if (!projectId || !apiId) return;

    const next = [{ projectId: projectId, apiId: apiId, openedAt: Date.now() }]
      .concat(recent.value.filter(function (item) {
        return !(item.projectId === projectId && item.apiId === apiId);
      }))
      .slice(0, RECENT_MAX);

    recent.value = next;
    recentPending = next;

    if (recentTimer) clearTimeout(recentTimer);
    recentTimer = setTimeout(flushRecent, RECENT_DEBOUNCE_MS);
  }

  /**
   * 最近打开里「还能看到」的那些（接口被删掉的过滤掉）。要先把涉及项目的目录树拉齐。
   *
   * 顺带带上接口的方法和地址，⌘K 里那一列要显示。
   */
  async function visibleRecent() {
    const pids = [];
    recent.value.forEach(function (item) {
      if (pids.indexOf(item.projectId) === -1) pids.push(item.projectId);
    });
    await Promise.all(pids.map(ensureApis));

    return recent.value.map(function (item) {
      const api = apiOf(item.projectId, item.apiId);
      if (!api) return null;
      return {
        projectId: item.projectId,
        apiId: item.apiId,
        openedAt: item.openedAt,
        name: api.name || t('stores.untitledApi'),
        method: api.method || 'GET',
        url: api.url || ''
      };
    }).filter(Boolean);
  }

  const favoriteProjectIds = computed(function () { return favorites.value.projects; });

  return {
    projectGroups: projectGroups,
    favorites: favorites,
    recent: recent,
    loaded: loaded,
    favoriteProjectIds: favoriteProjectIds,

    load: load,
    reset: reset,
    ensureApis: ensureApis,
    apiOf: apiOf,
    visibleRecent: visibleRecent,

    groupOf: groupOf,
    saveGroups: saveGroups,
    addGroup: addGroup,
    renameGroup: renameGroup,
    removeGroup: removeGroup,
    toggleGroupCollapsed: toggleGroupCollapsed,
    assignProject: assignProject,
    setGroupProjects: setGroupProjects,

    isProjectFavorite: isProjectFavorite,
    isApiFavorite: isApiFavorite,
    toggleProjectFavorite: toggleProjectFavorite,
    toggleApiFavorite: toggleApiFavorite,
    favoriteApiIdsOf: favoriteApiIdsOf,

    rememberOpened: rememberOpened,
    flushRecent: flushRecent
  };
});
