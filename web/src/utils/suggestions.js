/**
 * 输入时的补全候选。请求头名字这类固定清单放这里，别在每个表格里各写一份。
 */

/** 常用的请求头名字（「键」那一列输入时提示） */
export const HEADER_NAMES = [
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Connection',
  'Content-Length',
  'Content-Type',
  'Cookie',
  'Host',
  'Origin',
  'Pragma',
  'Referer',
  'User-Agent',
  'X-Requested-With'
].map(function (name) { return { label: name }; });
