import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import * as apisApi from '@/api/apis';
import * as sendApi from '@/api/send';
import * as historyApi from '@/api/history';

let draftSeq = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function emptySpec() {
  return {
    method: 'GET',
    url: '',
    params: { path: [], query: [], headers: [] },
    body: { mode: 'none' },
    auth: null
  };
}

/**
 * `/send` 的 options（契约第 12 节）。两个开关默认都开：
 * 自动管理 Cookie、按系统设置走代理。它们是**这次请求**的选择，
 * 属于标签页自己的界面状态，不落库、也不进 spec。
 */
export function emptyOptions() {
  return { cookies: true, proxy: true };
}

/** 服务端返回的 Api 里，和 RequestSpec 对应的那部分 */
export function specFromApi(api) {
  return {
    method: api.method || 'GET',
    url: api.url || '',
    params: {
      path: (api.params && api.params.path) || [],
      query: (api.params && api.params.query) || [],
      headers: (api.params && api.params.headers) || []
    },
    body: api.body || { mode: 'none' },
    auth: api.auth === undefined ? null : api.auth
  };
}

function snapshot(spec) {
  return JSON.stringify(spec);
}

/**
 * 标签页。
 *
 * 每个标签页自己揣着「编辑中的 spec」，所以切来切去内容不会丢；
 * dirty 用「当前 spec 和上次保存时的快照比」算出来，不靠手工置位。
 */
export const useTabsStore = defineStore('tabs', function () {
  const tabs = ref([]);
  const activeKey = ref('');

  const active = computed(function () {
    return tabs.value.find(function (tab) { return tab.key === activeKey.value; }) || null;
  });

  const hasDirty = computed(function () {
    return tabs.value.some(function (tab) { return tab.dirty; });
  });

  function touch(tab) {
    if (!tab.savedSnapshot) {
      // 还没保存过的临时标签页：只要动过就算未保存
      tab.dirty = JSON.stringify(tab.spec) !== snapshot(emptySpec());
      return;
    }
    tab.dirty = JSON.stringify(tab.spec) !== tab.savedSnapshot;
  }

  async function openApi(apiId) {
    const key = 'api:' + apiId;
    const existing = tabs.value.find(function (tab) { return tab.key === key; });
    if (existing) {
      activeKey.value = key;
      return existing;
    }

    const data = await apisApi.getApi(apiId);
    const spec = specFromApi(data.api);
    const tab = {
      key: key,
      kind: 'api',
      apiId: apiId,
      folderId: data.api.folderId || null,
      title: data.api.name || '未命名接口',
      spec: spec,
      savedSnapshot: snapshot(spec),
      options: emptyOptions(),
      api: data.api,
      dirty: false,
      result: null,
      sendError: '',
      missingVariables: [],
      sending: false,
      controller: null
    };

    tabs.value.push(tab);
    activeKey.value = key;
    return tab;
  }

  function openDraft(folderId) {
    draftSeq += 1;
    const key = 'draft:' + draftSeq;
    const tab = {
      key: key,
      kind: 'draft',
      apiId: null,
      folderId: folderId || null,
      title: '新建请求',
      spec: emptySpec(),
      savedSnapshot: null,
      options: emptyOptions(),
      api: null,
      dirty: false,
      result: null,
      sendError: '',
      missingVariables: [],
      sending: false,
      controller: null
    };

    tabs.value.push(tab);
    activeKey.value = key;
    return tab;
  }

  function activate(key) {
    activeKey.value = key;
  }

  /**
   * 从历史打开一个临时标签页：请求用当时保存的 spec，响应面板直接显示当时的结果。
   * 历史里的 request 还额外带了一个 environmentId，取出来单独放，别混进 spec。
   */
  async function openHistory(historyId) {
    const key = 'history:' + historyId;
    const existing = tabs.value.find(function (tab) { return tab.key === key; });
    if (existing) {
      activeKey.value = key;
      return existing;
    }

    const data = await historyApi.getHistory(historyId);
    const record = data.entry || {};
    const spec = Object.assign({}, record.request || emptySpec());
    const environmentId = spec.environmentId || '';
    delete spec.environmentId;

    const result = record.result || null;
    const truncated = Boolean(
      (result && result.historyTruncated) ||
        (result && result.response && result.response.historyTruncated)
    );

    const tab = {
      key: key,
      kind: 'history',
      apiId: record.apiId || null,
      folderId: null,
      title: spec.url || '历史记录',
      spec: spec,
      savedSnapshot: null,
      options: emptyOptions(),
      api: null,
      dirty: false,
      result: result,
      historyTruncated: truncated,
      environmentId: environmentId,
      sendError: '',
      missingVariables: (result && result.missingVariables) || [],
      sending: false,
      controller: null
    };

    tabs.value.push(tab);
    activeKey.value = key;
    return tab;
  }

  function close(key) {
    const index = tabs.value.findIndex(function (tab) { return tab.key === key; });
    if (index === -1) return;

    const wasActive = activeKey.value === key;
    tabs.value.splice(index, 1);

    if (!wasActive) return;
    const next = tabs.value[index] || tabs.value[index - 1] || null;
    activeKey.value = next ? next.key : '';
  }

  function closeAll() {
    tabs.value = [];
    activeKey.value = '';
  }

  /** 接口被删掉之后，把对应的标签页收掉，别留着一个点开就报错的页 */
  function syncWithApis(apiIds) {
    const known = new Set(apiIds);
    const removed = tabs.value.filter(function (tab) {
      return tab.kind === 'api' && !known.has(tab.apiId);
    });
    removed.forEach(function (tab) { close(tab.key); });
  }

  function markSaved(tab, api) {
    const spec = specFromApi(api);
    tab.api = api;
    tab.apiId = api.id;
    tab.kind = 'api';
    tab.key = 'api:' + api.id;
    tab.title = api.name || '未命名接口';
    tab.folderId = api.folderId || null;
    tab.spec = spec;
    tab.savedSnapshot = snapshot(spec);
    tab.dirty = false;
    activeKey.value = tab.key;
  }

  function touchActive() {
    if (active.value) touch(active.value);
  }

  async function sendRequest(projectId, environmentId) {
    const tab = active.value;
    if (!tab || tab.sending) return;

    tab.sending = true;
    tab.sendError = '';
    tab.result = null;
    tab.missingVariables = [];
    tab.controller = new AbortController();

    try {
      const data = await sendApi.send(
        projectId,
        {
          request: clone(tab.spec),
          apiId: tab.apiId || undefined,
          environmentId: environmentId || undefined,
          options: clone(tab.options || emptyOptions())
        },
        tab.controller.signal
      );
      tab.result = data.result;
      tab.historyId = data.historyId;
      tab.missingVariables = (data.result && data.result.missingVariables) || [];
    } catch (err) {
      tab.sendError = err.aborted ? '' : err.message;
    } finally {
      tab.sending = false;
      tab.controller = null;
    }
  }

  function cancelSend() {
    const tab = active.value;
    if (tab && tab.controller) tab.controller.abort();
  }

  return {
    tabs: tabs,
    activeKey: activeKey,
    active: active,
    hasDirty: hasDirty,
    openApi: openApi,
    openDraft: openDraft,
    openHistory: openHistory,
    activate: activate,
    close: close,
    closeAll: closeAll,
    syncWithApis: syncWithApis,
    markSaved: markSaved,
    touch: touch,
    touchActive: touchActive,
    sendRequest: sendRequest,
    cancelSend: cancelSend
  };
});
