/**
 * 拼查询串时的编码。**全站只有这一份** —— 地址栏和查询参数表是双向同步的，
 * 两边编码规则不一致的话，来回一趟内容就变了。
 *
 * 和 `encodeURIComponent` 只差一点：**`{{变量}}` 原样保留，不编码**。
 * 地址栏里写成 `%7B%7Btoken%7D%7D` 的话，变量高亮、补全、悬停看值全都认不出来；
 * 用户在地址栏手写 `?q={{token}}` 也会莫名其妙变成编码形式（G3 Task 4）。
 *
 * **发送不受影响**：服务端 `lib/url-utils.js` 的 `buildUrl` 是先把变量替换掉、
 * 再对新值编码的，所以地址栏里显示成什么样都不影响发出去的内容。
 */
export function encodeQueryPart(text) {
  const value = String(text === null || text === undefined ? '' : text);

  // 带捕获组的 split：奇数位就是捕获到的 `{{...}}`，原样保留；其余照常编码
  return value.split(/(\{\{[^{}]*\}\})/).map(function (part, index) {
    return index % 2 === 1 ? part : encodeURIComponent(part);
  }).join('');
}
