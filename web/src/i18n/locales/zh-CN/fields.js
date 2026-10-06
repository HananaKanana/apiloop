/**
 * fields 区域：`web/src/components/fields/`（响应字段说明页签）的界面文字。
 *
 * 术语按 README.md 的术语表：Field、Example、OpenAPI。
 * 类型下拉的选项值是 JSON 类型名（string / number / …），属代码，不翻译。
 */
export default {
  /* ---------------- ResponseFieldsTab ---------------- */
  title: '响应字段说明',
  generateFromExample: '从示例生成',
  clearMissing: '清掉示例里没有的（{n}）',
  saveFirstHint: '先保存成接口，才能从示例生成',
  noExamplesHint: '这个接口还没有示例',
  tip: '给前端和对接方看的：这个字段是什么意思。说明会出现在分享出去的接口文档里，也会带进导出的 OpenAPI。',
  colField: '字段',
  colType: '类型',
  colDesc: '说明',
  colRequired: '必有',
  missingTag: '示例里已经没有',
  descPlaceholder: '这个字段是什么意思',
  deleteRow: '删除这一行',
  empty: '还没有字段。可以从示例生成，或者手动加一行。',
  addPathPlaceholder: '手动加一行：字段路径，比如 data.list[].id',
  add: '添加',
  unnamedExample: '示例 {n}',
  exampleOption: '{name}（{status}）',
  selectExampleFirst: '先选一个示例',
  noFieldsInExample: '这个示例里没有可列的字段',
  generatedCount: '列出了 {n} 个字段',
  pathRequired: '填一个字段路径，比如 data.list[].id',
  pathExists: '这个路径已经有了'
};
