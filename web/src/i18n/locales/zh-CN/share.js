/**
 * share 区域：分享（`components/share/`）—— 生成分享链接的弹窗、
 * 项目设置里的「分享链接」面板、头像菜单里的「我的分享」。
 */
export default {
  /* ---------------- 生成分享链接 ---------------- */
  dialogTitleProject: '分享整个项目的文档',
  dialogTitleFolder: '分享目录「{name}」的文档',
  expires: '有效期',
  expires30: '30 天',
  expires7: '7 天',
  expiresNever: '永久',
  generate: '生成链接',
  copy: '复制',
  linkCopied: '链接已复制',
  linkActiveLead: '这条链接已经生效。所有分享过的链接都在 ',
  manageLinkText: '项目设置 → 分享链接',
  linkActiveTail: ' 里，可以再复制或撤销。',
  tip: '打开链接的人不用登录就能看到这些接口的地址、参数和示例。保密变量和鉴权信息不会出现。 分享的是云端的数据，本机还没同步上去的改动看不到。',

  /* ---------------- 分享链接面板 ---------------- */
  panelTip: '分享出去的是云端的接口文档，打开链接的人不用登录就能看。撤销之后链接立刻失效。',
  noShares: '还没有生成过分享链接。在目录树上右键「分享文档」就能生成一条。',
  revokeTitle: '撤销分享链接',
  revokeAction: '撤销',
  revokeBody: '撤销后这个链接立刻失效，{scope}的文档就打不开了。确定吗？',
  revoked: '已撤销',
  folderScope: '目录「{name}」',
  projectScope: '整个项目',
  colScope: '范围',
  colCreatedBy: '谁建的',
  colCreator: '创建人',
  colCreatedAt: '创建时间',
  colExpiresAt: '有效期至',
  colActions: '操作',

  /* ---------------- 我的分享 ---------------- */
  mySharesTitle: '分享链接',
  mySharesTip: '这些链接不用登录就能打开。不再需要的请及时撤销。',
  mySharesEmpty: '还没有分享过接口文档。在目录树上右键目录，选「分享文档」。',
  colProject: '项目',
  quotedName: '「{name}」',
  thisProject: '这个项目',
  wholeProjectScope: '整个项目',
  revokeBodyMine: '撤销后这个链接立刻失效，{project}的{scope}就打不开了。确定吗？',

  /* ---------------- 公开文档页：导入到客户端 ---------------- */
  downloadOpenapi: '导入到客户端',
  downloadOpenapiHint: '下载成 OpenAPI 文件，在 apiloop 客户端里「导入 → OpenAPI」，再用本机 Mock 或真实环境调试',
  openapiDownloaded: '已下载。打开 apiloop 客户端，选「导入 → OpenAPI」导入这个文件'
};
