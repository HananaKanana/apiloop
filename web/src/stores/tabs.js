import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import * as apisApi from '@/api/apis';
import * as streamApi from '@/api/stream';
import * as historyApi from '@/api/history';
import { createSseParser } from '@/utils/sse';
import { encodeQueryPart } from '@/utils/query';
import { byteLength } from '@/utils/bytes';
import { useWsStore } from '@/stores/ws';
import { useTreeStore } from '@/stores/tree';
import { useEnvStore } from '@/stores/env';
import { useProjectStore } from '@/stores/project';

let draftSeq = 0;
let wsSeq = 0;

/** 事件视图里最多保留多少条，超出就丢最旧的（契约第 14 节的调试视图） */
const MAX_SSE_EVENTS = 2000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function emptySpec() {
  return {
    method: 'GET',
    url: '',
    params: { path: [], query: [], headers: [] },
    body: { mode: 'none' },
    auth: null,
    // 脚本挂在 spec 上（契约第 16 节：接口的脚本取自 request.scripts），
    // 这样没保存的脚本改动也会参与这次发送
    scripts: []
  };
}

/**
 * `/send` 的 options（契约第 12、16 节）。三个开关默认都开：
 * 自动管理 Cookie、按系统设置走代理、执行脚本。它们是**这次请求**的选择，
 * 属于标签页自己的界面状态，不落库、也不进 spec。
 */
export function emptyOptions() {
  return { cookies: true, proxy: true, scripts: true };
}

/**
 * 流式发送过程中的临时状态（契约第 14 节）。只活在这一次发送里，不落库、不进历史：
 * - `head`：最后一跳的响应头，到了就立刻显示状态码和响应头；
 * - `receivedBytes`：已经收到多少字节，非 SSE 的响应用它显示「接收中… N KB」，
 *   不把 chunk 一段段拼进 DOM；
 * - `sseEvents`：content-type 是 text/event-stream 时才有，非 SSE 的响应保持 null
 *   （事件视图靠它决定显不显示）；
 * - `cancelled`：用户点了「取消」，用来给一句提示（服务端照常记一条历史）。
 */
export function emptyLive() {
  return {
    head: null,
    receivedBytes: 0,
    sseEvents: null,
    sseDropped: 0,
    cancelled: false,
    /**
     * 发送**没能开始**时服务端给的错误码（比如直接打开云端时的 409
     * `SERVER_SEND_DISABLED`）。这种错发生在 NDJSON 开始之前，进不了 `result.error`，
     * 只存在 `tab.sendError` 的文案里，界面就没法按码区分（审阅 B1）。
     */
    sendErrorCode: ''
  };
}

/**
 * WebSocket 调试标签页的请求内容（契约第 15 节）。没有路径参数和请求体：
 * 地址、请求头、query、鉴权就是全部。
 */
export function emptyWsSpec() {
  return { url: '', params: { headers: [], query: [] }, auth: null };
}

/** 服务端返回的 Api 里，和 WebSocket 请求对应的那部分（WS 接口用同一批字段存） */
export function wsSpecFromApi(api) {
  return {
    url: api.url || '',
    params: {
      headers: JSON.parse(JSON.stringify((api.params && api.params.headers) || [])),
      query: JSON.parse(JSON.stringify((api.params && api.params.query) || []))
    },
    auth: api.auth === undefined || api.auth === null
      ? null
      : JSON.parse(JSON.stringify(api.auth))
  };
}

/**
 * 目录设置标签页里可编辑的那部分（契约第 3 节 `PUT /folders/:id`）。
 * 放进 `spec` 是为了直接复用标签页那套「和快照比出 dirty」的机制。
 */
export function folderSpecFrom(folder) {
  return {
    name: folder.name || '',
    description: folder.description || '',
    auth: folder.auth ? JSON.parse(JSON.stringify(folder.auth)) : { type: 'inherit' },
    variables: JSON.parse(JSON.stringify(folder.variables || [])),
    scripts: JSON.parse(JSON.stringify(folder.scripts || []))
  };
}

/**
 * 地址里没有 `?`、但查询参数表里有启用的行时，把它们拼进地址。
 *
 * 这个页面的地址栏和查询参数表是**双向同步**的（见 RequestTab 的 syncFromUrl /
 * onQueryChange）：用户在地址栏里改任何一个字，查询表就按地址重新解析。
 * 而 HAR / Postman 导入的老数据是「地址不带查询串、只有表格」——
 * 打开时不拼一次的话，用户在地址栏里一编辑，那些参数就全没了（审阅 B4）。
 *
 * 只影响打开时的显示，不改库里的数据；编码规则和 RequestTab.onQueryChange 一致。
 */
function withQueryInUrl(url, rows) {
  const text = String(url || '');
  if (text.indexOf('?') !== -1) return text;

  const queryString = (rows || []).filter(function (row) {
    return row && row.enabled !== false && row.key;
  }).map(function (row) {
    const value = row.value === undefined || row.value === null ? '' : row.value;
    return encodeQueryPart(row.key) + '=' + encodeQueryPart(value);
  }).join('&');

  if (!queryString) return text;
  return text.split('#')[0] + '?' + queryString;
}

/** 服务端返回的 Api 里，和 RequestSpec 对应的那部分 */
export function specFromApi(api) {
  /*
   * **全部深拷贝**，编辑区不能和 tab.api（服务端那份原件）共用对象。
   * 以前只拷了 scripts，body / auth 是同一个对象：在编辑区改请求体（含 JSON 美化）会把原件
   * 一起改掉，保存时 changedFields 拿两边比永远相等，提示「没有改动」，改动存不进去
   * （P2 起就有，2026-10-01 用户美化后保存时发现）。
   */
  const copy = function (value) { return JSON.parse(JSON.stringify(value)); };
  const params = api.params || {};
  const query = copy(params.query || []);
  return {
    method: api.method || 'GET',
    url: withQueryInUrl(api.url || '', query),
    params: {
      path: copy(params.path || []),
      query: query,
      headers: copy(params.headers || [])
    },
    body: copy(api.body || { mode: 'none' }),
    auth: api.auth === undefined || api.auth === null ? null : copy(api.auth),
    scripts: copy(api.scripts || [])
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

  /* ---------------- 预览标签页（和 Postman 一样） ---------------- */

  /**
   * 目录树里**单击**打开的接口 / 目录是「预览标签页」（标题斜体），整排最多一个：
   * 再单击别的，就把它**换掉**，而不是越开越多。下面几种情况它会变成普通标签页、不再被换掉：
   * - 改了内容（dirty）、发过请求（sending / result）—— 由下面的 watch 自动固定；
   * - 双击标签页、双击目录树里的节点、用别的方式（⌘K、Mock 日志、右键「目录设置」）再打开一次。
   */
  function placeTab(tab) {
    if (tab.preview) {
      const index = tabs.value.findIndex(function (item) { return item.preview && item.key !== tab.key; });
      if (index !== -1) {
        dropTab(tabs.value[index]);
        tabs.value.splice(index, 1, tab);
        activeKey.value = tab.key;
        return;
      }
    }
    tabs.value.push(tab);
    activeKey.value = tab.key;
  }

  /** 把预览标签页固定成普通标签页（双击标签页时用） */
  function pin(key) {
    const tab = tabs.value.find(function (item) { return item.key === key; });
    if (tab) tab.preview = false;
  }

  // 预览标签页一旦改过或发过请求，就固定下来 —— 不能让下一次单击把用户的改动 / 结果顶掉
  watch(
    function () {
      return tabs.value.filter(function (tab) {
        return tab.preview && (tab.dirty || tab.sending || tab.result);
      }).map(function (tab) { return tab.key; });
    },
    function (keys) {
      keys.forEach(pin);
    }
  );

  /**
   * 正在从服务端拉的接口：`key → Promise`。
   * openApi 先查「开没开」、再 await 拉数据、再 push —— 拉数据那一小段时间里再调一次
   * （连点两下、或者别处同时也要打开），两边都查不到，就会开出两个一样的标签页
   * （用户 2026-09-30 报的「点一下出现 2 个」）。在途的直接复用同一个 Promise。
   */
  const pendingOpens = new Map();

  /**
   * @param {string} apiId
   * @param {{ preview?: boolean }} [options] preview：用预览标签页打开（目录树单击），见 placeTab
   */
  function openApi(apiId, options) {
    const preview = Boolean(options && options.preview);
    const key = 'api:' + apiId;
    const existing = tabs.value.find(function (tab) { return tab.key === key; });
    if (existing) {
      // 不是预览方式再打开一次（双击目录树、⌘K 等）＝ 把它固定下来
      if (!preview) existing.preview = false;
      activeKey.value = key;
      return Promise.resolve(existing);
    }

    if (pendingOpens.has(key)) {
      // 还在拉的时候就双击了：等它开出来再固定
      if (preview) return pendingOpens.get(key);
      return pendingOpens.get(key).then(function (tab) {
        // 要改数组里那个响应式的对象，改 loadApiTab 返回的原始对象界面不会跟着变
        const live = tabs.value.find(function (item) { return item.key === key; });
        if (live) live.preview = false;
        return live || tab;
      });
    }
    const pending = loadApiTab(apiId, preview).finally(function () { pendingOpens.delete(key); });
    pendingOpens.set(key, pending);
    return pending;
  }

  async function loadApiTab(apiId, preview) {
    const key = 'api:' + apiId;
    const data = await apisApi.getApi(apiId);

    // 等数据的这段时间里，别的路径可能已经把它开出来了，那就直接切过去
    const opened = tabs.value.find(function (tab) { return tab.key === key; });
    if (opened) {
      activeKey.value = key;
      return opened;
    }
    // WS 接口用 WebSocket 标签页打开（契约第 17 节），不是那套 HTTP 界面。
    // 它不走预览：连着的会话被顶掉就断了
    if (data.api.method === 'WS') return pushWsApiTab(data.api);

    const spec = specFromApi(data.api);
    const tab = Object.assign({
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
    }, emptyLive());

    tab.preview = preview;
    placeTab(tab);
    return tab;
  }

  /**
   * 新建一个还没保存的临时标签页。
   *
   * @param {string|null} folderId 保存时默认落到哪个目录
   * @param {object} [spec] 传了就用它当请求内容（从 cURL 解析出来直接开一个标签页）；
   *                        不传就是一个空请求
   */
  function openDraft(folderId, spec) {
    draftSeq += 1;
    const key = 'draft:' + draftSeq;
    const tab = Object.assign({
      key: key,
      kind: 'draft',
      apiId: null,
      folderId: folderId || null,
      title: '新建请求',
      spec: spec ? JSON.parse(JSON.stringify(spec)) : emptySpec(),
      savedSnapshot: null,
      options: emptyOptions(),
      api: null,
      dirty: false,
      result: null,
      sendError: '',
      missingVariables: [],
      sending: false,
      controller: null
    }, emptyLive());

    tabs.value.push(tab);
    activeKey.value = key;

    // 带内容开出来的（cURL）：按「已经动过」算，关它的时候要提示一下
    if (spec) touch(tab);
    return tab;
  }

  /**
   * 新建一个 WebSocket 调试标签页。它**不进目录树**，所以没有 apiId，
   * 也不参与 dirty / 保存那一套；想留下来就点「保存到目录」，那时会变成
   * 绑定接口的 WebSocket 标签页（见 markSaved 的 WS 分支）。
   */
  function openWs() {
    wsSeq += 1;
    const key = 'ws:' + wsSeq;
    const tab = Object.assign({
      key: key,
      kind: 'ws',
      apiId: null,
      folderId: null,
      title: 'WebSocket',
      spec: emptyWsSpec(),
      savedSnapshot: null,
      options: { cookies: true },
      api: null,
      dirty: false,
      result: null,
      sendError: '',
      missingVariables: [],
      sending: false,
      controller: null
    }, emptyLive());

    tabs.value.push(tab);
    activeKey.value = key;
    return tab;
  }

  /**
   * 绑定接口的 WebSocket 标签页。key 和普通接口标签页一样是 `api:<id>` ——
   * 同一个接口只会有一个标签页，只是渲染成 WebSocket 的样子。
   */
  function pushWsApiTab(api) {
    const key = 'api:' + api.id;
    const spec = wsSpecFromApi(api);
    const tab = Object.assign({
      key: key,
      kind: 'ws',
      apiId: api.id,
      folderId: api.folderId || null,
      title: api.name || 'WebSocket',
      spec: spec,
      savedSnapshot: snapshot(spec),
      options: { cookies: true },
      api: api,
      dirty: false,
      result: null,
      sendError: '',
      missingVariables: [],
      sending: false,
      controller: null
    }, emptyLive());

    tabs.value.push(tab);
    activeKey.value = key;
    return tab;
  }

  function activate(key) {
    activeKey.value = key;
  }

  /**
   * 打开目录设置。key 里带目录 id，所以**同一个目录只会有一个标签页**。
   * 可编辑的内容放在 `spec` 上，这样「和快照比出 dirty」那套机制可以直接复用。
   */
  /** @param {{ preview?: boolean }} [options] 同 openApi */
  function openFolder(folderId, options) {
    const preview = Boolean(options && options.preview);
    const key = 'folder:' + folderId;
    const existing = tabs.value.find(function (tab) { return tab.key === key; });
    if (existing) {
      if (!preview) existing.preview = false;
      activeKey.value = key;
      return existing;
    }

    const folder = useTreeStore().folderById.get(folderId);
    if (!folder) return null;

    const spec = folderSpecFrom(folder);
    const tab = Object.assign({
      key: key,
      kind: 'folder',
      apiId: null,
      folderId: folderId,
      title: folder.name || '目录设置',
      spec: spec,
      savedSnapshot: snapshot(spec),
      options: emptyOptions(),
      api: null,
      dirty: false,
      result: null,
      sendError: '',
      missingVariables: [],
      sending: false,
      controller: null
    }, emptyLive());

    tab.preview = preview;
    placeTab(tab);
    return tab;
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
    // 早期写进历史的 spec 里没有 scripts（P8 才加），补一个空的，别让编辑器拿到 undefined
    if (!Array.isArray(spec.scripts)) spec.scripts = [];

    const result = record.result || null;
    const truncated = Boolean(
      (result && result.historyTruncated) ||
        (result && result.response && result.response.historyTruncated)
    );

    const tab = Object.assign({
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
    }, emptyLive());

    tabs.value.push(tab);
    activeKey.value = key;
    return tab;
  }

  /** 关标签页时把还在跑的请求 abort 掉，别让它在后台一直连着 */
  function abortTab(tab) {
    if (tab && tab.controller) tab.controller.abort();
  }

  /**
   * WebSocket 标签页要连带把服务端的会话销毁掉（DELETE /ws/:id）。
   * 切换项目时 ProjectSwitcher 会 closeAll，所以这条路径也一起覆盖了。
   */
  function dropTab(tab) {
    abortTab(tab);
    if (tab && tab.kind === 'ws') useWsStore().closeFor(tab.key);
  }

  function close(key) {
    const index = tabs.value.findIndex(function (tab) { return tab.key === key; });
    if (index === -1) return;

    const wasActive = activeKey.value === key;
    dropTab(tabs.value[index]);
    tabs.value.splice(index, 1);

    if (!wasActive) return;
    const next = tabs.value[index] || tabs.value[index - 1] || null;
    activeKey.value = next ? next.key : '';
  }

  function closeAll() {
    tabs.value.forEach(dropTab);
    tabs.value = [];
    activeKey.value = '';
  }

  /** 接口被删掉之后，把对应的标签页收掉，别留着一个点开就报错的页 */
  function syncWithApis(apiIds) {
    const known = new Set(apiIds);
    const removed = tabs.value.filter(function (tab) {
      // 绑定了接口的 WebSocket 标签页（kind 是 ws）也要一起收
      return (tab.kind === 'api' || tab.kind === 'ws') &&
        Boolean(tab.apiId) && !known.has(tab.apiId);
    });
    removed.forEach(function (tab) { close(tab.key); });
  }

  /** 目录被删掉之后同理，把它的设置标签页收掉 */
  function syncWithFolders(folderIds) {
    const known = new Set(folderIds);
    const removed = tabs.value.filter(function (tab) {
      return tab.kind === 'folder' && !known.has(tab.folderId);
    });
    removed.forEach(function (tab) { close(tab.key); });
  }

  function markSaved(tab, api) {
    // WS 接口存下来之后要换成 WebSocket 的样子：spec 形状和普通接口不一样
    if (api.method === 'WS') {
      const previousKey = tab.key;
      const wsSpec = wsSpecFromApi(api);
      tab.kind = 'ws';
      tab.apiId = api.id;
      tab.api = api;
      tab.key = 'api:' + api.id;
      tab.title = api.name || 'WebSocket';
      tab.folderId = api.folderId || null;
      tab.spec = wsSpec;
      tab.savedSnapshot = snapshot(wsSpec);
      tab.options = { cookies: true };
      tab.dirty = false;
      // 临时标签页是 `ws:N`，绑上接口之后 key 变成 `api:<id>`：
      // 会话状态（日志、连接、重连计时器）要跟着搬，否则刚录的东西全丢
      useWsStore().move(previousKey, tab.key);
      activeKey.value = tab.key;
      return;
    }

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

  /** 目录设置保存成功后：用服务端返回的 folder 重算快照，dirty 自然就消了 */
  function markFolderSaved(tab, folder) {
    const spec = folderSpecFrom(folder);
    tab.title = folder.name || '目录设置';
    tab.spec = spec;
    tab.savedSnapshot = snapshot(spec);
    tab.dirty = false;
  }

  function touchActive() {
    if (active.value) touch(active.value);
  }

  function headerValue(headers, name) {
    const target = String(name).toLowerCase();
    let found = '';
    (headers || []).forEach(function (pair) {
      if (String(pair[0]).toLowerCase() === target) found = String(pair[1]);
    });
    return found;
  }

  /**
   * 脚本写回过变量（契约第 16 节的 `scripts.variables.persisted`）时，
   * 把当前环境和项目的变量重新拉一遍 —— 「缺少变量」的提示和环境管理弹窗里
   * 显示的值都得是最新的。拉失败不影响这次发送的结果，所以只吞掉。
   */
  function refreshVariablesIfPersisted(result) {
    const scripts = result && result.scripts;
    if (!scripts || !scripts.variables || !scripts.variables.persisted) return;

    const envs = useEnvStore();
    const projects = useProjectStore();
    if (envs.projectId) envs.load(envs.projectId).catch(function () {});
    projects.refresh().catch(function () {});
  }

  function pushSseEvent(tab, item) {
    const list = tab.sseEvents || (tab.sseEvents = []);
    list.push({
      time: Date.now(),
      event: item.event,
      data: item.data,
      id: item.id,
      size: byteLength(item.data)
    });

    const overflow = list.length - MAX_SSE_EVENTS;
    if (overflow > 0) {
      list.splice(0, overflow);
      tab.sseDropped += overflow;
    }
  }

  /**
   * 发送。一律走流式接口（契约第 14 节），好处是 SSE 能实时看到、任何请求都能取消：
   * - `head` 到了就先显示状态码和响应头；
   * - `text/event-stream` 的响应边收边按 SSE 解析成事件（事件视图）；
   * - 其他响应只累计字节数，不把 chunk 一段段拼进 DOM；
   * - `end` 到了才把 result 交给响应面板。Cookie 写回和历史都由服务端在 `end` 之前做完。
   */
  async function sendRequest(projectId, environmentId) {
    const tab = active.value;
    if (!tab || tab.sending) return;

    Object.assign(tab, emptyLive(), {
      sending: true,
      sendError: '',
      result: null,
      historyId: null,
      missingVariables: [],
      controller: new AbortController()
    });

    // 只在确认是 SSE 之后才建解析器
    const sse = { parser: null };

    function onEvent(event) {
      if (!event || !event.type) return;

      if (event.type === 'head') {
        tab.head = {
          response: event.response || null,
          redirects: event.redirects || [],
          // 收到响应头的时刻。「保存为 SSE 示例」算第一条事件的 delay 要从这里起算
          // （契约第 17 节：第一条的 delay 是相对于响应头）
          time: Date.now()
        };
        const type = headerValue(event.response && event.response.headers, 'content-type');
        if (type.toLowerCase().indexOf('text/event-stream') !== -1) {
          tab.sseEvents = [];
          sse.parser = createSseParser(function (item) { pushSseEvent(tab, item); });
        }
        return;
      }

      if (event.type === 'chunk') {
        if (typeof event.text === 'string') {
          tab.receivedBytes += byteLength(event.text);
          if (sse.parser) sse.parser.push(event.text);
        } else if (typeof event.base64 === 'string') {
          // base64 每 4 个字符对应 3 个字节
          tab.receivedBytes += Math.floor(event.base64.length * 3 / 4);
        }
        return;
      }

      if (event.type === 'end') {
        if (sse.parser) sse.parser.end();
        tab.result = event.result || null;
        tab.historyId = event.historyId || null;
        tab.missingVariables = (event.result && event.result.missingVariables) || [];
        refreshVariablesIfPersisted(event.result);
      }
    }

    try {
      await streamApi.postNdjson(
        '/projects/' + encodeURIComponent(projectId) + '/send/stream',
        {
          request: clone(tab.spec),
          apiId: tab.apiId || undefined,
          environmentId: environmentId || undefined,
          options: clone(tab.options || emptyOptions())
        },
        { signal: tab.controller.signal, onEvent: onEvent }
      );
    } catch (err) {
      if (err.aborted) {
        // 用户主动取消：服务端照常记一条 ABORTED 历史，界面上给一句提示就够了
        if (sse.parser) sse.parser.end();
        tab.cancelled = true;
      } else {
        tab.sendError = err.message;
        // stream.js 抛的是 toError 造出来的 Error，status / data 都在上面
        tab.sendErrorCode = (err.data && err.data.code) || '';
      }
    } finally {
      tab.sending = false;
      tab.controller = null;
    }
  }

  function cancelSend(tab) {
    abortTab(tab || active.value);
  }

  return {
    tabs: tabs,
    activeKey: activeKey,
    active: active,
    hasDirty: hasDirty,
    openApi: openApi,
    openDraft: openDraft,
    openWs: openWs,
    openFolder: openFolder,
    openHistory: openHistory,
    activate: activate,
    close: close,
    pin: pin,
    closeAll: closeAll,
    syncWithApis: syncWithApis,
    syncWithFolders: syncWithFolders,
    markSaved: markSaved,
    markFolderSaved: markFolderSaved,
    touch: touch,
    touchActive: touchActive,
    sendRequest: sendRequest,
    cancelSend: cancelSend
  };
});
