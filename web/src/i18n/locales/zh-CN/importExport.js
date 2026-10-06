/**
 * importExport 区域：导入 / 导出（`components/importExport/`）——
 * 导入弹窗（JSON 文件、YApi、Apifox、cURL、OpenAPI、HAR 六个页签）、外部格式导入面板、
 * 导出 OpenAPI 弹窗、导出文档弹窗。
 */
export default {
  /* ---------------- 通用 ---------------- */
  done: '导入完成',
  importAction: '导入',
  pickFile: '选择文件…',
  clear: '清除',
  preview: '解析预览',
  typeLabel: '类型：',
  detected: '识别为：',
  nameLabel: '名称：',
  quoted: '「{name}」',
  needEditor: '导入到当前项目需要 editor 及以上权限。',
  readonlyHint: '当前角色是只读，只能导入成新项目（导入后你就是它的 owner）。',
  intoCurrent: '导入到当前项目',
  newProject: '新建项目（名字取文件里的项目名）',
  pickProjectFirst: '先选一个项目',
  stats: '目录 {folders} 个、接口 {apis} 个、示例 {examples} 个',
  statsScripts: '、脚本 {n} 个',
  statsEnvs: '、环境 {n} 个',
  none: '无',
  text: '文本',
  form: '表单',
  file: '文件',

  /* ---------------- JSON 文件 / YApi / Apifox ---------------- */
  jsonFileTab: 'JSON 文件',
  pasteOrPickJson: '请粘贴 JSON，或者选择一个文件',
  orPasteJson: '或者直接把 JSON 粘在下面',
  collectionPlaceholder: '粘贴集合、环境或全局变量的 JSON（Collection v2.1 格式）',
  yapiPlaceholder: '粘贴 YApi 项目「数据导出 → json」下载下来的文件内容',
  apifoxPlaceholder: '粘贴 Apifox「导出 → Apifox 格式」下载下来的 .apifox.json 内容',
  pickOrPaste: '请选择文件，或者把 JSON 粘在下面',
  orPaste: '或者直接把 JSON 粘在下面',
  newProjectFromCollection: '新建项目（名字取集合名）',
  newProjectFromHar: '新建项目（名字取 HAR 里的页面标题）',
  globalsHint: '环境与 Globals 会导入到当前项目。',
  formatPostman: 'Postman 集合',

  /* ---------------- cURL ---------------- */
  curlPlaceholder: '把浏览器的 Copy as cURL 粘到这里，粘完自动解析',
  curlStats: '请求头 {headers} 个 · 查询参数 {query} 个 · 请求体：{body} · 鉴权：{auth}',
  intoSelected: '会落到目录树里选中的目录',
  intoRoot: '没有选中目录，会落到根目录',
  intoByGroup: '没有选中目录，会按分组建顶层目录',
  openInNewTab: '在新标签页打开',
  intoCurrentFolder: '导入到当前目录',
  importedInto: '已导入到{where}',
  selectedFolder: '选中的目录',
  rootFolder: '根目录',

  /* ---------------- OpenAPI ---------------- */
  urlBlockedHint: '网页版不能填地址拉取（云端访问不到内网），请选文件或粘贴内容；要填地址请在 apiloop 客户端里导入。',
  urlBlockedShort: '网页版不能填地址拉取，请在客户端里导入',
  urlOrFileOrPaste: '填一个地址、选一个文件，或者把内容粘进来',
  openapiUrlPlaceholder: '接口文档地址，比如 http://内网地址/v3/api-docs 或 /swagger.json（不填就用下面的文件或粘贴内容）',
  openapiPastePlaceholder: '粘贴 OpenAPI / Swagger 定义（JSON 或 YAML）',
  openapiFileHint: '支持 .json / .yaml / .yml，或者直接把内容粘在下面',
  loaded: '已读入 {name}',
  fetchAndParse: '拉取并解析',
  parse: '解析',
  parsedCount: '解析出 {n} 个接口',
  importedApis: '已导入 {n} 个接口。以后后端改了接口，可以在目录树右键「从 OpenAPI 同步更新」',

  /* ---------------- HAR ---------------- */
  pasteOrPickHar: '请粘贴 HAR 内容，或者选择一个文件',
  orPasteHar: '或者直接把 JSON 粘在下面（50MB 以内）',
  harPlaceholder: '浏览器开发者工具 Network 面板 → 右键 Save all as HAR with content',
  harTooBig: '这个 HAR 有 {size}，超过了 50MB 的上限',
  keepCredentials: '保留凭据',
  keepCredentialsWarn: 'Cookie、Authorization 会原样写进项目，项目里的所有成员都能看到',
  harStats: '主机 {hosts} 个、接口 {apis} 个、示例 {examples} 个',

  /* ---------------- 导出 ---------------- */
  exported: '已导出',
  exportAction: '导出',
  format: '格式',
  formatHtml: 'HTML（单个文件，左边目录可点）',
  scope: '范围',
  thisFolder: '这个目录（含子目录）：{name}',
  wholeProject: '整个项目',
  options: '选项',
  withExamples: '包含示例响应',
  withMockUrl: '包含 Mock 地址',
  doneOnly: '只导出已完成的接口',
  exportDocHint: '密码、token 这类值会自动遮住；环境变量的值、脚本不会导出。',
  exportDoc: '导出文档',
  exportDocFor: '导出文档：{name}',
  exportOpenapi: '导出为 OpenAPI',
  exportOpenapiFor: '导出为 OpenAPI：{name}',
  openapiHintLead: '变量（',
  openapiHintTail: ' 这类）原样保留；鉴权只导出类型，不导出值。'
};
