import { post, request } from './client';

/**
 * 发送请求。request 是当前编辑中的 spec，不需要先保存。
 * signal 用来取消（前端点「取消」时 abort）。
 */
export function send(pid, payload, signal) {
  return request('POST', '/projects/' + encodeURIComponent(pid) + '/send', payload, {
    signal: signal
  });
}

/**
 * 上传文件（formdata 的文件行、binary 模式都用它）。
 * 请求体是文件原始字节，文件名放在 X-Filename 里并按 URL 编码。
 */
export function uploadFile(pid, file) {
  return request('POST', '/projects/' + encodeURIComponent(pid) + '/files', null, {
    raw: file,
    contentType: 'application/octet-stream',
    headers: { 'X-Filename': encodeURIComponent(file.name) }
  });
}

/** 纯解析接口：给 Mock 页签的「预览」用，不写库 */
export function preview(route) {
  return post('/preview', { route: route });
}
