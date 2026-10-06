/**
 * db 区域：`web/src/components/db/` 下的界面文字
 * （项目设置里的数据库连接、接口的「数据库」页签）。
 *
 * 术语按 README.md 的术语表：Environment、Variable、Folder。
 * 专有名词不翻译：Redis、MySQL、PostgreSQL、SQL、Mock。
 *
 * 注意：消息里出现 `{{变量}}` 这种字面量时，vue-i18n 的 `{}` 是插值语法，
 * 必须写成 `{'...'}` 字面量转义（`{{` 写成 `{'{'}{'{'}`），否则编译报
 * 「Not allowed nest placeholder」。
 *
 * 说明：数据库面板的提示句里夹着 `<code>{{变量}}</code>` 元素，整句写成一个键会跨越
 * 标签、静态检查找不到原文，所以拆成 hintLead / hintMid / hintTail（noEnv 同理）。
 */
export default {
  /* ---------------- DatabasePanel ---------------- */
  name: '名字',
  type: '类型',
  address: '地址',
  edit: '编辑',
  emptyConnections: '还没有连接。加了之后，接口的「数据库」页签里就能选它来造数据、查数据。',
  addConnection: '+ 新增连接',
  webUnavailable: '网页版连不了数据库：连接要在客户端里新增、修改和测试（数据库操作也只在客户端里执行）。',
  readonlyHint: '只读角色只能看连接列表，不能改。',
  editConnectionTitle: '编辑连接：{name}',
  newConnectionTitle: '新增连接',
  namePlaceholder: '比如：开发库',
  host: '主机',
  port: '端口',
  portPlaceholder: '默认 {port}',
  user: '用户名',
  userPlaceholderRedis: 'Redis 6 之前没有用户名，留空',
  password: '密码',
  labelRedisDb: '库号',
  labelDatabase: '数据库名',
  dbIndexPlaceholder: '0（默认）',
  testConnection: '测试连接',
  testOk: '连接成功（{ms} ms）',
  testFail: '连接失败：{error}',
  nameRequired: '请给这个连接起个名字',
  hostRequired: '请填写主机',
  hintLead: '连接里每个字段都能写',
  hintMid: '—— 开发环境和测试环境连的是不同的库时，在环境里设一个变量来区分；密码建议写成',
  hintTail: '并在环境里设成保密变量。',
  noEnvLead: '现在没有选环境，连接里的',
  noEnvTail: '替换不出来，测试连接会失败。',
  varSample: "{'{'}{'{'}变量{'}'}{'}'}",
  varPassword: "{'{'}{'{'}dbPassword{'}'}{'}'}",
  hostPlaceholder: "127.0.0.1（可以写 {'{'}{'{'}dbHost{'}'}{'}'}）",
  passwordPlaceholder: "可以写 {'{'}{'{'}dbPassword{'}'}{'}'}",

  /* ---------------- DbOpsPane ---------------- */
  paneTitle: '数据库操作',
  paneNote: '请求前的先跑（可以往库里造数据、把值填进这次请求）；响应后的排在断言之前（断言能用刚查出来的变量）',
  noConnections: '这个项目还没有数据库连接。先到「项目设置 → 数据库」里加一个，这里才能选。',
  webOpsUnavailable: '网页版连不了数据库：数据库操作只能在客户端里新增、修改和执行。这里只能看，发送时会被跳过。',
  noEnvironmentNotice: '当前没有选环境（或者选的是内置的 Mock 环境），提取到「环境」的变量不会保存。',
  phasePre: '请求前',
  phasePost: '响应后',
  selectConnection: '选连接',
  addExtract: '+ 提取',
  variableName: '变量名',
  emptyPre: '还没有请求前的操作。',
  emptyPost: '还没有响应后的操作。',
  addOp: '+ 添加{phase}操作',
  resultTitle: '结果去哪儿看',
  resultNote: '每次操作在响应面板的「控制台」里占一行（连了什么库、语句、耗时、返回几行）'
};
