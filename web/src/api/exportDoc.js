import { API_PREFIX, CUSTOM_HEADERS, redirectToLogin, toError } from './client';

/**
 * 导出接口文档（第九轮第 2 节）。
 *
 * 服务端**直接回文件**（带 Content-Disposition），不是 JSON —— 所以这里不用 `client.js`
 * 那几个封装（它们都假定响应是 JSON），自己拿原始响应交给调用方落盘。
 */

/** 从 `Content-Disposition` 里取文件名（优先 `filename*=UTF-8''…`，中文名只有它有） */
function fileNameFrom(header) {
  const text = String(header || '');

  const star = /filename\*=UTF-8''([^;]+)/i.exec(text);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch (err) {
      // 编码坏了就用兜底那个
    }
  }

  const plain = /filename="?([^";]+)"?/i.exec(text);
  return plain ? plain[1] : '';
}

/**
 * 下载一份接口文档。
 *
 * @param {string} pid
 * @param {{format?: 'md'|'html'|'docx', folderId?: string|null, examples?: boolean,
 *   mock?: boolean, doneOnly?: boolean, mockBase?: string}} options
 * @returns {Promise<{blob: Blob, filename: string}>}
 */
export async function downloadDoc(pid, options) {
  const opts = options || {};
  const params = new URLSearchParams();

  params.set('format', opts.format || 'md');
  if (opts.folderId) params.set('folderId', opts.folderId);
  params.set('examples', opts.examples === false ? '0' : '1');
  params.set('mock', opts.mock ? '1' : '0');
  params.set('doneOnly', opts.doneOnly ? '1' : '0');
  if (opts.mockBase) params.set('mockBase', opts.mockBase);

  const res = await fetch(
    API_PREFIX + '/projects/' + encodeURIComponent(pid) + '/export/doc?' + params.toString(),
    {
      method: 'GET',
      headers: Object.assign({}, CUSTOM_HEADERS),
      credentials: 'same-origin'
    }
  );

  if (res.status === 401) {
    redirectToLogin();
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) throw await toError(res);

  return {
    blob: await res.blob(),
    filename: fileNameFrom(res.headers.get('content-disposition'))
  };
}
