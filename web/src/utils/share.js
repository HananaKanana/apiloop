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
