import { h } from 'vue';
import { useGatewayStore } from '@/stores/gateway';
import { t } from '@/i18n';

/**
 * 分享链接的地址拼装（第 4 节 接口文档分享）。
 *
 * **必须用云端地址拼**，和 `utils/mock.js` 的 `mockBaseUrl()` 是同一个道理：
 * 打开链接的人是从云端看文档的，而客户端里 `window.location.origin` 是
 * `127.0.0.1:47321`（本机网关），拿它拼出来的链接发出去别人打不开。
 *
 * 拼出来的形状是 `<云端地址>/#/share/<链接串>`（hash 路由，服务端不用为前端路由做任何事）。
 */

/** 云端地址（去掉末尾的斜杠）。直接打开云端时就是当前 origin */
export function shareBaseUrl() {
  const gateway = useGatewayStore();
  const base = gateway.isGateway && gateway.cloudUrl ? gateway.cloudUrl : window.location.origin;
  return String(base).replace(/\/+$/, '');
}

/** 完整的分享链接 */
export function shareUrl(id) {
  return shareBaseUrl() + '/#/share/' + String(id || '');
}

/** 这个项目的 mock 地址前缀（服务端给的是 `/mock-<项目ID>`，根项目是空串） */
export function mockUrlFor(mockPath) {
  return shareBaseUrl() + String(mockPath || '');
}

/* ------------------------------------------------------------------ 分享页「试一试」 */

/** 开头的 `{{变量}}`（可能连着好几个，比如 `{{baseUrl}}{{version}}/api`） */
const LEADING_PLACEHOLDER = /^(?:\s*\{\{\s*[^{}]*?\s*\}\})+/;

/** 协议：`https://` 这种 */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** 协议相对地址 `//host/path` 里的主机那一段 */
const PROTOCOL_RELATIVE_HOST = /^\/\/[^/?#]*/;

/**
 * 从接口地址里取出「路径」部分：去掉协议、主机和开头的 `{{baseUrl}}` 这类变量，
 * 再去掉查询串和 `#`。
 *
 * 和服务端 `lib/url-utils.js` 的 `deriveMockPath()` 是同一个思路，但**不把
 * `{{name}}` 换成 `:name`** —— 分享页要的是「原样的路径 + 用表里的值替换」，换成 `:name`
 * 反而多绕一步。前端没有现成的这份，分享页只有这里用得到，所以放在这里。
 *
 * `{{host}}/api/users/{{id}}?x=1` → `/api/users/{{id}}`
 * `https://a.com:8080/v1/x`      → `/v1/x`
 * `users/42`                     → `/users/42`（没有协议和主机时按纯路径处理）
 *
 * @param {string} url
 * @returns {string} 一定以 `/` 开头
 */
export function pathOfUrl(url) {
  let text = String(url === undefined || url === null ? '' : url).trim();

  text = text.replace(LEADING_PLACEHOLDER, '');
  text = text.replace(SCHEME, '').replace(PROTOCOL_RELATIVE_HOST, '');

  // 剩下的「host/path」写法：第一段就是主机名，一起切掉；`{{host}}/api` 这种
  // 开头是变量的已经在上一步处理掉了，这里只管字面主机
  if (text.charAt(0) !== '/' && text.indexOf('{{') !== 0) {
    const slash = text.search(/[/?#]/);
    text = slash === -1 ? '' : text.slice(slash);
  }

  text = text.split('?')[0].split('#')[0];
  if (text.charAt(0) !== '/') text = '/' + text;
  return text;
}

/**
 * 用表里的值替换路径里的参数：`:id` 和 `{id}` 两种写法都认。
 *
 * 值为空的参数**原样留着**（`/users/:id`）—— 替换成空串会变成 `/users//x`，
 * 同样调不通，但看不出来是哪儿少了东西。
 *
 * @param {string} path
 * @param {Array<{key: string, value: any, enabled?: boolean}>} rows
 */
export function fillPathParams(path, rows) {
  const values = {};
  (rows || []).forEach(function (row) {
    if (!row || row.enabled === false) return;
    const key = String(row.key === undefined || row.key === null ? '' : row.key).trim();
    const value = row.value === undefined || row.value === null ? '' : String(row.value);
    if (!key || !value) return;
    values[key] = value;
  });

  return String(path || '').replace(/(^|\/):([\w-]+)/g, function (whole, head, name) {
    return values[name] === undefined ? whole : head + encodeURIComponent(values[name]);
  }).replace(/\{([\w-]+)\}/g, function (whole, name) {
    return values[name] === undefined ? whole : encodeURIComponent(values[name]);
  });
}

/** 把启用的查询参数拼成 `a=1&b=2`（值和键都按 URL 规则编码） */
export function queryStringOf(rows) {
  return (rows || []).filter(function (row) {
    if (!row || row.enabled === false) return false;
    return String(row.key === undefined || row.key === null ? '' : row.key).trim() !== '';
  }).map(function (row) {
    const key = String(row.key).trim();
    const value = row.value === undefined || row.value === null ? '' : String(row.value);
    return encodeURIComponent(key) + '=' + encodeURIComponent(value);
  }).join('&');
}

/**
 * 「试一试」面板最终要请求的地址：Mock 前缀 + 替换过路径参数的路径 + 查询串。
 *
 * @param {string} mockBase 这一页的 Mock 地址前缀（`mockUrlFor(doc.mockPath)`）
 * @param {string} url 文档里那个接口地址
 * @param {Array} pathRows 路径参数表
 * @param {Array} queryRows 查询参数表
 */
export function mockTargetUrl(mockBase, url, pathRows, queryRows) {
  const base = String(mockBase || '').replace(/\/+$/, '');
  const path = fillPathParams(pathOfUrl(url), pathRows);
  const query = queryStringOf(queryRows);
  return base + path + (query ? '?' + query : '');
}

/* ------------------------------------------------------------------ 展示文案 */

/**
 * 分享链接列表的展示文案。**两处都要用**（项目设置里的「分享链接」和头像菜单里的
 * 「我的分享」），所以放这里 —— 两边各写一份的话，有效期那一列的写法迟早会不一样。
 */

function pad(value) {
  return String(value).padStart(2, '0');
}

/** 时间戳 → `2026-10-03 12:30`；空值 / 坏值给空串 */
export function formatShareTime(ts) {
  if (!ts) return '';
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return '';
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/** 范围那一列：目录名，或「整个项目」 */
export function shareScopeText(share) {
  return share && share.folderName ? t('utils.shareFolder', { name: share.folderName }) : t('utils.shareWholeProject');
}

/**
 * 有效期至那一列。三种情况：
 *   - 永久 → `{ text: '永久', expired: false }`
 *   - 还没过期 → `{ text: '2026-11-02 12:30', expired: false }`
 *   - 已过期 → `{ text: '已过期', expired: true, dateText: '2026-10-01 12:30' }`
 *
 * 过期时正文只写「已过期」（列表里那一列本来就是灰的，再堆一个日期更花），
 * 原来的到期时间放在 `dateText` 里，调用方挂在 `title` 上悬停可见。
 */
export function shareExpiresText(share, now) {
  const at = share && share.expiresAt ? Number(share.expiresAt) : 0;
  if (!at) return { text: t('utils.shareForever'), expired: false, dateText: '' };

  const dateText = formatShareTime(at);
  if (at <= (now || Date.now())) {
    return { text: t('utils.shareExpired'), expired: true, dateText: dateText };
  }
  return { text: dateText, expired: false, dateText: dateText };
}

/**
 * 「有效期至」那一格的渲染：过期的那一行整格调灰，到期时间挂在 `title` 上。
 *
 * 表格是用 `render` 函数写的（`n-data-table` 的列定义），所以这里直接给 VNode ——
 * 两个列表（项目设置、头像菜单）都用它，免得样式和写法各来一份。
 */
export function shareExpiresCell(share, now) {
  const info = shareExpiresText(share, now);
  if (!info.expired) return info.text;
  return h('span', { class: 'expired', title: info.dateText }, info.text);
}
