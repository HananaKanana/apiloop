/**
 * preflight 区域：`web/src/components/preflight/` 下的界面文字（前置接口设置）。
 *
 * 术语按 README.md 的术语表：API、Variable、Assertion、Pre-request。
 *
 * 注意：下拉选项 label 和下面那行 summary 来自 `utils/preflight.js` 的
 * `optionsFor` / `describe`（属 utils 区域，T24 负责），本区域不含它们的键。
 */
export default {
  /* ---------------- PreflightPanel ---------------- */
  label: '前置接口',
  selectPlaceholder: '选一个接口（通常是登录接口）',
  variableLabel: '变量',
  whenMissingSuffix: '没有值时，先调用它',
  retryOn401Label: '响应是 401 时，自动调用后重发一次',
  tip: '前置接口要自己把 token 存起来（在它的「断言」页签里提取变量，或者写响应后脚本）—— 这里只是「什么时候调它」。它自己不会再触发前置接口。'
};
