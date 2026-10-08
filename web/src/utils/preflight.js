import { t } from '@/i18n';
/**
 * 前置接口（第十轮第 3 节）的纯逻辑。
 *
 * 项目设置、目录设置两个页面共用同一份措辞和同一套「下拉值 ↔ 设置对象」的换算，
 * 分开写迟早会出现「项目上叫跟随上层、目录上叫继承」这种不一致。
 *
 * 设置对象的形状（`projects.extra.preflight` / `folders.extra.preflight`）：
 *   - `null`            没配过（目录上是「跟随上层」）
 *   - `{ apiId: null }` 显式「这一层不用前置接口」（挡住往上找）
 *   - `{ apiId, whenMissing, retryOn401 }`
 */

/** 下拉里两个不是接口的选项 */
export const INHERIT = '__inherit__';
export const OFF = '__off__';

/** 勾上「变量没有值时」时默认填的变量名 —— 这是最常见的用法 */
export const DEFAULT_MISSING_NAME = 'token';

/**
 * 下拉显示什么：`null` → 跟随上层（项目上没有这一项，所以是「不使用」）；
 * `apiId` 为 null → 不使用；否则就是那个接口。
 */
export function selectValueOf(preflight, options) {
  const opts = options || {};
  if (!preflight) return opts.allowInherit === false ? OFF : INHERIT;
  if (!preflight.apiId) return OFF;
  return String(preflight.apiId);
}

/**
 * 下拉选项。
 *
 * `allowInherit === false` 时没有「跟随上层」这一项（项目自己没有上层）——
 * 那时「不配」和「不用」是一回事，选「不使用前置接口」就等于清掉。
 *
 * **不列 WebSocket / Socket.IO 接口**：前置接口是通过 `/send` 发的 HTTP 请求，
 * 那两种方法发不出去（选了只会在发送时得到一句报错）。
 */
export function optionsFor(apis, options) {
  const opts = options || {};
  const list = [];

  if (opts.allowInherit !== false) {
    list.push({ value: INHERIT, get label() { return t('utils.pfInherit'); } });
  }
  list.push({ value: OFF, get label() { return t('utils.pfNone'); } });

  (apis || []).forEach(function (api) {
    if (!api || !api.id) return;
    const method = String(api.method || '').toUpperCase();
    // 前置接口是用 /send 发的 HTTP 请求，非 HTTP 的接口（WS / SIO / GRPC / MQTT / AMQP / TCP / UDP）不能当它
    if (method === 'WS' || method === 'SIO' || method === 'GRPC' || method === 'MQTT' ||
      method === 'AMQP' || method === 'TCP' || method === 'UDP') return;

    list.push({ value: String(api.id), get label() { return api.name || t('utils.untitledApi'); } });
  });

  return list;
}

/**
 * 换了下拉选项之后的新设置。
 *
 * 选中某个接口时**两个触发条件默认都勾上**（「token 没有值时」+「401 时重发」）——
 * 这正是这个功能的两个典型用法，用户要收窄再自己取消。切换接口时保留原来的条件
 * 设置，别让用户重新勾一遍。
 */
export function applySelect(value, previous, options) {
  const before = previous && typeof previous === 'object' ? previous : null;

  // 「跟随上层」= 整块设置清掉（项目上没有上层，「不使用」才是它对应的那项）
  if (value === INHERIT) return null;

  if (value === OFF) return { apiId: null, whenMissing: '', retryOn401: false };

  return {
    apiId: String(value),
    whenMissing: (before && before.whenMissing) || DEFAULT_MISSING_NAME,
    retryOn401: before ? before.retryOn401 === true : true
  };
}

/** 一行说明（设置页里的灰字）。`apis` 用来把 apiId 换成名字 */
export function describe(preflight, apis, options) {
  const opts = options || {};

  if (!preflight) {
    return opts.allowInherit === false ? t('utils.pfNone') : t('utils.pfInherit');
  }
  if (!preflight.apiId) return t('utils.pfOffHere');

  const found = (apis || []).filter(function (api) { return api && String(api.id) === String(preflight.apiId); })[0];
  // 指向的接口被删了（或者挪到别的项目去了）：说清楚，别让用户以为设置还在生效
  if (!found) return t('utils.pfDeleted');

  const name = found.name || t('utils.untitledApi');

  const when = [];
  if (preflight.whenMissing) when.push(t('utils.pfWhenMissing', { name: preflight.whenMissing }));
  if (preflight.retryOn401) when.push(t('utils.pfWhen401'));

  if (!when.length) return name + t('utils.pfNeverCalls');
  return name + t('utils.pfCalls', { list: when.join(t('utils.pfListSep')) });
}

/**
 * 流式发送拿到结果之后，要不要由**前端**带 `forcePreflight` 再发一次。
 *
 * 服务端做不了这件事：流式的响应头早就推给浏览器了，再换一份响应就等于说了两次话
 * （见 `lib/send-core.js` 的 `retryOn401Due`，那边只管非流式）。所以判断放在这里，
 * `stores/tabs.js` 的 sendRequest 调它。**只会重发一次** —— 第二次带的就是
 * `forcePreflight`，这里直接返回 false。
 *
 * @param {object} result 这次发送的结果（服务端回来的那一份）
 * @param {object|null} rule `end` 事件里带回来的生效规则
 * @param {{forcePreflight?: boolean}} [options] 这次发送是不是「重发的那一次」
 */
export function shouldRetry401(result, rule, options) {
  const opts = options || {};
  if (opts.forcePreflight === true) return false;
  if (!rule || rule.retryOn401 !== true) return false;

  const status = result && result.response ? result.response.status : null;
  return status === 401;
}
