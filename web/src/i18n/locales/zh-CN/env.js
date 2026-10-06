/**
 * env 区域：环境（`components/env/`）—— 侧栏环境列表、单个环境的编辑区、
 * 内置 Mock 环境、环境对比。
 *
 * 术语：Environment（环境）、Variable（变量）。
 */
export default {
  /* ---------------- 侧栏列表 ---------------- */
  title: '环境',
  newEnv: '新建环境',
  newEnvName: '新环境',
  created: '已创建',
  builtin: '内置',
  current: '当前',
  setCurrent: '设为当前',
  setCurrentDone: '已设为当前环境',
  switchedTo: '已切换到「{name}」',
  switchedToMock: '已切换到「Mock」',
  duplicate: '复制',
  duplicateEnv: '复制环境',
  copySuffix: ' 副本',
  deleteTitle: '删除环境',
  deleteBody: '确定删除「{name}」吗？用了它里面变量的请求会变成未定义。删除后可以在回收站里恢复（保留 30 天）。',
  dirtyTitle: '有没保存的修改，⌘S 保存',
  more: '更多',

  /* ---------------- 单个环境 ---------------- */
  namePlaceholder: '环境名',
  nameRequired: '环境名不能为空',
  readonly: '当前角色是只读，不能保存修改',
  readonlyShort: '当前角色是只读',
  filterPlaceholder: '过滤变量',
  countLabel: '共 {n} 个变量',
  gone: '这个环境已经被删掉了。',
  exported: '已导出',
  exportJson: '导出为 JSON',

  /* ---------------- 内置 Mock 环境 ---------------- */
  restoreDefaultTitle: '还原默认值',
  restoreDefaultBody: '变量会恢复成只有 host = {host}，你改过和加的变量都会去掉。',
  restoreAction: '还原',
  defaultRestored: '已还原默认值',
  mockIntroLead: '选中这个环境，请求地址写成 ',
  mockIntroMid: ' 就会打到这个项目的 Mock 上。 默认 host 是 ',
  mockIntroMid2: '；接口都带统一前缀时可以直接改， 比如在后面加上 ',
  mockIntroTail: '。',

  /* ---------------- 环境对比 ---------------- */
  diffTitle: '环境对比',
  diffCount: '{envs} 个环境 · {vars} 个变量',
  onlyDiff: '只看有差异的',
  fillMissing: '补齐缺少的变量',
  noMissing: '没有缺的变量',
  filled: '补齐了 {n} 处，填好值再保存',
  discard: '放弃修改',
  discarded: '已放弃修改',
  saveWithCount: '保存（{n} 处修改）',
  savedEnvs: '已保存 {n} 个环境',
  failedName: '「{name}」',
  saveFailed: '这些环境没保存成功：{list}',
  noEnvsHint: '这个项目还没有环境。先在左侧「环境」里新建几个，再回来对比。',
  variableName: '变量名',
  hide: '遮住',
  reveal: '看自己的值',
  missing: '（缺少）',
  addHere: '点一下给这个环境加上',
  allSame: '所有环境都一样，没有差异',
  noVarsYet: '这些环境里还没有变量'
};
