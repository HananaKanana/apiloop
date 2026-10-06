import { t } from '@/i18n';
/**
 * 接口状态（第四轮第 1 节）。
 *
 * 值存在 `apis.extra.status`（会同步的列），服务端不认识的也原样存、原样读回来；
 * 这里只负责**认得的这几个**怎么显示。界面上一律用 `statusMeta()` 判一下：
 * 认不出来（没设过、或者以后加了新状态而这版客户端还不认识）就当「未设置」显示。
 */

/** 顺序就是下拉里的顺序；颜色和「已废弃」那种灰名字、删除线配着看 */
export const API_STATUSES = [
  { value: 'designing', color: '#8c8c8c', get label() { return t('utils.stDesigning'); } },
  { value: 'developing', color: '#f0a020', get label() { return t('utils.stDeveloping'); } },
  { value: 'done', color: '#0cbb52', get label() { return t('utils.stDone'); } },
  { value: 'deprecated', color: '#eb2013', get label() { return t('utils.stDeprecated'); } }
];

const BY_VALUE = new Map(API_STATUSES.map(function (item) { return [item.value, item]; }));

/** 认得的状态返回那一项，其余（含空）返回 null */
export function statusMeta(value) {
  return BY_VALUE.get(String(value === undefined || value === null ? '' : value)) || null;
}

/** 状态的下拉选项（含「未设置」，值是 null） */
export const STATUS_OPTIONS = [{ value: null, get label() { return t('utils.stUnset'); } }].concat(
  API_STATUSES.map(function (item) { return { label: item.label, value: item.value }; })
);

/** 目录树筛选的下拉选项：全部 / 某个状态 / 我负责的 */
export const STATUS_FILTER_OPTIONS = [{ value: 'all', get label() { return t('utils.stAll'); } }].concat(
  API_STATUSES.map(function (item) { return { label: item.label, value: item.value }; }),
  [{ value: 'mine', get label() { return t('utils.stMine'); } }]
);

export const FILTER_ALL = 'all';
export const FILTER_MINE = 'mine';

/**
 * 把筛选下拉选中的那个值翻译成 `filterTree` 要的两个条件。
 * @param {string} key `'all'` / 某个状态值 / `'mine'`
 * @param {string} myUserId
 * @returns {{status: string, ownerId: string}}
 */
export function filterCondition(key, myUserId) {
  if (!key || key === FILTER_ALL) return { status: '', ownerId: '' };
  if (key === FILTER_MINE) return { status: '', ownerId: myUserId || '' };
  return { status: key, ownerId: '' };
}

/** 悬停提示里那一行「状态：开发中 · 负责人：张三」，两样都没有就返回空串（不挂 title） */
export function statusTooltip(status, ownerName) {
  const parts = [];
  const meta = statusMeta(status);
  if (meta) parts.push(t('utils.stPrefix') + meta.label);
  if (ownerName) parts.push(t('utils.ownerPrefix') + ownerName);
  return parts.join(' · ');
}

/** 「已废弃」的接口在树里要灰掉、加删除线 */
export function isDeprecated(status) {
  return String(status || '') === 'deprecated';
}
