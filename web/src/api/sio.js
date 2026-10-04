import { del, post } from './client';

/**
 * Socket.IO 调试会话（第九轮第 4 节）。
 *
 * 和 api/ws.js 一个套路：浏览器装不了 Socket.IO 的客户端（要连的地址多半在内网、
 * 还要带认证），所以由服务端当客户端去连，前端只操作这几个接口。
 * 事件流同样是 NDJSON 长连接，用 `api/stream.js` 的 getNdjson 读。
 */

/** 建会话，建好后服务端立刻开始连接 */
export function createSession(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/sio', payload);
}

/** 发一个事件。连接还没打开或者已经关闭时服务端返回 409 */
export function emitEvent(id, payload) {
  return post('/sio/' + encodeURIComponent(id) + '/send', payload);
}

/** 立刻销毁会话 */
export function destroySession(id) {
  return del('/sio/' + encodeURIComponent(id));
}

/** events 长连接的路径。after 是最后收到的 seq，重连时靠它补齐断掉的那一段 */
export function eventsPath(id, after) {
  return '/sio/' + encodeURIComponent(id) + '/events?after=' + (Number(after) || 0);
}
