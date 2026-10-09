/**
 * suite 区域：`web/src/components/suite/` 下的界面文字
 * （测试集标签页、侧栏列表、步骤 / 数据 / 设置 / 运行记录页签、运行报告）。
 *
 * 术语按 README.md 的术语表：Test suite、API、Folder、Assertion、Extract、
 * Environment、Variable、Mock、Example、Expectation。
 *
 * 注意：消息里出现 `{{变量}}` 这种字面量时，vue-i18n 的 `{}` 是插值语法，
 * 必须写成 `{'...'}` 字面量转义（`{{` 写成 `{'{'}{'{'}`），否则编译报
 * 「Not allowed nest placeholder」。
 */
export default {
  /* ---------------- SuiteList ---------------- */
  title: '测试集',
  newSuite: '新建测试集',
  emptyList: '还没有测试集。点上面的 + 建一个，或者从「批量运行」里「存为测试集」。',
  rename: '改名',
  copy: '复制',
  deleteConfirm: '删除「{name}」？运行记录也会一起删掉（不可撤销）。',
  deleted: '已删除',

  /* ---------------- SuiteTab ---------------- */
  stepCount: '{n} 步',
  stop: '停止',
  run: '运行',
  backToEdit: '返回编辑',
  failedCountLabel: '失败 {n}',
  viewAll: '看全部',
  onlyFailed: '只看失败',
  roundN: '第 {n} 轮',
  paneSteps: '步骤',
  paneData: '数据',
  paneSettings: '设置',
  paneRuns: '运行记录',
  mockEnv: 'Mock（内置）',
  saveFailed: '保存失败：{message}',
  webCannotRun: '网页版不能运行测试集，请在客户端里运行',
  progressRoundStep: '第 {iteration}/{iterations} 轮 · 第 {index}/{steps} 步',
  preparing: '准备中…',

  /* ---------------- SuiteStepsPane ---------------- */
  stepsHintLead: '按顺序执行；点开一行可以给这一步',
  stepsHintBold: '追加',
  stepsHintAfter: '断言和提取变量。',
  addApi: '添加接口',
  emptySteps: '还没有步骤。点「添加接口」从目录树里挑几个 —— 同一个接口可以加多次。',
  apiDeleted: '接口已删除',
  onFailContinue: '失败时继续',
  onFailSkipIteration: '失败时跳过本轮',
  removeStep: '删除这一步',
  detailHint: '接口自己的断言照样会跑，这里的是在它之后追加的。',
  openApi: '打开接口',
  pickApisFirst: '先勾几个接口',
  addedApis: '加了 {n} 个接口',
  pickHint: '勾目录会把它下面的接口按树的顺序一起加进来；WebSocket 接口不能加。',
  noApis: '这个项目还没有接口。',
  add: '添加',

  /* ---------------- SuiteDataPane ---------------- */
  dataNone: '不用数据',
  chooseFile: '选文件',
  csvPlaceholderHeader: '第一行是列名，逗号分隔：',
  csvPlaceholderRow1: '账号,密码',
  csvPlaceholderRow2: 'user1,pass1',
  csvPlaceholderRow3: 'user2,pass2',
  jsonPlaceholder: '[{\'{\'}"账号":"user1","密码":"pass1"{\'}\'}]',
  fileTooLarge: '文件超过 2 MB 了，拆小一点',
  readFileFailed: '读文件失败',
  dataHintLead: '每一行跑一轮。列名就是变量名，接口里写',
  dataHintVar: "{'{'}{'{'}列名{'}'}{'}'}",
  dataHintAfterVar: '就能用；脚本里用',
  dataHintColumn: '列名',
  dataHintStrong: '数据变量优先于环境变量。',
  dataHintTail: '上限 1000 行 / 2 MB。',
  previewCount: '共 {rows} 行，会跑 {iterations} 轮（下面预览前 20 行）',
  noDataHint: '不用数据时，按「设置」里那个轮数跑（默认 1 轮）。',

  /* ---------------- SuiteSettingsPane ---------------- */
  iterationsLabel: '不用数据时跑几轮',
  delayLabel: '每个请求之间等多久',
  delayUnit: '步骤上单独设的等待在这个之外',
  timeoutLabel: '请求超时',
  followGlobal: '跟全局设置',
  timeoutUnit: '留空就跟全局设置',
  noteLead: '运行时提取、脚本设置的变量',
  noteStrong: '只在这次运行里有效',
  noteTail: '，不会改环境里保存的值； Cookie 每次运行从空开始、步骤之间共用；不记历史。',

  /* ---------------- SuiteRunsPane ---------------- */
  statusPassed: '通过',
  statusFailed: '失败',
  statusStopped: '停止',
  statusError: '出错',
  runsKeepHint: '每个测试集只留最近 100 条。',
  refresh: '刷新',
  runsCloudHint: '登录后运行记录会保存到云端，同事也能看到。现在运行照样能跑，只是不留记录。',
  noRuns: '还没有运行记录。',
  sourceCli: '命令行',
  sourceApp: '客户端',
  removeRun: '删除这条记录',

  /* ---------------- SuiteReport ---------------- */
  noEnvironment: '（没选环境）',
  buildLabel: '构建号 {label}',
  exportReport: '导出报告',
  unitRounds: '轮',
  unitRequests: '个请求',
  assertions: '断言',
  statDuration: '总用时',
  statAverage: '平均',
  truncatedNote: '这次运行的结果太大，请求 / 响应的明细没有存进记录（只留了每一步的结论）。',
  hasFailure: '有失败',
  statusSkipped: '跳过',
  collapse: '收起',
  viewRequestResponse: '看请求 / 响应',
  testMessagePrefix: '：',
  actualRequest: '实际发出的请求',
  responseWithStatus: '响应（HTTP {status}）',
  noStepsInRun: '这次运行没有步骤（或者明细被截断了）。'
};
