import { del, post } from './client';

/**
 * TCP / UDP 调试会话（第十六轮）。
 *
 * 和 `api/mqtt.js` 一个套路：浏览器连不了内网设备（也开不了原始 socket），
 * 所以由服务端当客户端去连，前端只操作这几个接口。
 * 事件流同样是 NDJSON 长连接，用 `api/stream.js` 的 `getNdjson` 读。
 *
 * 和 Socket.IO / MQTT 一样，**建会话的请求体是平铺的**（不是 `{ spec }`）——
 * 服务端 `prepareSession` 直接从请求体上读 method / url / framing / udp，
 * 没有 `spec` 这一层（见 `lib/api/socket.js`）。
 */

/** 建会话。TCP 立刻开始连接，UDP 是绑本机端口。返回 `{ id, missing }` */
export function createSession(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/socket', payload);
}

/** 发一段数据。连接没打开（TCP 没连上 / UDP 没绑上 / 已 closed）时服务端返回 409 */
export function send(id, payload) {
  return post('/socket/' + encodeURIComponent(id) + '/send', payload);
}

/** 断开并销毁会话 */
export function destroySession(id) {
  return del('/socket/' + encodeURIComponent(id));
}

/** events 长连接的路径。after 是最后收到的 seq，重连时靠它补齐断掉的那一段 */
export function eventsPath(id, after) {
  return '/socket/' + encodeURIComponent(id) + '/events?after=' + (Number(after) || 0);
}
