/**
 * 请求方法的颜色。**全站只有这一份** —— 目录树的方法标签、地址栏的方法下拉、
 * 顶部标签页的标题都从这里取，别再各自写死一份。
 *
 * 这几个色号是照着 Postman 挑的：GET 绿、POST 黄、PUT 蓝、PATCH 紫、DELETE 红，
 * HEAD / OPTIONS 这种少见的中性灰，WebSocket 用青色和 HTTP 区分开，
 * Socket.IO（第九轮第 4 节）用紫红，gRPC（第十一轮第 1 节）用橙色。
 * 都取的是中间调，亮色和暗色主题下都读得清。
 */
const COLORS = {
  GET: '#0cbb52',
  POST: '#ffb400',
  PUT: '#097bed',
  PATCH: '#623ce4',
  DELETE: '#eb2013',
  HEAD: '#6b7280',
  OPTIONS: '#6b7280',
  WS: '#0ea5a4',
  SIO: '#d946ef',
  GRPC: '#e8590c'
};

/** 认不出来的方法（用户自己输入的自定义方法）一律中性灰 */
const FALLBACK = '#6b7280';

/**
 * 方法标签的宽度：各行的接口名要对齐，所以宽度固定、文字右对齐。
 * 目录树和标签页共用同一个值。
 */
export const METHOD_LABEL_WIDTH = '44px';

/**
 * @param {string} method 请求方法，大小写都行
 * @returns {string} 颜色
 */
export function methodColor(method) {
  const name = String(method === undefined || method === null ? '' : method).toUpperCase();
  return COLORS[name] || FALLBACK;
}
