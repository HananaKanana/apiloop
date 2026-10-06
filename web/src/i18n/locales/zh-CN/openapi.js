/**
 * openapi 区域：`web/src/components/openapi/` 下的界面文字
 * （「从 OpenAPI 同步更新」弹窗）。
 *
 * 术语按 README.md 的术语表：OpenAPI / Swagger / JSON / YAML / Mock 不翻译，
 * 目录用 Folder，回收站用 Trash。
 */
export default {
  /* ---------------- SyncDialog ---------------- */
  dialogTitle: '从 OpenAPI 同步更新',
  scope: '范围：{scope}',
  scopeFolder: '目录「{name}」（含子目录）',
  scopeProject: '整个项目',
  modeUrl: '地址',
  modeText: '粘贴内容',
  urlBlockedHint:
    '网页版不能填地址拉取（云端访问不到内网），请把文档内容粘贴进来；要填地址请在 apiloop 客户端里同步。',
  urlPlaceholder: '接口文档地址，比如 http://内网地址/v3/api-docs 或 /swagger.json',
  textPlaceholder: '粘贴 OpenAPI / Swagger 定义（JSON 或 YAML）',
  check: '检查更新',
  urlRemembered: '地址会记住，下次自动填上',
  urlBlockedCheck: '网页版不能填地址拉取，请切到「粘贴内容」或在客户端里检查',
  urlRequired: '填一个地址，或者切到「粘贴内容」',
  textRequired: '把 OpenAPI 定义粘进来',
  upToDate: '已经是最新的',
  groupAdded: '新增（{n}）',
  groupChanged: '有改动（{n}）',
  groupRemoved: '文档里已删除（{n}）',
  groupRemovedNote: '勾了才处理，会放进回收站（不是真删）',
  unnamed: '(未命名)',
  rootFolder: '项目根目录',
  empty: '（空）',
  applyTip: '只更新地址、参数、请求体字段、名称和说明；你写的脚本、示例、Mock、鉴权设置都会保留。',
  nothingSelected: '一项都没选',
  applyResult: '新增 {added} 个、更新 {updated} 个、移到回收站 {removed} 个',
  selectedCount: '已选 {n} 项',
  apply: '同步所选'
};
