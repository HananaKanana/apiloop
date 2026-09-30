/* ==========================================================================
 * server-mock 内置 Web 管理台 —— 前端逻辑
 *
 * 零构建 / 零依赖：纯原生 JS（ES6+），无 import / export / JSX。
 * 所有请求同源，前缀 /__mock/api，JSON 收发。
 *
 * 代码分区：
 *   1. 常量与工具函数
 *   2. API 封装层
 *   3. 全局状态
 *   4. 顶栏 / 状态条 / 提示条
 *   5. meta 与接口列表
 *   6. 选中与新建
 *   7. 编辑器骨架与基本信息表单
 *   8. 入参表格 / 路径参数
 *   9. 响应头表格
 *  10. 高亮 JSON 编辑器
 *  11. 菜单（Mock 字段 / 常用模板）
 *  12. 预览
 *  13. 接口自测面板
 *  14. 保存 / 删除 / 复制 / 启用开关
 *  15. 导入 / 导出
 *  16. 事件绑定与启动
 * ========================================================================== */
'use strict';

(function () {

  /* ==========================================================================
   * 1. 常量与工具函数
   * ========================================================================== */

  var API_BASE = '/__mock/api';
  var NEW_ID = '__new__';

  var FALLBACK_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'ALL'];

  var FALLBACK_RESPONSE_TYPES = [
    { value: 'json', label: 'JSON' },
    { value: 'text', label: '纯文本' },
    { value: 'html', label: 'HTML' }
  ];

  /* sample：真实示例值（入参表格 🎲 用）；placeholder：Mock 表达式（响应体编辑器「插入 Mock 字段」用） */
  var FALLBACK_FIELD_TYPES = [
    { value: 'string', label: '字符串', sample: '示例文本', placeholder: '{{@word}}' },
    { value: 'number', label: '数字', sample: '42', placeholder: '{{@int(1,100)}}' },
    { value: 'boolean', label: '布尔', sample: 'true', placeholder: '{{@bool}}' },
    { value: 'array', label: '数组', sample: '[]', placeholder: '' },
    { value: 'object', label: '对象', sample: '{}', placeholder: '' }
  ];

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  /** 创建元素：h('div', {class:'x', text:'y', dataset:{...}, onclick:fn}, children) */
  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === undefined || value === null) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') { Object.keys(value).forEach(function (k) { node.dataset[k] = value[k]; }); }
        else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden' || key === 'value') node[key] = value;
        else node.setAttribute(key, value);
      });
    }
    if (children !== undefined && children !== null) {
      (Array.isArray(children) ? children : [children]).forEach(function (child) {
        if (child === null || child === undefined || child === false) return;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      });
    }
    return node;
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (ch) {
      if (ch === '&') return '&amp;';
      if (ch === '<') return '&lt;';
      if (ch === '>') return '&gt;';
      if (ch === '"') return '&quot;';
      return '&#39;';
    });
  }

  function clone(value) {
    if (value === undefined || value === null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
  }

  function randomToken(length) {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    for (var i = 0; i < (length || 6); i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function methodClass(method) {
    var m = String(method || 'GET').toUpperCase();
    if (FALLBACK_METHODS.indexOf(m) === -1) return 'm-all';
    return 'm-' + m.toLowerCase();
  }

  /** JSON 语法高亮：输入原文，输出转义后的 HTML */
  var JSON_TOKEN_RE = /("(?:\\.|[^"\\])*")([ \t]*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],:])/g;

  function highlightJson(text) {
    var src = text === undefined || text === null ? '' : String(text);
    var out = '';
    var last = 0;
    var match;
    JSON_TOKEN_RE.lastIndex = 0;
    while ((match = JSON_TOKEN_RE.exec(src)) !== null) {
      if (match.index > last) out += escapeHtml(src.slice(last, match.index));
      if (match[1] !== undefined) {
        out += '<span class="' + (match[2] !== undefined ? 'tok-key' : 'tok-str') + '">' + escapeHtml(match[1]) + '</span>';
        if (match[2] !== undefined) out += '<span class="tok-punc">' + escapeHtml(match[2]) + '</span>';
      } else if (match[3] !== undefined) {
        out += '<span class="tok-bool">' + match[3] + '</span>';
      } else if (match[4] !== undefined) {
        out += '<span class="tok-num">' + match[4] + '</span>';
      } else if (match[5] !== undefined) {
        out += '<span class="tok-punc">' + escapeHtml(match[5]) + '</span>';
      }
      last = match.index + match[0].length;
      if (match[0].length === 0) JSON_TOKEN_RE.lastIndex++;
    }
    if (last < src.length) out += escapeHtml(src.slice(last));
    return out;
  }

  /** 从 JSON.parse 的报错里提取行号与可读信息 */
  function jsonErrorInfo(text, err) {
    var raw = err && err.message ? String(err.message) : String(err);
    var line = null;
    var column = null;

    var lineMatch = raw.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (lineMatch) {
      line = Number(lineMatch[1]);
      column = Number(lineMatch[2]);
    }
    if (line === null) {
      var posMatch = raw.match(/position\s+(\d+)/i);
      if (posMatch) {
        var pos = Math.min(Number(posMatch[1]), String(text || '').length);
        var lines = String(text || '').slice(0, pos).split('\n');
        line = lines.length;
        column = lines[lines.length - 1].length + 1;
      }
    }

    var message = raw
      .replace(/\s*in JSON at position \d+.*$/i, '')
      .replace(/\s*at position \d+.*$/i, '')
      .replace(/^JSON\.parse:\s*/i, '')
      .trim();
    if (!message) message = 'JSON 语法错误';

    return { line: line === null ? 1 : line, column: column, message: message };
  }

  /** 解析路径里的 :参数 */
  function pathParamNames(path) {
    var names = [];
    var re = /:([A-Za-z0-9_]+)/g;
    var match;
    while ((match = re.exec(String(path || ''))) !== null) {
      if (names.indexOf(match[1]) === -1) names.push(match[1]);
    }
    return names;
  }

  /* ==========================================================================
   * 2. API 封装层
   * ========================================================================== */

  var api = {
    request: function (method, path, body) {
      var init = { method: method, headers: { Accept: 'application/json' } };
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      return fetch(API_BASE + path, init).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          if (text) {
            try { data = JSON.parse(text); } catch (e) { data = null; }
          }
          if (!data || typeof data !== 'object') {
            throw new Error('服务端返回了非 JSON 响应（HTTP ' + res.status + '）');
          }
          if (!res.ok || data.ok === false) {
            throw new Error(data.error || ('请求失败（HTTP ' + res.status + '）'));
          }
          return data;
        });
      }, function (err) {
        throw new Error('网络请求失败：' + (err && err.message ? err.message : err));
      });
    },

    meta: function () { return api.request('GET', '/meta'); },
    listRoutes: function () { return api.request('GET', '/routes'); },
    createRoute: function (route) { return api.request('POST', '/routes', { route: route }); },
    updateRoute: function (id, route) { return api.request('PUT', '/routes/' + encodeURIComponent(id), { route: route }); },
    deleteRoute: function (id) { return api.request('DELETE', '/routes/' + encodeURIComponent(id)); },
    duplicateRoute: function (id) { return api.request('POST', '/routes/' + encodeURIComponent(id) + '/duplicate'); },
    preview: function (route) { return api.request('POST', '/preview', { route: route }); },
    importCurl: function (text) { return api.request('POST', '/import/curl', { text: text }); },
    importOpenapi: function (text) { return api.request('POST', '/import/openapi', { text: text }); },
    importRoutes: function (routes) { return api.request('POST', '/import/routes', { routes: routes }); },
    exportRoutes: function () { return api.request('GET', '/export'); }
  };

  /* ==========================================================================
   * 3. 全局状态
   * ========================================================================== */

  var state = {
    meta: null,            // 后端 meta
    routes: [],            // 服务端已存在的路由
    selectedId: null,      // 当前选中：route.id 或 NEW_ID 或 null
    draft: null,           // 当前编辑中的 Route 副本（新接口 id 为 ''）
    dirty: false,          // 是否有未保存改动
    activeParamTab: 'query',
    selftest: null,        // 自测面板状态
    importKind: null,      // 'curl' | 'openapi'
    importParsed: null     // 解析出来的待导入路由
  };

  function emptyRoute() {
    return {
      id: '',
      name: '',
      group: '默认',
      desc: '',
      enabled: true,
      method: 'GET',
      path: '/api/example',
      status: 200,
      delay: 0,
      cors: false,
      headers: [],
      query: [],
      body: [],
      responseType: 'json',
      response: '{\n  "code": 0,\n  "msg": "ok",\n  "data": {}\n}'
    };
  }

  function normalizeFieldList(list) {
    if (!Array.isArray(list)) return [];
    return list.map(function (item) {
      var field = item && typeof item === 'object' ? item : {};
      return {
        key: field.key === undefined || field.key === null ? '' : String(field.key),
        type: field.type ? String(field.type) : 'string',
        required: field.required === true,
        desc: field.desc === undefined || field.desc === null ? '' : String(field.desc),
        example: field.example === undefined || field.example === null ? '' : String(field.example)
      };
    });
  }

  function normalizeHeaderList(list) {
    if (!Array.isArray(list)) return [];
    return list.map(function (item) {
      var header = item && typeof item === 'object' ? item : {};
      return {
        key: header.key === undefined || header.key === null ? '' : String(header.key),
        value: header.value === undefined || header.value === null ? '' : String(header.value)
      };
    });
  }

  function normalizeRoute(route) {
    var out = Object.assign(emptyRoute(), route && typeof route === 'object' ? route : {});
    out.id = out.id ? String(out.id) : '';
    out.name = out.name === undefined || out.name === null ? '' : String(out.name);
    out.group = out.group === undefined || out.group === null ? '' : String(out.group);
    out.desc = out.desc === undefined || out.desc === null ? '' : String(out.desc);
    out.enabled = out.enabled !== false;
    out.cors = out.cors === true;
    out.method = out.method ? String(out.method).toUpperCase() : 'GET';
    out.path = out.path === undefined || out.path === null ? '' : String(out.path);
    out.status = Number(out.status);
    if (!isFinite(out.status) || out.status <= 0) out.status = 200;
    out.delay = Number(out.delay);
    if (!isFinite(out.delay) || out.delay < 0) out.delay = 0;
    out.headers = normalizeHeaderList(out.headers);
    out.query = normalizeFieldList(out.query);
    out.body = normalizeFieldList(out.body);
    out.responseType = out.responseType ? String(out.responseType) : 'json';
    out.response = out.response === undefined || out.response === null ? '' : String(out.response);
    return out;
  }

  /* meta 取值辅助（后端字段缺失时用兜底值，保证界面可用） */

  function metaMethods() {
    var list = state.meta && Array.isArray(state.meta.methods) && state.meta.methods.length
      ? state.meta.methods : FALLBACK_METHODS;
    return list.map(function (item) {
      if (typeof item === 'string') return item;
      if (item && item.value) return String(item.value);
      return String(item);
    }).filter(Boolean);
  }

  function metaResponseTypes() {
    var list = state.meta && Array.isArray(state.meta.responseTypes) && state.meta.responseTypes.length
      ? state.meta.responseTypes : FALLBACK_RESPONSE_TYPES;
    return list.map(function (item) {
      if (typeof item === 'string') return { value: item, label: item };
      return { value: String(item.value), label: item.label ? String(item.label) : String(item.value) };
    });
  }

  function metaFieldTypes() {
    var list = state.meta && Array.isArray(state.meta.fieldTypes) && state.meta.fieldTypes.length
      ? state.meta.fieldTypes : FALLBACK_FIELD_TYPES;
    return list.map(function (item) {
      if (typeof item === 'string') return { value: item, label: item, sample: '', placeholder: '' };
      return {
        value: String(item.value),
        label: item.label ? String(item.label) : String(item.value),
        sample: item.sample === undefined || item.sample === null ? '' : String(item.sample),
        placeholder: item.placeholder === undefined || item.placeholder === null ? '' : String(item.placeholder)
      };
    });
  }

  function metaPlaceholders() {
    return state.meta && Array.isArray(state.meta.placeholders) ? state.meta.placeholders : [];
  }

  function metaTemplates() {
    return state.meta && Array.isArray(state.meta.templates) ? state.meta.templates : [];
  }

  /* ==========================================================================
   * 4. 顶栏 / 状态条 / 提示条
   * ========================================================================== */

  function showBanner(message) {
    var banner = $('#banner');
    if (!banner) return;
    banner.textContent = message;
    banner.hidden = false;
  }

  function hideBanner() {
    var banner = $('#banner');
    if (banner) banner.hidden = true;
  }

  function setConfigPath(path) {
    var node = $('#configPath');
    if (!node) return;
    var text = path ? String(path) : '';
    node.textContent = text;
    node.title = text;
    node.hidden = !text;
  }

  /** kind: idle | dirty | saving | saved | error */
  function setStatus(kind, text) {
    var dot = $('#statusDot');
    var label = $('#statusText');
    if (dot) dot.className = 'status-dot' + (kind && kind !== 'idle' ? ' is-' + kind : '');
    if (label) {
      label.textContent = text;
      label.className = kind === 'error' ? 'is-error' : (kind === 'saved' ? 'is-saved' : '');
    }
  }

  /* ==========================================================================
   * 5. meta 与接口列表
   * ========================================================================== */

  function loadMeta() {
    return api.meta().then(function (data) {
      state.meta = {
        configPath: data.configPath ? String(data.configPath) : '',
        version: data.version ? String(data.version) : '',
        methods: Array.isArray(data.methods) ? data.methods : FALLBACK_METHODS,
        responseTypes: Array.isArray(data.responseTypes) ? data.responseTypes : FALLBACK_RESPONSE_TYPES,
        fieldTypes: Array.isArray(data.fieldTypes) ? data.fieldTypes : FALLBACK_FIELD_TYPES,
        placeholders: Array.isArray(data.placeholders) ? data.placeholders : [],
        templates: Array.isArray(data.templates) ? data.templates : []
      };
      setConfigPath(state.meta.configPath);
      var right = $('#statusRight');
      if (right) right.textContent = state.meta.version ? 'v' + state.meta.version : '';
      hideBanner();
      return true;
    }, function (err) {
      state.meta = {
        configPath: '', version: '',
        methods: FALLBACK_METHODS,
        responseTypes: FALLBACK_RESPONSE_TYPES,
        fieldTypes: FALLBACK_FIELD_TYPES,
        placeholders: [], templates: []
      };
      showBanner('无法连接到管理台后端：' + err.message + '（请求 ' + API_BASE + '/meta 失败）');
      return false;
    });
  }

  function reloadRoutes() {
    return api.listRoutes().then(function (data) {
      state.routes = (Array.isArray(data.routes) ? data.routes : []).map(normalizeRoute);
      if (data.configPath) setConfigPath(data.configPath);
      renderList();
      return state.routes;
    });
  }

  /** 列表数据源：服务端路由 + 正在新建的草稿 */
  function listSource() {
    var list = state.routes.slice();
    if (state.draft && !state.draft.id) list = list.concat([state.draft]);
    var keyword = $('#searchInput') ? String($('#searchInput').value || '').trim().toLowerCase() : '';
    if (!keyword) return list;
    return list.filter(function (route) {
      var name = String(route.name || '').toLowerCase();
      var path = String(route.path || '').toLowerCase();
      return name.indexOf(keyword) !== -1 || path.indexOf(keyword) !== -1;
    });
  }

  function isCurrentDraft(route) {
    if (!state.draft) return false;
    if (route.id) return route.id === state.draft.id;
    return !state.draft.id;
  }

  function routeElementKey(route) {
    return route.id ? route.id : NEW_ID;
  }

  function currentRouteElement() {
    if (!state.draft) return null;
    var key = routeElementKey(state.draft);
    var found = null;
    $$('.route-item').forEach(function (node) {
      if (node.dataset.id === key) found = node;
    });
    return found;
  }

  function routeItem(route) {
    var item = h('div', {
      class: 'route-item' + (state.selectedId === routeElementKey(route) ? ' is-active' : ''),
      dataset: { id: routeElementKey(route) }
    });

    var top = h('div', { class: 'route-item-top' });
    top.appendChild(h('span', { class: 'method-badge ' + methodClass(route.method), text: route.method || 'GET' }));
    top.appendChild(h('span', {
      class: 'route-item-path',
      text: route.path || '(未填写路径)',
      title: route.path || ''
    }));

    var switchLabel = h('label', {
      class: 'switch switch-sm',
      title: route.enabled !== false ? '已启用，点击停用' : '已停用，点击启用'
    });
    var checkbox = h('input', { type: 'checkbox', checked: route.enabled !== false });
    checkbox.addEventListener('click', function (event) { event.stopPropagation(); });
    checkbox.addEventListener('change', function (event) {
      event.stopPropagation();
      toggleRouteEnabled(route, checkbox.checked);
    });
    switchLabel.appendChild(checkbox);
    switchLabel.appendChild(h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' })));
    top.appendChild(switchLabel);
    item.appendChild(top);

    var bottom = h('div', { class: 'route-item-bottom' });
    var nameWrap = h('span', { class: 'route-item-name' });
    nameWrap.appendChild(h('span', {
      class: 'dirty-dot' + (state.dirty && isCurrentDraft(route) ? '' : ' hidden'),
      title: '有未保存改动'
    }));
    nameWrap.appendChild(document.createTextNode(route.name || '未命名接口'));
    bottom.appendChild(nameWrap);
    item.appendChild(bottom);

    item.addEventListener('click', function () { selectRoute(routeElementKey(route)); });
    return item;
  }

  function renderList() {
    var wrap = $('#routeList');
    if (!wrap) return;
    wrap.textContent = '';

    var list = listSource();
    if (!list.length) {
      wrap.appendChild(h('div', { class: 'empty-hint' },
        state.routes.length
          ? '没有匹配的接口'
          : '还没有接口，点击「新建接口」开始'));
      return;
    }

    var groups = [];
    var map = {};
    list.forEach(function (route) {
      var name = route.group || '未分组';
      if (!map[name]) { map[name] = []; groups.push(name); }
      map[name].push(route);
    });

    groups.forEach(function (name) {
      wrap.appendChild(h('div', { class: 'group-title' }, [
        h('span', { text: name }),
        h('span', { class: 'group-count', text: String(map[name].length) })
      ]));
      map[name].forEach(function (route) { wrap.appendChild(routeItem(route)); });
    });
  }

  /** 只更新当前项显示（避免每次按键都重建整个列表） */
  function refreshCurrentListItem() {
    var item = currentRouteElement();
    if (!item || !state.draft) return;

    var badge = item.querySelector('.method-badge');
    if (badge) {
      badge.textContent = state.draft.method || 'GET';
      badge.className = 'method-badge ' + methodClass(state.draft.method);
    }
    var path = item.querySelector('.route-item-path');
    if (path) {
      path.textContent = state.draft.path || '(未填写路径)';
      path.title = state.draft.path || '';
    }
    var name = item.querySelector('.route-item-name');
    if (name) {
      var dot = name.querySelector('.dirty-dot');
      name.textContent = '';
      if (dot) {
        dot.classList.toggle('hidden', !state.dirty);
        name.appendChild(dot);
      }
      name.appendChild(document.createTextNode(state.draft.name || '未命名接口'));
    }
    var checkbox = item.querySelector('input[type="checkbox"]');
    if (checkbox) checkbox.checked = state.draft.enabled !== false;
  }

  function updateDirtyUI() {
    var saveBtn = $('#btnSave');
    if (saveBtn) saveBtn.classList.toggle('is-dirty', state.dirty);
    refreshCurrentListItem();
  }

  function markDirty() {
    if (!state.dirty) {
      state.dirty = true;
      setStatus('dirty', '未保存改动');
    }
    updateDirtyUI();
  }

  /* ==========================================================================
   * 6. 选中与新建
   * ========================================================================== */

  function confirmDiscard(message) {
    if (!state.dirty) return true;
    return window.confirm(message || '当前接口有未保存的改动，继续操作将丢失这些改动。确定继续吗？');
  }

  function selectRoute(id) {
    if (state.selectedId === id) return;
    if (!confirmDiscard('当前接口有未保存的改动，切换后将丢失。确定切换吗？')) {
      renderList();
      return;
    }

    var route;
    if (id === NEW_ID) {
      route = state.draft && !state.draft.id ? state.draft : emptyRoute();
    } else {
      route = null;
      state.routes.forEach(function (item) { if (item.id === id) route = item; });
    }
    if (!route) return;

    state.selectedId = id;
    state.draft = normalizeRoute(clone(route));
    state.dirty = false;
    state.activeParamTab = 'query';
    resetSelfTest();
    renderList();
    renderEditor();
    updateDirtyUI();
    setStatus('idle', '就绪');
  }

  function newRoute() {
    if (!confirmDiscard('当前接口有未保存的改动，新建将丢失这些改动。确定新建吗？')) return;
    state.selectedId = NEW_ID;
    state.draft = emptyRoute();
    state.dirty = false;
    state.activeParamTab = 'query';
    resetSelfTest();
    renderList();
    renderEditor();
    updateDirtyUI();
    setStatus('idle', '新建接口（尚未保存）');
    var nameInput = $('#f-name');
    if (nameInput) nameInput.focus();
  }

  /* ==========================================================================
   * 7. 编辑器骨架与基本信息表单
   * ========================================================================== */

  var EDITOR_SKELETON = [
    '<div class="editor-head">',
    '  <div class="editor-head-main">',
    '    <span class="editor-title" id="editorTitle">接口编辑</span>',
    '    <span class="editor-sub" id="editorSub"></span>',
    '  </div>',
    '  <div class="editor-head-actions">',
    '    <button class="btn btn-sm" id="btnDuplicate" type="button">复制</button>',
    '    <button class="btn btn-sm btn-danger" id="btnDelete" type="button">删除</button>',
    '  </div>',
    '</div>',

    '<section class="card">',
    '  <div class="card-head"><h2>基本信息</h2></div>',
    '  <div class="card-body">',
    '    <div class="grid grid-2">',
    '      <label class="field"><span class="field-label">名称</span>',
    '        <input id="f-name" class="input" type="text" placeholder="例如：获取用户列表" autocomplete="off"></label>',
    '      <label class="field"><span class="field-label">分组</span>',
    '        <input id="f-group" class="input" type="text" placeholder="例如：用户" list="groupList" autocomplete="off">',
    '        <datalist id="groupList"></datalist></label>',
    '    </div>',
    '    <div class="grid grid-3">',
    '      <label class="field"><span class="field-label">请求方法</span>',
    '        <select id="f-method" class="input"></select></label>',
    '      <label class="field"><span class="field-label">路径</span>',
    '        <input id="f-path" class="input mono" type="text" placeholder="/api/users/:id" autocomplete="off" spellcheck="false"></label>',
    '      <label class="field field-switch"><span class="field-label">启用</span>',
    '        <span class="switch"><input id="f-enabled" type="checkbox">',
    '        <span class="switch-track"><span class="switch-thumb"></span></span></span></label>',
    '    </div>',
    '    <label class="field"><span class="field-label">备注说明</span>',
    '      <input id="f-desc" class="input" type="text" placeholder="可选，仅用于备注" autocomplete="off"></label>',
    '    <div id="pathParams" class="path-params" hidden></div>',
    '  </div>',
    '</section>',

    '<section class="card">',
    '  <div class="card-head">',
    '    <h2>入参</h2>',
    '    <div class="tabs" id="paramTabs">',
    '      <button class="tab is-active" data-tab="query" type="button">Query</button>',
    '      <button class="tab" data-tab="body" type="button">Body</button>',
    '    </div>',
    '  </div>',
    '  <div class="card-body">',
    '    <div class="table-wrap">',
    '      <table class="param-table">',
    '        <thead><tr>',
    '          <th style="width:22%">字段名</th>',
    '          <th style="width:14%">类型</th>',
    '          <th style="width:9%" class="cell-center">必填</th>',
    '          <th style="width:23%">说明</th>',
    '          <th style="width:24%">示例值</th>',
    '          <th style="width:8%"></th>',
    '        </tr></thead>',
    '        <tbody id="paramTableBody"></tbody>',
    '      </table>',
    '    </div>',
    '    <div class="row-actions"><button class="btn btn-sm" id="btnAddField" type="button">+ 添加字段</button></div>',
    '  </div>',
    '</section>',

    '<section class="card">',
    '  <div class="card-head"><h2>出参</h2></div>',
    '  <div class="card-body">',
    '    <div class="grid grid-4">',
    '      <label class="field"><span class="field-label">响应类型</span>',
    '        <select id="f-responseType" class="input"></select></label>',
    '      <label class="field"><span class="field-label">状态码</span>',
    '        <input id="f-status" class="input" type="number" min="100" max="599" step="1"></label>',
    '      <label class="field field-switch"><span class="field-label">CORS</span>',
    '        <span class="switch"><input id="f-cors" type="checkbox">',
    '        <span class="switch-track"><span class="switch-thumb"></span></span></span></label>',
    '      <label class="field"><span class="field-label">响应延时 (ms)</span>',
    '        <input id="f-delay" class="input" type="number" min="0" step="10"></label>',
    '    </div>',
    '    <div class="sub-head"><span>自定义响应头</span>',
    '      <button class="btn btn-xs" id="btnAddHeader" type="button">+ 添加</button></div>',
    '    <div class="table-wrap">',
    '      <table class="param-table">',
    '        <thead><tr><th style="width:38%">Header</th><th style="width:54%">值</th><th style="width:8%"></th></tr></thead>',
    '        <tbody id="headerTableBody"></tbody>',
    '      </table>',
    '    </div>',
    '    <div class="sub-head"><span>响应体</span><span id="jsonStatus" class="json-status"></span></div>',
    '    <div class="editor-toolbar">',
    '      <button class="btn btn-xs" id="btnFormat" type="button">格式化</button>',
    '      <button class="btn btn-xs" id="btnCompress" type="button">压缩</button>',
    '      <span class="menu-wrap">',
    '        <button class="btn btn-xs" id="btnMockMenu" type="button" aria-haspopup="true">插入 Mock 字段 &#9662;</button>',
    '        <span class="menu" id="mockMenu" hidden></span>',
    '      </span>',
    '      <button class="btn btn-xs" id="btnRepeat" type="button">插入列表模板</button>',
    '      <span class="menu-wrap">',
    '        <button class="btn btn-xs" id="btnTplMenu" type="button" aria-haspopup="true">常用模板 &#9662;</button>',
    '        <span class="menu" id="tplMenu" hidden></span>',
    '      </span>',
    '      <span class="toolbar-hint">Ctrl/Cmd + Enter 格式化 · Tab 插入两个空格</span>',
    '    </div>',
    '    <div class="editor-scroll">',
    '      <pre class="editor-highlight" id="editorHighlight" aria-hidden="true"></pre>',
    '      <textarea class="editor-input" id="editorInput" spellcheck="false" wrap="off" autocapitalize="off" autocomplete="off" placeholder="在此编写响应体，支持 {{@word}} 之类的 Mock 占位符"></textarea>',
    '    </div>',
    '  </div>',
    '</section>',

    '<section class="card">',
    '  <div class="card-head"><h2>预览</h2>',
    '    <button class="btn btn-sm" id="btnPreview" type="button">渲染一次</button></div>',
    '  <div class="card-body"><div id="previewResult" class="preview-result"></div></div>',
    '</section>',

    '<section class="card">',
    '  <div class="card-head"><h2>接口自测</h2>',
    '    <span class="muted small">用浏览器真实请求该地址</span></div>',
    '  <div class="card-body"><div id="selftestWrap"></div></div>',
    '</section>'
  ].join('\n');

  function emptyPane() {
    var box = h('div', { class: 'empty-pane' });
    box.appendChild(h('div', { class: 'empty-icon', text: '🗂' }));
    if (!state.routes.length) {
      box.appendChild(h('p', { class: 'empty-title', text: '还没有接口，点击「新建接口」开始' }));
      box.appendChild(h('p', { class: 'muted small', text: '也可以从 cURL 命令或 OpenAPI 文档批量导入。' }));
    } else {
      box.appendChild(h('p', { class: 'empty-title', text: '请选择左侧的接口进行编辑' }));
      box.appendChild(h('p', { class: 'muted small', text: '或点击「新建接口」创建一个新的 Mock 接口。' }));
    }
    return box;
  }

  function renderEditor() {
    var pane = $('#editorPane');
    if (!pane) return;
    pane.textContent = '';

    if (!state.draft) {
      pane.appendChild(emptyPane());
      return;
    }

    var root = h('div', { class: 'editor-root' });
    /* 静态骨架，不插入任何用户数据 → innerHTML 安全；所有用户数据随后用 value / textContent 填充 */
    root.innerHTML = EDITOR_SKELETON;
    pane.appendChild(root);

    bindEditorEvents();
    fillEditorForm();
    renderParamTable();
    renderPathParams();
    renderHeaderTable();
    renderMockMenu();
    renderTemplateMenu();
    resetEditorComponent();
    renderSelfTest();
    renderPreviewPlaceholder();
  }

  function fillEditorForm() {
    var draft = state.draft;
    var title = $('#editorTitle');
    var sub = $('#editorSub');
    if (title) title.textContent = draft.id ? '编辑接口' : '新建接口';
    if (sub) sub.textContent = draft.id ? draft.id : '尚未保存';

    $('#f-name').value = draft.name || '';
    $('#f-group').value = draft.group || '';
    $('#f-path').value = draft.path || '';
    $('#f-desc').value = draft.desc || '';
    $('#f-enabled').checked = draft.enabled !== false;
    $('#f-status').value = String(draft.status);
    $('#f-delay').value = String(draft.delay);
    $('#f-cors').checked = draft.cors === true;

    var methodSelect = $('#f-method');
    var methods = metaMethods();
    methodSelect.textContent = '';
    methods.forEach(function (method) {
      methodSelect.appendChild(h('option', { value: method, text: method, selected: method === draft.method }));
    });
    if (methods.indexOf(draft.method) === -1) {
      methodSelect.appendChild(h('option', { value: draft.method, text: draft.method, selected: true }));
    }

    var responseSelect = $('#f-responseType');
    var types = metaResponseTypes();
    responseSelect.textContent = '';
    types.forEach(function (type) {
      responseSelect.appendChild(h('option', { value: type.value, text: type.label, selected: type.value === draft.responseType }));
    });
    if (!types.some(function (type) { return type.value === draft.responseType; })) {
      responseSelect.appendChild(h('option', { value: draft.responseType, text: draft.responseType, selected: true }));
    }

    var datalist = $('#groupList');
    datalist.textContent = '';
    var groups = [];
    state.routes.forEach(function (route) {
      if (route.group && groups.indexOf(route.group) === -1) groups.push(route.group);
    });
    groups.forEach(function (group) { datalist.appendChild(h('option', { value: group })); });

    if ($('#btnDuplicate')) $('#btnDuplicate').disabled = !draft.id;
  }

  function bindEditorEvents() {
    var draft = state.draft;

    /* --- 基本信息 --- */
    $('#f-name').addEventListener('input', function (event) { draft.name = event.target.value; markDirty(); });
    $('#f-group').addEventListener('input', function (event) { draft.group = event.target.value; markDirty(); });
    $('#f-group').addEventListener('change', function () { renderList(); });
    $('#f-desc').addEventListener('input', function (event) { draft.desc = event.target.value; markDirty(); });
    $('#f-enabled').addEventListener('change', function (event) { draft.enabled = event.target.checked; markDirty(); });

    $('#f-method').addEventListener('change', function (event) {
      draft.method = event.target.value;
      markDirty();
    });

    $('#f-path').addEventListener('input', function (event) {
      draft.path = event.target.value;
      markDirty();
      renderPathParams();
    });
    $('#f-path').addEventListener('change', function () {
      if (state.selftest && !state.selftest.urlTouched) {
        state.selftest.url = urlFromPath(draft);
        var input = $('#st-url');
        if (input) input.value = state.selftest.url;
      }
    });

    /* --- 出参基本项 --- */
    $('#f-status').addEventListener('input', function (event) {
      var value = Number(event.target.value);
      draft.status = isFinite(value) && value > 0 ? value : 200;
      markDirty();
    });
    $('#f-delay').addEventListener('input', function (event) {
      var value = Number(event.target.value);
      draft.delay = isFinite(value) && value >= 0 ? value : 0;
      markDirty();
    });
    $('#f-cors').addEventListener('change', function (event) { draft.cors = event.target.checked; markDirty(); });
    $('#f-responseType').addEventListener('change', function (event) {
      draft.responseType = event.target.value;
      markDirty();
      updateEditorStatus();
    });

    /* --- 入参 tabs / 添加字段 --- */
    $$('#paramTabs .tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        state.activeParamTab = tab.dataset.tab === 'body' ? 'body' : 'query';
        renderParamTable();
      });
    });
    $('#btnAddField').addEventListener('click', function () {
      var list = draft[state.activeParamTab];
      list.push({ key: '', type: 'string', required: false, desc: '', example: '' });
      renderParamTable();
      renderPathParams();
      resetSelfTest();
      renderSelfTest();
      markDirty();
      var rows = $$('#paramTableBody tr');
      var last = rows[rows.length - 1];
      var input = last ? last.querySelector('input[data-role="key"]') : null;
      if (input) input.focus();
    });

    /* --- 响应头 --- */
    $('#btnAddHeader').addEventListener('click', function () {
      draft.headers.push({ key: '', value: '' });
      renderHeaderTable();
      markDirty();
      var rows = $$('#headerTableBody tr');
      var last = rows[rows.length - 1];
      var input = last ? last.querySelector('input[data-role="header-key"]') : null;
      if (input) input.focus();
    });

    /* --- 编辑器工具栏 --- */
    $('#btnFormat').addEventListener('click', formatResponse);
    $('#btnCompress').addEventListener('click', compressResponse);
    $('#btnRepeat').addEventListener('click', insertRepeatTemplate);
    $('#btnMockMenu').addEventListener('click', function (event) {
      event.stopPropagation();
      toggleMenu('#mockMenu');
    });
    $('#btnTplMenu').addEventListener('click', function (event) {
      event.stopPropagation();
      toggleMenu('#tplMenu');
    });

    /* --- 预览 --- */
    $('#btnPreview').addEventListener('click', doPreview);

    /* --- 复制 / 删除 --- */
    $('#btnDuplicate').addEventListener('click', duplicateCurrent);
    $('#btnDelete').addEventListener('click', deleteCurrent);
  }

  /* ==========================================================================
   * 8. 入参表格 / 路径参数
   * ========================================================================== */

  function fieldTypeOptions(selected) {
    var select = h('select', { class: 'input input-sm' });
    var found = false;
    metaFieldTypes().forEach(function (type) {
      if (type.value === selected) found = true;
      select.appendChild(h('option', { value: type.value, text: type.label, selected: type.value === selected }));
    });
    if (!found && selected) {
      select.appendChild(h('option', { value: selected, text: selected, selected: true }));
    }
    return select;
  }

  function paramRow(field, index, tab) {
    var row = h('tr');

    var keyInput = h('input', { class: 'input input-sm mono', type: 'text', placeholder: '字段名' });
    keyInput.value = field.key || '';
    keyInput.dataset.role = 'key';
    keyInput.addEventListener('input', function () {
      state.draft[tab][index].key = keyInput.value;
      markDirty();
    });
    keyInput.addEventListener('change', function () {
      resetSelfTest();
      renderSelfTest();
    });
    row.appendChild(h('td', null, keyInput));

    var typeSelect = fieldTypeOptions(field.type);
    typeSelect.addEventListener('change', function () {
      state.draft[tab][index].type = typeSelect.value;
      markDirty();
    });
    row.appendChild(h('td', null, typeSelect));

    var required = h('input', { type: 'checkbox', checked: field.required === true });
    required.addEventListener('change', function () {
      state.draft[tab][index].required = required.checked;
      markDirty();
    });
    row.appendChild(h('td', { class: 'cell-center' }, required));

    var descInput = h('input', { class: 'input input-sm', type: 'text', placeholder: '说明' });
    descInput.value = field.desc || '';
    descInput.addEventListener('input', function () {
      state.draft[tab][index].desc = descInput.value;
      markDirty();
    });
    row.appendChild(h('td', null, descInput));

    var exampleInput = h('input', { class: 'input input-sm mono', type: 'text', placeholder: '示例值' });
    exampleInput.value = field.example || '';
    exampleInput.dataset.role = 'example';
    exampleInput.addEventListener('input', function () {
      state.draft[tab][index].example = exampleInput.value;
      markDirty();
    });
    var dice = h('button', { class: 'dice-btn', type: 'button', title: '按字段类型生成示例值' }, '🎲');
    dice.addEventListener('click', function () {
      var value = exampleFromType(state.draft[tab][index].type);
      state.draft[tab][index].example = value;
      exampleInput.value = value;
      markDirty();
    });
    row.appendChild(h('td', null, h('span', { class: 'example-wrap' }, [exampleInput, dice])));

    var remove = h('button', { class: 'icon-btn', type: 'button', title: '删除该字段' }, '✕');
    remove.addEventListener('click', function () {
      state.draft[tab].splice(index, 1);
      renderParamTable();
      renderPathParams();
      resetSelfTest();
      renderSelfTest();
      markDirty();
    });
    row.appendChild(h('td', { class: 'cell-center' }, remove));

    return row;
  }

  function renderParamTable() {
    var body = $('#paramTableBody');
    if (!body || !state.draft) return;
    body.textContent = '';

    var tab = state.activeParamTab === 'body' ? 'body' : 'query';
    var list = state.draft[tab] || [];

    $$('#paramTabs .tab').forEach(function (node) {
      node.classList.toggle('is-active', node.dataset.tab === tab);
    });

    if (!list.length) {
      body.appendChild(h('tr', { class: 'empty-row' }, h('td', {
        colspan: '6',
        class: 'muted small center'
      }, tab === 'query' ? '还没有 Query 字段，点击下方「+ 添加字段」' : '还没有 Body 字段，点击下方「+ 添加字段」')));
      return;
    }

    list.forEach(function (field, index) { body.appendChild(paramRow(field, index, tab)); });
  }

  function renderPathParams() {
    var box = $('#pathParams');
    if (!box || !state.draft) return;
    box.textContent = '';

    var names = pathParamNames(state.draft.path);
    if (!names.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.appendChild(h('div', { class: 'path-params-title', text: '路径参数（只读）' }));
    var chips = h('div', { class: 'chips' });
    names.forEach(function (name) { chips.appendChild(h('span', { class: 'chip mono', text: ':' + name })); });
    box.appendChild(chips);
    box.appendChild(h('div', { class: 'muted small', text: '这些路径参数会在「接口自测」面板中自动填值。' }));
  }

  /* ==========================================================================
   * 9. 响应头表格
   * ========================================================================== */

  function headerRow(header, index) {
    var row = h('tr');

    var keyInput = h('input', { class: 'input input-sm mono', type: 'text', placeholder: '例如 X-Token' });
    keyInput.value = header.key || '';
    keyInput.dataset.role = 'header-key';
    keyInput.addEventListener('input', function () {
      state.draft.headers[index].key = keyInput.value;
      markDirty();
    });
    row.appendChild(h('td', null, keyInput));

    var valueInput = h('input', { class: 'input input-sm mono', type: 'text', placeholder: '值' });
    valueInput.value = header.value || '';
    valueInput.addEventListener('input', function () {
      state.draft.headers[index].value = valueInput.value;
      markDirty();
    });
    row.appendChild(h('td', null, valueInput));

    var remove = h('button', { class: 'icon-btn', type: 'button', title: '删除该 Header' }, '✕');
    remove.addEventListener('click', function () {
      state.draft.headers.splice(index, 1);
      renderHeaderTable();
      markDirty();
    });
    row.appendChild(h('td', { class: 'cell-center' }, remove));
    return row;
  }

  function renderHeaderTable() {
    var body = $('#headerTableBody');
    if (!body || !state.draft) return;
    body.textContent = '';

    var list = state.draft.headers || [];
    if (!list.length) {
      body.appendChild(h('tr', { class: 'empty-row' }, h('td', {
        colspan: '3',
        class: 'muted small center'
      }, '没有自定义响应头')));
      return;
    }
    list.forEach(function (header, index) { body.appendChild(headerRow(header, index)); });
  }

  /* ==========================================================================
   * 10. 高亮 JSON 编辑器
   * ========================================================================== */

  function editorElements() {
    return { textarea: $('#editorInput'), highlight: $('#editorHighlight'), status: $('#jsonStatus') };
  }

  function updateEditorStatus() {
    var status = $('#jsonStatus');
    if (!status || !state.draft) return;
    var text = $('#editorInput') ? $('#editorInput').value : state.draft.response;

    if (state.draft.responseType !== 'json') {
      status.className = 'json-status is-neutral';
      status.textContent = '纯文本模式（不做 JSON 校验）';
      status.title = '';
      return;
    }
    if (!String(text || '').trim()) {
      status.className = 'json-status is-neutral';
      status.textContent = '（空响应体）';
      status.title = '';
      return;
    }
    try {
      JSON.parse(text);
      status.className = 'json-status is-ok';
      status.textContent = '✓ JSON 合法';
      status.title = '';
    } catch (err) {
      var info = jsonErrorInfo(text, err);
      status.className = 'json-status is-bad';
      status.textContent = '✗ 第 ' + info.line + ' 行: ' + info.message;
      status.title = info.message;
    }
  }

  function editorSync() {
    var els = editorElements();
    if (!els.textarea || !els.highlight) return;
    els.highlight.innerHTML = highlightJson(els.textarea.value) + '\n';
    els.highlight.scrollTop = els.textarea.scrollTop;
    els.highlight.scrollLeft = els.textarea.scrollLeft;
    updateEditorStatus();
  }

  function resetEditorComponent() {
    var els = editorElements();
    if (!els.textarea) return;
    els.textarea.value = state.draft.response === undefined || state.draft.response === null
      ? '' : String(state.draft.response);

    els.textarea.addEventListener('input', function () {
      state.draft.response = els.textarea.value;
      markDirty();
      editorSync();
    });
    els.textarea.addEventListener('scroll', function () {
      els.highlight.scrollTop = els.textarea.scrollTop;
      els.highlight.scrollLeft = els.textarea.scrollLeft;
    });
    els.textarea.addEventListener('keydown', onEditorKeydown);

    editorSync();
  }

  function onEditorKeydown(event) {
    var textarea = event.target;

    if (event.key === 'Tab') {
      event.preventDefault();
      editorInsert('  ');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      formatResponse();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
      event.preventDefault();
      saveCurrent();
    }
  }

  /** 在光标处插入文本 */
  function editorInsert(text) {
    var textarea = $('#editorInput');
    if (!textarea || !state.draft) return;
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    var caret = start + text.length;
    textarea.selectionStart = caret;
    textarea.selectionEnd = caret;
    textarea.focus();
    state.draft.response = textarea.value;
    markDirty();
    editorSync();
  }

  /** 用 prefix / suffix 包裹选中内容（无选中时用 fallback） */
  function editorWrapSelection(prefix, suffix, fallback) {
    var textarea = $('#editorInput');
    if (!textarea || !state.draft) return;
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var selected = textarea.value.slice(start, end);
    var inner = selected || fallback;
    textarea.value = textarea.value.slice(0, start) + prefix + inner + suffix + textarea.value.slice(end);
    textarea.selectionStart = start + prefix.length;
    textarea.selectionEnd = start + prefix.length + inner.length;
    textarea.focus();
    state.draft.response = textarea.value;
    markDirty();
    editorSync();
  }

  function replaceResponseText(text) {
    var textarea = $('#editorInput');
    if (!textarea || !state.draft) return;
    textarea.value = text === undefined || text === null ? '' : String(text);
    state.draft.response = textarea.value;
    markDirty();
    editorSync();
  }

  function formatResponse() {
    var textarea = $('#editorInput');
    if (!textarea || !state.draft) return;
    if (state.draft.responseType !== 'json') {
      setStatus('error', '当前响应类型不是 JSON，无法格式化');
      return;
    }
    try {
      textarea.value = JSON.stringify(JSON.parse(textarea.value), null, 2);
      state.draft.response = textarea.value;
      markDirty();
      editorSync();
      setStatus('idle', '已格式化');
    } catch (err) {
      var info = jsonErrorInfo(textarea.value, err);
      setStatus('error', 'JSON 解析失败：第 ' + info.line + ' 行 ' + info.message);
    }
  }

  function compressResponse() {
    var textarea = $('#editorInput');
    if (!textarea || !state.draft) return;
    if (state.draft.responseType !== 'json') {
      setStatus('error', '当前响应类型不是 JSON，无法压缩');
      return;
    }
    try {
      textarea.value = JSON.stringify(JSON.parse(textarea.value));
      state.draft.response = textarea.value;
      markDirty();
      editorSync();
      setStatus('idle', '已压缩');
    } catch (err) {
      var info = jsonErrorInfo(textarea.value, err);
      setStatus('error', 'JSON 解析失败：第 ' + info.line + ' 行 ' + info.message);
    }
  }

  /** 列表模板：{{@repeat(3)}} ... {{/repeat}}（与后端 mock-engine 语法一致） */
  var REPEAT_SAMPLE = [
    '  {',
    '    "id": "{{@id}}",',
    '    "name": "{{@cname}}",',
    '    "createdAt": "{{@datetime}}"',
    '  }'
  ].join('\n');

  function insertRepeatTemplate() {
    var textarea = $('#editorInput');
    if (!textarea) return;
    if (textarea.selectionStart === textarea.selectionEnd) {
      editorWrapSelection('{{@repeat(3)}}\n' + REPEAT_SAMPLE + '\n', '\n{{/repeat}}', '');
    } else {
      editorWrapSelection('{{@repeat(3)}}\n', '\n{{/repeat}}', '');
    }
  }

  /* ==========================================================================
   * 11. 菜单（Mock 字段 / 常用模板）
   * ========================================================================== */

  function hideMenus() {
    $$('.menu').forEach(function (menu) { menu.hidden = true; });
  }

  function toggleMenu(selector) {
    var menu = $(selector);
    if (!menu) return;
    var willShow = menu.hidden;
    hideMenus();
    menu.hidden = !willShow;
  }

  /** 占位符插入文本：优先 example，其次 insert，最后按名字拼 */
  function placeholderText(item) {
    var raw;
    if (item.example !== undefined && item.example !== null && item.example !== '') raw = item.example;
    else if (item.insert !== undefined && item.insert !== null && item.insert !== '') raw = item.insert;
    else raw = '{{@' + item.name + '}}';
    return typeof raw === 'string' ? raw : JSON.stringify(raw);
  }

  function renderMockMenu() {
    var menu = $('#mockMenu');
    if (!menu) return;
    menu.textContent = '';

    var list = metaPlaceholders();
    if (!list.length) {
      menu.appendChild(h('div', { class: 'menu-empty', text: '后端未提供 Mock 字段' }));
      return;
    }

    var groups = [];
    var map = {};
    list.forEach(function (item) {
      var group = item.group || '其他';
      if (!map[group]) { map[group] = []; groups.push(group); }
      map[group].push(item);
    });

    groups.forEach(function (group) {
      menu.appendChild(h('div', { class: 'menu-group', text: group }));
      map[group].forEach(function (item) {
        var label = String(item.name || '') + (item.args ? '(' + item.args + ')' : '');
        var button = h('button', { class: 'menu-item', type: 'button', title: item.desc || '' });
        button.appendChild(h('span', { class: 'mono', text: label }));
        if (item.desc) button.appendChild(h('span', { class: 'menu-desc', text: item.desc }));
        button.addEventListener('click', function () {
          hideMenus();
          editorInsert(placeholderText(item));
        });
        menu.appendChild(button);
      });
    });
  }

  function renderTemplateMenu() {
    var menu = $('#tplMenu');
    if (!menu) return;
    menu.textContent = '';

    var list = metaTemplates();
    if (!list.length) {
      menu.appendChild(h('div', { class: 'menu-empty', text: '后端未提供常用模板' }));
      return;
    }
    list.forEach(function (item) {
      var button = h('button', { class: 'menu-item', type: 'button' });
      button.appendChild(h('span', { text: item.name || '未命名模板' }));
      button.addEventListener('click', function () {
        hideMenus();
        if (!window.confirm('确定用模板「' + (item.name || '未命名模板') + '」替换当前响应体吗？')) return;
        replaceResponseText(item.response);
      });
      menu.appendChild(button);
    });
  }

  /* ==========================================================================
   * 12. 预览
   * ========================================================================== */

  function renderPreviewPlaceholder() {
    var box = $('#previewResult');
    if (!box) return;
    box.textContent = '';
    box.appendChild(h('span', { class: 'muted small', text: '点击「渲染一次」查看服务端渲染结果。' }));
  }

  function doPreview() {
    var button = $('#btnPreview');
    var box = $('#previewResult');
    if (!button || !box || !state.draft) return;

    syncDraftFromDom();
    button.disabled = true;
    button.textContent = '渲染中…';
    box.textContent = '';
    box.appendChild(h('span', { class: 'muted small', text: '渲染中…' }));

    api.preview(state.draft).then(function (data) {
      box.textContent = '';

      if (Array.isArray(data.warnings) && data.warnings.length) {
        var warn = h('div', { class: 'alert alert-warn' });
        warn.appendChild(h('div', { class: 'alert-title', text: '未识别的占位符 / 提示（' + data.warnings.length + '）' }));
        var ul = h('ul');
        data.warnings.forEach(function (item) { ul.appendChild(h('li', { text: String(item) })); });
        warn.appendChild(ul);
        box.appendChild(warn);
      }

      if (state.draft.responseType === 'json' && data.jsonValid === false) {
        box.appendChild(h('div', {
          class: 'alert alert-error',
          text: '✗ JSON 不合法：' + (data.jsonError || '未知错误')
        }));
      }

      var rendered = data.rendered === undefined || data.rendered === null ? '' : String(data.rendered);
      var pre = h('pre', { class: 'code-block' });
      var highlighted = false;
      if (state.draft.responseType === 'json' && data.jsonValid !== false) {
        try {
          pre.innerHTML = highlightJson(JSON.stringify(JSON.parse(rendered), null, 2));
          highlighted = true;
        } catch (e) { highlighted = false; }
      }
      if (!highlighted) pre.textContent = rendered;
      box.appendChild(pre);
    }, function (err) {
      box.textContent = '';
      box.appendChild(h('div', { class: 'alert alert-error', text: '预览失败：' + err.message }));
    }).then(function () {
      button.disabled = false;
      button.textContent = '渲染一次';
    });
  }

  /* ==========================================================================
   * 13. 接口自测面板
   * ========================================================================== */

  /**
   * 入参表格 🎲 按钮：按字段类型生成「真实示例值」。
   * 取值顺序 sample → placeholder → ''（旧后端没有 sample 字段时优雅降级，不报错）。
   */
  function exampleFromType(type) {
    var found = null;
    metaFieldTypes().forEach(function (item) { if (item.value === type) found = item; });
    if (!found) return '';
    if (found.sample) return found.sample;
    if (found.placeholder) return found.placeholder;
    return '';
  }

  function fallbackExample(field) {
    if (field.example !== undefined && field.example !== null && String(field.example) !== '') {
      return String(field.example);
    }
    var type = field.type || 'string';
    if (type === 'number') return String(randomInt(1, 100));
    if (type === 'boolean') return 'true';
    if (type === 'array') return '[]';
    if (type === 'object') return '{}';
    return randomToken(8);
  }

  /** 把 /api/users/:id 里的 :id 换成示例值 */
  function urlFromPath(route) {
    var path = String(route.path || '');
    if (!path) return '/';
    return path.replace(/:([A-Za-z0-9_]+)/g, function (full, name) {
      var fields = (route.query || []).concat(route.body || []);
      var matched = null;
      fields.forEach(function (field) { if (field.key === name) matched = field; });
      if (matched) return encodeURIComponent(fallbackExample(matched));
      return String(randomInt(100, 999));
    });
  }

  function resetSelfTest() {
    var draft = state.draft;
    if (!draft) { state.selftest = null; return; }
    state.selftest = {
      method: draft.method === 'ALL' ? 'GET' : draft.method,
      url: urlFromPath(draft),
      urlTouched: false,
      query: (draft.query || []).map(function (field) {
        return { key: field.key || '', enabled: !!field.key, value: fallbackExample(field) };
      }),
      bodyMode: 'form',
      body: (draft.body || []).map(function (field) {
        return { key: field.key || '', value: fallbackExample(field) };
      }),
      bodyRaw: JSON.stringify(bodyFormToObject({
        body: (draft.body || []).map(function (field) {
          return { key: field.key || '', value: fallbackExample(field) };
        })
      }, draft), null, 2),
      sending: false,
      result: null
    };
  }

  function coerceValue(type, value) {
    var text = value === undefined || value === null ? '' : String(value);
    if (type === 'number' || type === 'price') {
      var num = Number(text);
      return text.trim() !== '' && isFinite(num) ? num : text;
    }
    if (type === 'boolean') return text === 'true' || text === '1';
    if (type === 'array' || type === 'object') {
      try { return JSON.parse(text); } catch (e) { return text; }
    }
    return text;
  }

  function bodyFormToObject(selfTest, draft) {
    var out = {};
    (selfTest.body || []).forEach(function (row, index) {
      if (!row.key) return;
      var field = (draft.body || [])[index] || {};
      out[row.key] = coerceValue(field.type, row.value);
    });
    return out;
  }

  function buildRequestUrl(selfTest) {
    var params = (selfTest.query || [])
      .filter(function (row) { return row.enabled && row.key; })
      .map(function (row) {
        return encodeURIComponent(row.key) + '=' + encodeURIComponent(row.value === undefined || row.value === null ? '' : row.value);
      });
    var url = selfTest.url || '/';
    if (params.length) url += (url.indexOf('?') === -1 ? '?' : '&') + params.join('&');
    return url;
  }

  function renderSelfTest() {
    var wrap = $('#selftestWrap');
    var selfTest = state.selftest;
    if (!wrap || !selfTest || !state.draft) return;
    wrap.textContent = '';

    /* 请求行 */
    var bar = h('div', { class: 'selftest-bar' });
    var methodSelect = h('select', { class: 'input input-sm mono selftest-method' });
    var selfTestMethods = metaMethods();
    selfTestMethods.forEach(function (method) {
      methodSelect.appendChild(h('option', { value: method, text: method, selected: method === selfTest.method }));
    });
    if (selfTestMethods.indexOf(selfTest.method) === -1) {
      methodSelect.appendChild(h('option', { value: selfTest.method, text: selfTest.method, selected: true }));
    }
    methodSelect.addEventListener('change', function () {
      selfTest.method = methodSelect.value;
      renderSelfTest();
    });

    var urlInput = h('input', { class: 'input input-sm mono', type: 'text', placeholder: '/api/users/1', id: 'st-url' });
    urlInput.value = selfTest.url;
    urlInput.addEventListener('input', function () {
      selfTest.url = urlInput.value;
      selfTest.urlTouched = true;
    });

    var sendButton = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: selfTest.sending ? '发送中…' : '发送' });
    sendButton.disabled = !!selfTest.sending;
    sendButton.addEventListener('click', sendSelfTest);

    bar.appendChild(methodSelect);
    bar.appendChild(urlInput);
    bar.appendChild(sendButton);
    wrap.appendChild(bar);

    /* Query 参数表 */
    if (selfTest.query.length) {
      var querySection = h('div', { class: 'selftest-section' });
      querySection.appendChild(h('div', { class: 'selftest-section-title' }, 'Query 参数'));
      var queryTable = h('table', { class: 'param-table' });
      queryTable.appendChild(h('thead', null, h('tr', null, [
        h('th', { style: 'width:9%', class: 'cell-center' }, '启用'),
        h('th', { style: 'width:36%' }, '参数名'),
        h('th', { style: 'width:55%' }, '值')
      ])));
      var queryBody = h('tbody');
      selfTest.query.forEach(function (row, index) {
        var tr = h('tr');
        var checkbox = h('input', { type: 'checkbox', checked: row.enabled });
        checkbox.addEventListener('change', function () { selfTest.query[index].enabled = checkbox.checked; });
        tr.appendChild(h('td', { class: 'cell-center' }, checkbox));
        tr.appendChild(h('td', null, h('span', { class: 'mono small', text: row.key || '(未命名字段)' })));
        var valueInput = h('input', { class: 'input input-sm mono', type: 'text' });
        valueInput.value = row.value;
        valueInput.addEventListener('input', function () { selfTest.query[index].value = valueInput.value; });
        tr.appendChild(h('td', null, valueInput));
        queryBody.appendChild(tr);
      });
      queryTable.appendChild(queryBody);
      querySection.appendChild(h('div', { class: 'table-wrap' }, queryTable));
      wrap.appendChild(querySection);
    }

    /* Body */
    var bodySection = h('div', { class: 'selftest-section' });
    var bodyTitle = h('div', { class: 'selftest-section-title' }, '请求体');
    var modeWrap = h('span', { class: 'body-mode' });
    [['form', '表单'], ['raw', '原始文本']].forEach(function (pair) {
      var tab = h('button', {
        class: 'tab' + (selfTest.bodyMode === pair[0] ? ' is-active' : ''),
        type: 'button',
        text: pair[1]
      });
      tab.addEventListener('click', function () { switchBodyMode(pair[0]); });
      modeWrap.appendChild(tab);
    });
    bodyTitle.appendChild(modeWrap);
    bodySection.appendChild(bodyTitle);

    if (selfTest.bodyMode === 'raw') {
      var rawArea = h('textarea', { class: 'input mono', rows: '8' });
      rawArea.value = selfTest.bodyRaw;
      rawArea.addEventListener('input', function () { selfTest.bodyRaw = rawArea.value; });
      bodySection.appendChild(rawArea);
    } else if (selfTest.body.length) {
      var bodyTable = h('table', { class: 'param-table' });
      bodyTable.appendChild(h('thead', null, h('tr', null, [
        h('th', { style: 'width:36%' }, '字段名'),
        h('th', { style: 'width:64%' }, '值')
      ])));
      var bodyBody = h('tbody');
      selfTest.body.forEach(function (row, index) {
        var tr = h('tr');
        tr.appendChild(h('td', null, h('span', { class: 'mono small', text: row.key || '(未命名字段)' })));
        var valueInput = h('input', { class: 'input input-sm mono', type: 'text' });
        valueInput.value = row.value;
        valueInput.addEventListener('input', function () { selfTest.body[index].value = valueInput.value; });
        tr.appendChild(h('td', null, valueInput));
        bodyBody.appendChild(tr);
      });
      bodyTable.appendChild(bodyBody);
      bodySection.appendChild(h('div', { class: 'table-wrap' }, bodyTable));
    } else {
      bodySection.appendChild(h('div', { class: 'muted small', text: '该接口没有定义 Body 字段。' }));
    }
    wrap.appendChild(bodySection);

    wrap.appendChild(renderSelfTestResult());
  }

  function switchBodyMode(mode) {
    var selfTest = state.selftest;
    if (!selfTest || !state.draft) return;
    if (mode === selfTest.bodyMode) return;

    if (mode === 'raw') {
      selfTest.bodyRaw = JSON.stringify(bodyFormToObject(selfTest, state.draft), null, 2);
      selfTest.bodyMode = 'raw';
    } else {
      try {
        var parsed = JSON.parse(selfTest.bodyRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          selfTest.body = selfTest.body.map(function (row) {
            return {
              key: row.key,
              value: parsed[row.key] === undefined
                ? row.value
                : (typeof parsed[row.key] === 'string' ? parsed[row.key] : JSON.stringify(parsed[row.key]))
            };
          });
        } else {
          setStatus('error', '原始文本不是 JSON 对象，无法转回表单');
        }
      } catch (err) {
        setStatus('error', '原始文本不是合法 JSON，无法转回表单');
      }
      selfTest.bodyMode = 'form';
    }
    renderSelfTest();
  }

  function renderSelfTestResult() {
    var selfTest = state.selftest;
    var box = h('div', { class: 'selftest-result' });
    if (!selfTest || !selfTest.result) {
      box.appendChild(h('span', { class: 'muted small', text: '尚未发送请求。' }));
      return box;
    }

    var result = selfTest.result;
    if (!result.ok) {
      box.appendChild(h('div', { class: 'alert alert-error', text: '请求失败：' + result.error }));
      return box;
    }

    var head = h('div', { class: 'result-head' });
    head.appendChild(h('span', {
      class: 'status-pill ' + (result.status < 400 ? 'ok' : 'err'),
      text: String(result.status) + (result.statusText ? ' ' + result.statusText : '')
    }));
    head.appendChild(h('span', { class: 'muted small mono', text: result.url }));
    head.appendChild(h('span', { class: 'muted small', text: '耗时 ' + result.elapsed.toFixed(1) + ' ms' }));
    box.appendChild(head);

    var details = h('details', { class: 'result-headers' });
    details.appendChild(h('summary', null, '响应头（' + result.headers.length + '）'));
    var headerList = h('ul', { class: 'header-list' });
    result.headers.forEach(function (pair) {
      headerList.appendChild(h('li', { class: 'mono small', text: pair[0] + ': ' + pair[1] }));
    });
    details.appendChild(headerList);
    box.appendChild(details);

    var pre = h('pre', { class: 'code-block' });
    var pretty = null;
    try { pretty = JSON.stringify(JSON.parse(result.body), null, 2); } catch (e) { pretty = null; }
    if (pretty !== null) pre.innerHTML = highlightJson(pretty);
    else pre.textContent = result.body;
    box.appendChild(pre);

    return box;
  }

  function sendSelfTest() {
    var selfTest = state.selftest;
    if (!selfTest || selfTest.sending) return;

    selfTest.sending = true;
    selfTest.result = null;
    renderSelfTest();

    var started = performance.now();
    var url = buildRequestUrl(selfTest);
    var init = { method: selfTest.method, headers: {} };

    if (!/^(GET|HEAD)$/i.test(selfTest.method)) {
      var bodyText = selfTest.bodyMode === 'raw'
        ? selfTest.bodyRaw
        : JSON.stringify(bodyFormToObject(selfTest, state.draft), null, 2);
      if (bodyText && bodyText.trim() !== '') {
        init.headers['Content-Type'] = 'application/json';
        init.body = bodyText;
      }
    }

    fetch(url, init).then(function (res) {
      var headers = [];
      res.headers.forEach(function (value, key) { headers.push([key, value]); });
      return res.text().then(function (text) {
        return { status: res.status, statusText: res.statusText, headers: headers, body: text };
      });
    }).then(function (data) {
      selfTest.result = {
        ok: true,
        status: data.status,
        statusText: data.statusText,
        elapsed: performance.now() - started,
        headers: data.headers,
        body: data.body,
        url: url
      };
    }, function (err) {
      selfTest.result = {
        ok: false,
        error: (err && err.message ? err.message : String(err)) + '（跨域或后端未启动时会失败）',
        elapsed: performance.now() - started
      };
    }).then(function () {
      selfTest.sending = false;
      renderSelfTest();
    });
  }

  /* ==========================================================================
   * 14. 保存 / 删除 / 复制 / 启用开关
   * ========================================================================== */

  /** 把 DOM 上的值同步回 draft（防止个别字段未触发 input） */
  function syncDraftFromDom() {
    if (!state.draft) return;
    var draft = state.draft;
    if ($('#f-name')) draft.name = $('#f-name').value;
    if ($('#f-group')) draft.group = $('#f-group').value;
    if ($('#f-path')) draft.path = $('#f-path').value;
    if ($('#f-desc')) draft.desc = $('#f-desc').value;
    if ($('#f-method')) draft.method = $('#f-method').value;
    if ($('#f-enabled')) draft.enabled = $('#f-enabled').checked;
    if ($('#f-status')) draft.status = Number($('#f-status').value) || 200;
    if ($('#f-delay')) draft.delay = Number($('#f-delay').value) || 0;
    if ($('#f-cors')) draft.cors = $('#f-cors').checked;
    if ($('#f-responseType')) draft.responseType = $('#f-responseType').value;
    if ($('#editorInput')) draft.response = $('#editorInput').value;
  }

  function saveCurrent() {
    if (!state.draft) return Promise.resolve();
    syncDraftFromDom();
    var draft = state.draft;

    if (!String(draft.path || '').trim()) {
      setStatus('error', '保存失败: 接口路径不能为空');
      if ($('#f-path')) $('#f-path').focus();
      return Promise.resolve();
    }

    setStatus('saving', '保存中…');
    var request = draft.id ? api.updateRoute(draft.id, draft) : api.createRoute(draft);

    return request.then(function (data) {
      var saved = data.route ? normalizeRoute(data.route) : null;
      return reloadRoutes().then(function () {
        if (saved && saved.id) {
          state.selectedId = saved.id;
          state.draft = saved;
        }
        state.dirty = false;
        resetSelfTest();
        renderList();
        renderEditor();
        updateDirtyUI();
        setStatus('saved', '已保存');
      });
    }, function (err) {
      setStatus('error', '保存失败: ' + err.message);
    });
  }

  function deleteCurrent() {
    if (!state.draft) return;
    var draft = state.draft;

    if (!draft.id) {
      if (!window.confirm('放弃这个尚未保存的接口吗？')) return;
      state.draft = null;
      state.selectedId = null;
      state.dirty = false;
      state.selftest = null;
      renderList();
      renderEditor();
      updateDirtyUI();
      setStatus('idle', '已放弃新建');
      return;
    }

    if (!window.confirm('确定删除接口「' + (draft.name || draft.path || draft.id) + '」吗？此操作不可撤销。')) return;

    setStatus('saving', '删除中…');
    api.deleteRoute(draft.id).then(function () {
      state.draft = null;
      state.selectedId = null;
      state.dirty = false;
      state.selftest = null;
      return reloadRoutes();
    }).then(function () {
      renderList();
      renderEditor();
      updateDirtyUI();
      setStatus('saved', '已删除');
    }, function (err) {
      setStatus('error', '删除失败: ' + err.message);
    });
  }

  function duplicateCurrent() {
    if (!state.draft || !state.draft.id) return;
    setStatus('saving', '复制中…');
    api.duplicateRoute(state.draft.id).then(function (data) {
      var created = data.route ? normalizeRoute(data.route) : null;
      return reloadRoutes().then(function () {
        if (created && created.id) {
          state.selectedId = created.id;
          state.draft = created;
          state.dirty = false;
          resetSelfTest();
        }
        renderList();
        renderEditor();
        updateDirtyUI();
        setStatus('saved', '已复制');
      });
    }, function (err) {
      setStatus('error', '复制失败: ' + err.message);
    });
  }

  /** 左侧列表的启用开关：直接保存该条 */
  function toggleRouteEnabled(route, enabled) {
    if (!state.draft || route !== state.draft) {
      var payload = normalizeRoute(clone(route));
      payload.enabled = enabled;
      setStatus('saving', '保存中…');
      var request = payload.id ? api.updateRoute(payload.id, payload) : api.createRoute(payload);
      request.then(function () {
        return reloadRoutes();
      }).then(function () {
        updateDirtyUI();
        setStatus('saved', enabled ? '已启用' : '已停用');
      }, function (err) {
        setStatus('error', '保存失败: ' + err.message);
        renderList();
      });
      return;
    }

    state.draft.enabled = enabled;
    if ($('#f-enabled')) $('#f-enabled').checked = enabled;
    markDirty();
    saveCurrent();
  }

  /* ==========================================================================
   * 15. 导入 / 导出
   * ========================================================================== */

  function openImport(kind) {
    state.importKind = kind;
    state.importParsed = null;

    var title = $('#modalTitle');
    if (title) title.textContent = kind === 'curl' ? '从 cURL 导入' : '从 OpenAPI 导入';

    var textarea = $('#importText');
    textarea.value = '';
    textarea.placeholder = kind === 'curl'
      ? '粘贴 curl 命令，例如：\ncurl -X POST https://example.com/api/users \\\n  -H "Content-Type: application/json" \\\n  -d \'{"name":"张三"}\''
      : '粘贴 OpenAPI / Swagger 文档内容（支持的 YAML 或 JSON 文本）';

    var errorBox = $('#importError');
    errorBox.hidden = true;
    errorBox.textContent = '';
    $('#importPreview').textContent = '';
    $('#importHint').textContent = '';
    $('#btnImportConfirm').disabled = true;
    $('#modalOverlay').hidden = false;
    textarea.focus();
  }

  function closeImport() {
    $('#modalOverlay').hidden = true;
    state.importParsed = null;
    $('#importPreview').textContent = '';
    var errorBox = $('#importError');
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function showImportError(message) {
    var errorBox = $('#importError');
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function renderImportPreview(routes) {
    var box = $('#importPreview');
    box.textContent = '';
    box.appendChild(h('div', { class: 'import-preview-title', text: '将创建以下 ' + routes.length + ' 个接口：' }));
    var list = h('ul', { class: 'import-list' });
    routes.forEach(function (route) {
      var item = h('li');
      item.appendChild(h('span', { class: 'method-badge ' + methodClass(route.method), text: route.method || 'GET' }));
      item.appendChild(h('span', { class: 'mono', text: route.path || '(无路径)' }));
      item.appendChild(h('span', { class: 'muted', text: route.name || '' }));
      list.appendChild(item);
    });
    box.appendChild(list);
  }

  function parseImport() {
    var text = $('#importText').value;
    var errorBox = $('#importError');
    errorBox.hidden = true;
    $('#importPreview').textContent = '';
    $('#btnImportConfirm').disabled = true;
    state.importParsed = null;

    if (!String(text || '').trim()) {
      showImportError('请先粘贴要导入的内容');
      return;
    }

    var button = $('#btnImportParse');
    button.disabled = true;
    button.textContent = '解析中…';

    var request = state.importKind === 'curl' ? api.importCurl(text) : api.importOpenapi(text);
    request.then(function (data) {
      var routes = Array.isArray(data.routes) ? data.routes : [];
      if (!routes.length) {
        showImportError('解析完成，但没有得到任何接口');
        return;
      }
      state.importParsed = routes;
      renderImportPreview(routes);
      $('#importHint').textContent = '共解析出 ' + routes.length + ' 个接口';
      $('#btnImportConfirm').disabled = false;
    }, function (err) {
      showImportError('解析失败：' + err.message);
    }).then(function () {
      button.disabled = false;
      button.textContent = '解析预览';
    });
  }

  function confirmImport() {
    var routes = state.importParsed;
    if (!routes || !routes.length) return;

    var button = $('#btnImportConfirm');
    button.disabled = true;
    button.textContent = '导入中…';

    api.importRoutes(routes).then(function (data) {
      var created = Array.isArray(data.routes) ? data.routes : [];
      var first = created.length ? normalizeRoute(created[0]) : null;
      closeImport();
      return reloadRoutes().then(function () {
        if (first && first.id) {
          state.selectedId = first.id;
          state.draft = first;
          state.dirty = false;
          resetSelfTest();
        }
        renderList();
        renderEditor();
        updateDirtyUI();
        setStatus('saved', '已导入 ' + (created.length || routes.length) + ' 个接口');
      });
    }, function (err) {
      showImportError('导入失败：' + err.message);
    }).then(function () {
      button.disabled = false;
      button.textContent = '确认导入';
    });
  }

  function exportRoutes() {
    setStatus('saving', '导出中…');
    api.exportRoutes().then(function (data) {
      var filename = data.filename ? String(data.filename) : 'routes.json';
      var json = data.json === undefined || data.json === null ? '' : String(data.json);
      var blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      setStatus('saved', '已导出 ' + filename);
    }, function (err) {
      setStatus('error', '导出失败: ' + err.message);
    });
  }

  /* ==========================================================================
   * 16. 事件绑定与启动
   * ========================================================================== */

  function bindGlobalEvents() {
    $('#btnNew').addEventListener('click', newRoute);
    $('#btnSave').addEventListener('click', function () { saveCurrent(); });
    $('#btnExport').addEventListener('click', exportRoutes);
    $('#btnImportCurl').addEventListener('click', function () { openImport('curl'); });
    $('#btnImportOpenapi').addEventListener('click', function () { openImport('openapi'); });

    var search = $('#searchInput');
    search.addEventListener('input', renderList);

    /* 弹窗 */
    $('#modalClose').addEventListener('click', closeImport);
    $('#btnImportCancel').addEventListener('click', closeImport);
    $('#btnImportParse').addEventListener('click', parseImport);
    $('#btnImportConfirm').addEventListener('click', confirmImport);
    $('#modalOverlay').addEventListener('click', function (event) {
      if (event.target === $('#modalOverlay')) closeImport();
    });

    /* 全局快捷键 & 关闭浮层 */
    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        saveCurrent();
        return;
      }
      if (event.key === 'Escape') {
        hideMenus();
        if (!$('#modalOverlay').hidden) closeImport();
      }
    });

    document.addEventListener('click', function (event) {
      if (!event.target.closest || !event.target.closest('.menu-wrap')) hideMenus();
    });

    window.addEventListener('beforeunload', function (event) {
      if (!state.dirty) return undefined;
      event.preventDefault();
      event.returnValue = '';
      return '';
    });
  }

  function boot() {
    bindGlobalEvents();
    hideMenus();
    setStatus('idle', '加载中…');

    loadMeta().then(function (ok) {
      return reloadRoutes().then(function () {
        if (!ok) showBanner('无法连接到管理台后端（' + API_BASE + '），请确认服务已启动。');
      }, function (err) {
        if (ok) showBanner('加载接口列表失败：' + err.message);
      });
    }).then(function () {
      renderList();
      renderEditor();
      updateDirtyUI();
      if (!state.dirty) setStatus('idle', '就绪');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
