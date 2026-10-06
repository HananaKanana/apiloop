/**
 * assertions 区域：`web/src/components/assertions/`（断言 / 提取变量页签）的界面文字。
 *
 * 术语按 README.md 的术语表：Assertion、Extract、Environment、Mock。
 * 下拉选项里的「检查什么 / 比较方式 / 从哪里取 / 存到」以及各来源的输入提示由
 * `utils/assertions.js` 提供（属 utils 区域），这里只放组件自己渲染的文字。
 */
export default {
  /* ---------------- AssertionsPane ---------------- */
  title: '断言',
  note: '收到响应后执行（在「响应后」脚本之前，脚本里能用刚提取的变量）',
  checkWhat: '检查什么',
  fieldOrName: '字段 / 名称',
  compareBy: '比较方式',
  expectedValue: '期望值',
  emptyAssertions: '还没有断言。点下面的按钮加一条。',
  addAssertion: '+ 添加断言',
  commonPresets: '常用：',
  extracts: '提取变量',
  extractNote: "把响应里的值存成变量，下一个请求就能用 {'{'}{'{'}名字{'}'}{'}'} 引用",
  envHint: '当前没有选环境（或者选的是内置的 Mock 环境），提取到「环境」的变量不会保存。',
  extractFrom: '从哪里取',
  pathHeader: '路径 / 头名 / 正则',
  storeTo: '存到',
  varName: '变量名',
  emptyExtracts: '还没有提取。上一步的 token、id 都可以存下来给下一个接口用。',
  addExtract: '+ 添加提取',
  noValueNeeded: '不用填',
  valuePlaceholder: "期望值（可以写 {'{'}{'{'}变量{'}'}{'}'}）"
};
