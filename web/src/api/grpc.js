import { post } from './client';
import { postNdjson } from './stream';

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
