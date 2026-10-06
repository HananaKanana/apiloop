/**
 * folder 区域：目录设置标签页（`components/folder/`）—— 名称、说明、目录变量、
 * 目录级鉴权、公共请求头、脚本、前置接口。
 */
export default {
  settingsTitle: '目录设置',
  location: '位置：{path}',
  runHint: '按顺序运行这个目录下的接口',
  nameRequired: '请填写目录名称',
  gone: '这个目录已经不在了，它可能刚被删掉。',
  readonlyHint: '当前角色是只读，只能查看目录设置。',
  basicTitle: '基本信息',
  nameLabel: '名称',
  namePlaceholder: '目录名称',
  descLabel: '描述',
  varsTitle: '目录变量',
  varsTip: '目录变量在发送时展开，优先级是「项目 < 外层目录 < 内层目录 < 环境」， 后面的覆盖前面的。这个目录下的接口、子目录都能用到。',
  authTitle: '目录级鉴权',
  authTip: '这个目录下的接口和子目录选了「继承父级」时，就沿用到这一级。',
  authLevelFolder: '目录「{name}」',
  authLevelProject: '项目',
  headersTitle: '公共请求头',
  headersTip: '这个目录下的所有接口发送时都会带上这些请求头；接口里有同名的请求头时，用接口自己的。',
  headerNamePlaceholder: '请求头',
  headerValuePlaceholder: '值',
  scriptsTitle: '脚本',
  scriptsTip: '这个目录下的接口发送时，会先按「项目 → 目录（从外到内）→ 接口」执行「请求前」脚本， 响应回来后再按同样的顺序执行「响应后」脚本。',
  preflightTitle: '前置接口',
  preflightTip: '这个目录下的接口发送之前，先自动调一遍选中的接口（通常是登录接口）， 把 token 拿回来。不设置就跟着外层（上级目录 → 项目）走。'
};
