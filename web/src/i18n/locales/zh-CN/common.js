/**
 * common 区域：`web/src/components/common/` 下通用组件的界面文字
 * （双击改名、键值表、变量输入框、变量表、模板化对话框等）。
 *
 * 术语按 README.md 的术语表：Variable、Secret variable、Example。
 * CodeEditor / ContextMenu 没有界面文字（只有注释），所以这里没有它们的段。
 */
export default {
  /* ---------------- InlineRename ---------------- */
  renameHint: '双击重命名',

  /* ---------------- KeyValueTable ---------------- */
  paramName: '参数名',
  value: '值',
  description: '描述',
  batchEdit: '批量编辑',
  exitBatchEdit: '退出批量编辑',
  showDescColumn: '显示描述列',
  hideDescColumn: '隐藏描述列',
  batchPlaceholder: '每行一条：key: value；以 // 开头表示停用',
  apply: '应用',
  tableOptions: '表格选项',
  deleteRow: '删除这一行',

  /* ---------------- TemplatizeDialog ---------------- */
  templatizeTitle: '智能模板化',
  templatizeNone: '没有找到可以随机化的值，内容保持不变。',
  templatizeTip: '下面这些值会被换成每次随机的占位符，结构和字段类型不变。确认后才会生效。',
  templatizePath: '路径',
  templatizeFrom: '原值',
  templatizePlaceholder: '占位符',
  templatizeCount: '共 {n} 处替换。',
  templatizeConfirm: '确认替换',

  /* ---------------- VarInput ---------------- */
  dynamicVariable: '内置动态变量',
  tooltipMock: '{token}：mock 占位符，只在 mock 渲染时展开',
  tooltipDynamic: '{token}：内置动态变量，每出现一次生成一个新值',
  tooltipLiteral: '不是变量，发送时原样保留',
  tooltipUndefined: '未定义 —— 在环境、目录或项目变量里添加',

  /* ---------------- VarTable ---------------- */
  varName: '变量名',
  secretHint: '只有你自己能看到，会在你登录的设备之间同步，不会同步给其他成员',
  secretValuePlaceholder: '只有你自己能看到',
  secretToggleOnTitle: '点一下设为保密（只有你自己能看到，会在你的设备之间同步）',
  secretToggleOffTitle: '{hint}，点一下改回明文',
  resizeColumn: '拖动调整列宽',
  secretDialogTitle: '设为保密变量',
  secretDialogBody: '设为保密后，这个值只有你自己能看到，会在你登录的设备之间同步，不会同步给其他成员。',
  secretDialogConfirm: '设为保密'
};
