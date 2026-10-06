/**
 * members 区域：项目成员管理（`components/members/`）。
 * 角色名沿用服务端的英文标识（viewer / editor / owner / admin），只翻译后面的解释。
 */
export default {
  roleOption: '{role}（{desc}）',
  roleViewer: '只读',
  roleEditor: '可编辑',
  roleOwner: '可管理',
  roleAdmin: '管理员',
  searchPlaceholder: '搜索用户名或显示名',
  add: '添加成员',
  pickUserFirst: '先搜索并选中一个用户',
  added: '已添加',
  roleChanged: '已修改角色',
  leaveTitle: '退出项目',
  leaveBody: '确定退出「{name}」吗？退出后你就看不到这个项目了。',
  leaveAction: '退出',
  left: '已退出',
  removeTitle: '移除成员',
  removeBody: '确定把「{name}」移出这个项目吗？',
  removeAction: '移除',
  removed: '已移除',
  colUsername: '用户名',
  colDisplayName: '显示名',
  colRole: '角色',
  me: '我',
  disabled: '已禁用',
  empty: '还没有成员',
  rolesTip: '角色：viewer 只能查看和发请求；editor 还能增删改接口、示例、期望与环境；owner 还能改项目名称和标识、管理成员、删除项目。系统管理员对任何项目都等同于 owner。',
  keepOwnerTip: '项目至少要保留一个 owner，最后一个 owner 不能降级或退出。'
};
