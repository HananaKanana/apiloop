/**
 * api 区域：接口层自己造的提示（`api/`）—— 失败 / 取消 / 登录过期 / 浏览器不支持流式。
 * **服务端返回的 `error` 文案原样透传**，不翻译（那是后端的 i18n 范围）。
 */
export default {
  httpFailed: '请求失败（HTTP {status}）',
  failed: '请求失败',
  cancelled: '请求已取消',
  networkFailed: '网络请求失败：{message}',
  unknownError: '未知错误',
  loginExpired: '登录已过期，请重新登录',
  noStreamSupport: '这个浏览器不支持流式响应'
};
