import { del, post } from './client';
import { getNdjson, postNdjson } from './stream';

/**
 * gRPC 调试（第十一轮第 3 节）。
 *
 * 和 api/sio.js 不一样：gRPC **没有会话**。一次调用就是一次 POST，
 * 服务端一边调一边把事件写成 NDJSON（start / metadata / message / end / error），
 * 所以这里两个接口就够了，事件流用 `api/stream.js` 的 postNdjson 读。
 *
 * 云端（网页版）挂的是空 router，这两条路都是 404 —— 界面上据此把「调用」灰掉。
 */

/** 解析 proto：服务清单 + 每个方法的请求示例 */
export function parseProto(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/grpc/parse', payload);
}

/** `/grpc/call` 的路径（postNdjson 要自己拼前缀） */
export function callPath(pid) {
  return '/projects/' + encodeURIComponent(pid) + '/grpc/call';
}

/**
 * 发起一次调用。
 *
 * @param {string} pid
 * @param {object} body `{ apiId?, environmentId?, url, tls, protoFiles, service, method, metadata, message, deadlineMs }`
 * @param {{signal?: AbortSignal, onEvent?: Function}} options
 */
export function call(pid, body, options) {
  return postNdjson(callPath(pid), body, options);
}

/**
 * 服务端反射（第十二轮第 1 节）：不用导 proto，直接问服务端要描述。
 *
 * @returns {Promise<{services: Array, descriptorSet: string, fetchedAt: number, tooLarge: boolean}>}
 *   `descriptorSet` 是 base64 的 FileDescriptorSet，存进 `extra.grpc.reflection` 随接口保存；
 *   超过 2 MB 时 `tooLarge: true`（没存下来，每次打开要重新获取）。
 */
export function reflect(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/grpc/reflect', payload);
}

/* ---------------- 客户端流 / 双向流的流式会话（第十二轮第 2 节） ---------------- */

/** 建流式会话，建好后服务端立刻开始连接 */
export function createStream(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/grpc/streams', payload);
}

/** 发一条消息（half-close 之前可以一直发） */
export function sendStreamMessage(id, message) {
  return post('/grpc/streams/' + encodeURIComponent(id) + '/send', { message: message });
}

/** 结束发送（half-close）：之后服务端还可以继续回消息直到结束 */
export function endStream(id) {
  return post('/grpc/streams/' + encodeURIComponent(id) + '/end');
}

/** 取消并删掉会话 */
export function destroyStream(id) {
  return del('/grpc/streams/' + encodeURIComponent(id));
}

/** events 长连接的路径。after 是最后收到的 seq，重连时靠它补齐断掉的那一段 */
export function streamEventsPath(id, after) {
  return '/grpc/streams/' + encodeURIComponent(id) + '/events?after=' + (Number(after) || 0);
}

/** 收流式会话的事件（NDJSON 长连接） */
export function readStreamEvents(id, options) {
  const opts = options || {};
  return getNdjson(streamEventsPath(id, opts.after), opts);
}
