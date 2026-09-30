import { post, request } from './client';

/**
 * 发送请求改走流式接口了（契约第 14 节），实现在 `api/stream.js`：
 * 只有它能一边下一边显示，并且随时可以取消。`POST /send` 服务端仍然保留，
 * 但管理台不再用它，所以这里没有对应的封装。
 */

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
