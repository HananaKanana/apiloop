/**
 * record 区域：`web/src/components/record/` 下的界面文字
 * （Mock 录制抽屉、录制记录详情、保存所选弹窗）。
 *
 * 术语按 README.md 的术语表：Mock 不翻译，目录用 Folder。
 *
 * 注意：消息里出现 `{{变量}}` 这种字面量时，vue-i18n 的 `{}` 是插值语法，
 * 必须写成 `{'...'}` 字面量转义（`{{` 写成 `{'{'}{'{'}`），否则编译报
 * 「Not allowed nest placeholder」。本区域暂无需转义的文案。
 */
export default {
  /* ---------------- RecordDrawer ---------------- */
  drawerTitle: 'Mock 录制',
  busyOther: '正在录制项目「{project}」，同一时间只能录一个项目。切到那个项目去停止，或者等它停掉。',
  targetLabel: '目标地址',
  useEnvVar: '用环境变量',
  targetRequired: '先填目标地址',
  targetTip: '请求会转发到这个地址（可以带路径前缀），同时记下来。',
  startedHint: '开始录制，把接口地址改成下面的代理地址',
  stoppedHint: '已停止录制，记录还留着，可以继续挑着保存',
  portLabel: '端口',
  portPlaceholder: '自动',
  portTip: '留空 / 0 表示自动（从 47400 起找空闲端口）',
  prefixLabel: '只录这个前缀',
  prefixPlaceholder: '留空表示全录，比如 /api',
  optionsLabel: '选项',
  lanLabel: '允许局域网访问（手机、其他电脑）',
  lanWarn: '同一网络里的人都能通过这个地址访问你的目标服务，注意别把内网服务暴露出去。',
  skipStaticLabel: '跳过静态资源（js / css / 图片 / 页面）',
  start: '开始录制',
  proxyLabel: '代理地址',
  copy: '复制',
  lanAddr: '局域网',
  forwardTo: '转发到',
  recordingTip: '把前端 / App 的接口地址改成上面的代理地址，请求会转发到 {target}，响应自动记在下面。',
  stop: '停止',
  selectAll: '全选',
  countRatio: '{shown} / {total} 条',
  searchPlaceholder: '按路径搜',
  onlyUnmatched: '只看没对上接口的',
  dedupe: '去重',
  unreachable: '连不上',
  newApi: '新接口',
  collapse: '收起',
  detail: '详情',
  empty: '还没有记录',
  emptyRecording: '把接口地址改成上面的代理地址，访问一次就会出现在这里。',
  emptyIdle: '开始录制之后，访问代理地址的请求会出现在这里。',
  loading: '加载中…',
  saveSelected: '保存所选（{n}）',
  readonlyHint: '只读成员只能看记录',
  selectFirst: '先勾几条要保存的记录',
  saveCreated: '新建了 {apis} 个接口，加了 {examples} 个示例',
  saveFailedTitle: '有 {n} 条没保存成功',
  gotIt: '知道了',
  clearTitle: '清空记录',
  clearBody: '清掉这个项目录到的全部记录（不影响已经保存的接口和示例）。',
  clearAction: '清空',
  cleared: '已清空',

  /* ---------------- RecordDetail ---------------- */
  none: '（无）',
  emptyValue: '（空）',
  truncated: '（太长，只记了前面 1 MB）',
  binary: '（二进制内容，没有记下来）',
  matchedApi: '对应接口',
  noMatchHint: '没对上，保存时会新建接口',
  requestHeaders: '请求头',
  requestBody: '请求体',
  responseHeaders: '响应头',
  responseBody: '响应体',

  /* ---------------- RecordSaveDialog ---------------- */
  saveDialogTitle: '保存所选记录',
  saveMatchedGroup: '存为示例（{n} 条）',
  saveMatchedHint: '加到各自对应的接口上；勾了「设为 Mock 返回」就把接口的 Mock 指向新示例。',
  moreItems: '…还有 {n} 条',
  createGroup: '新建接口（{n} 个）',
  createHint: '这些请求没对上已有接口，会按录到的方法和地址建出新接口再加示例。',
  moreCreated: '…还有 {n} 个',
  folderLabel: '放到目录',
  rootFolder: '项目根目录',
  paramize: '路径里的数字 / ID 换成参数（/orders/1001 → /orders/:id）',
  setMock: '设为 Mock 返回（后端挂了就切到 Mock）',
  saveCount: '保存（{n}）'
};
