import { del, post } from './client';

/**
 * WebSocket 调试会话（契约第 15 节）。
 *
 * 浏览器不能给 WebSocket 设自定义请求头、也绕不开跨域，所以由服务端当客户端去连，
 * 前端只操作这几个接口。事件流是 NDJSON 长连接，用 `api/stream.js` 的 getNdjson 读。
 */

/** 建会话，建好后服务端立刻开始连接 */
export function createSession(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/ws', payload);
}

/** 发一条消息。连接还没打开或者已经关闭时服务端返回 409 */
export function sendMessage(id, payload) {
  return post('/ws/' + encodeURIComponent(id) + '/send', payload);
}

/** 用 1000 关闭并立刻销毁会话 */
export function destroySession(id) {
  return del('/ws/' + encodeURIComponent(id));
}

/** events 长连接的路径。after 是最后收到的 seq，重连时靠它补齐断掉的那一段 */
export function eventsPath(id, after) {
  return '/ws/' + encodeURIComponent(id) + '/events?after=' + (Number(after) || 0);
}
