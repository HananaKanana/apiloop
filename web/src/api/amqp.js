import { del, post } from './client';

/**
 * RabbitMQ（AMQP 0-9-1）调试会话（第十六轮 T41）。
 *
 * 和 `api/mqtt.js` / `api/socket.js` 一个套路：浏览器连不了内网 broker（还要带用户名密码），
 * 所以由服务端当客户端去连，前端只操作这几个接口。
 * 事件流同样是 NDJSON 长连接，用 `api/stream.js` 的 `getNdjson` 读。
 *
 * 和 Socket.IO / MQTT / TCP 一样，**建会话的请求体是平铺的**（不是 `{ spec }`）——
 * 服务端 `prepareSession` 直接从请求体上读 url / username / password / consumers，
 * 没有 `spec` 这一层（见 `lib/api/amqp.js`）。
 *
 * 和 MQTT 不一样的地方：一个会话里能同时开好几个 consumer（`consume` / `cancel`），
 * 手动确认的消息还要回 `ack` / `nack` / `reject`（`ack`），发消息走 confirm channel
 * （`publish` 返回时 broker 已经确认），另外多一个查队列堆积的 `queueInfo`。
 */

/** 建会话，建好后服务端立刻开始连 broker。返回 `{ id, missing }` */
export function createSession(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/amqp', payload);
}

/** 开一个消费者。连接没打开时服务端返回 409 */
export function consume(id, payload) {
  return post('/amqp/' + encodeURIComponent(id) + '/consume', payload);
}

/** 取消一个消费者 */
export function cancel(id, payload) {
  return post('/amqp/' + encodeURIComponent(id) + '/cancel', payload);
}

/** 回确认：`{ deliveryTag, action: 'ack'|'nack'|'reject', requeue }` */
export function ack(id, payload) {
  return post('/amqp/' + encodeURIComponent(id) + '/ack', payload);
}

/** 发布一条消息（confirm channel：broker 确认后才出 `published` 事件） */
export function publish(id, payload) {
  return post('/amqp/' + encodeURIComponent(id) + '/publish', payload);
}

/** 查一个队列的消息数和消费者数：`{ queue }` */
export function queueInfo(id, payload) {
  return post('/amqp/' + encodeURIComponent(id) + '/queue-info', payload);
}

/** 断开并销毁会话 */
export function destroySession(id) {
  return del('/amqp/' + encodeURIComponent(id));
}

/** events 长连接的路径。after 是最后收到的 seq，重连时靠它补齐断掉的那一段 */
export function eventsPath(id, after) {
  return '/amqp/' + encodeURIComponent(id) + '/events?after=' + (Number(after) || 0);
}
