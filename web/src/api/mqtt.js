import { del, post } from './client';

/**
 * MQTT 调试会话（第十三轮）。
 *
 * 和 `api/sio.js` 一个套路：浏览器连不了内网 broker（还要带用户名密码），
 * 所以由服务端当客户端去连，前端只操作这几个接口。
 * 事件流同样是 NDJSON 长连接，用 `api/stream.js` 的 `getNdjson` 读。
 *
 * 和 Socket.IO 不一样的一处：**建会话的请求体是平铺的**（不是 `{ spec }`）——
 * 服务端 `prepareSession` 直接从请求体上读 url / clientId / will / subscriptions，
 * 没有 `spec` 这一层（见 `lib/api/mqtt.js`）。
 */

/** 建会话，建好后服务端立刻开始连 broker。返回 `{ id, missing }` */
export function createSession(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/mqtt', payload);
}

/** 订阅一个主题。连接没打开时服务端返回 409 */
export function subscribe(id, payload) {
  return post('/mqtt/' + encodeURIComponent(id) + '/subscribe', payload);
}

/** 取消订阅 */
export function unsubscribe(id, payload) {
  return post('/mqtt/' + encodeURIComponent(id) + '/unsubscribe', payload);
}

/** 发布一条消息（QoS 1/2 要等 broker 确认后才出 `published` 事件） */
export function publish(id, payload) {
  return post('/mqtt/' + encodeURIComponent(id) + '/publish', payload);
}

/** 断开并销毁会话 */
export function destroySession(id) {
  return del('/mqtt/' + encodeURIComponent(id));
}

/** events 长连接的路径。after 是最后收到的 seq，重连时靠它补齐断掉的那一段 */
export function eventsPath(id, after) {
  return '/mqtt/' + encodeURIComponent(id) + '/events?after=' + (Number(after) || 0);
}
