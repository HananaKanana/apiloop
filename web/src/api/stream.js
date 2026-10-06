import { API_PREFIX, CUSTOM_HEADERS, redirectToLogin, toError } from './client';
import { t } from '@/i18n';

/**
 * NDJSON 长连接的读取（契约第 14、15 节）。
 *
 * 服务端每行写一个 JSON 事件，收到就立刻处理 —— 这样 SSE 能实时看到，
 * 大响应也能一边下一边显示进度。用 fetch 而不是 EventSource，
 * 因为要能 abort、能带 POST 请求体、能看响应头。
 *
 * 两个坑都在这里处理掉：
 * - 一行可能被切在两次 read() 之间 → 自己按行缓冲；
 * - 多字节字符可能被切在两次 read() 之间 → TextDecoder 的 { stream: true }。
 */

function abortError() {
  const error = new Error(t('api.cancelled'));
  error.aborted = true;
  return error;
}

async function readStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  function emit(line) {
    const text = line.trim();
    if (!text) return;
    let event;
    try {
      event = JSON.parse(text);
    } catch (err) {
      // 半行、坏行都跳过：一条坏数据不该把整个连接判死
      return;
    }
    if (onEvent) onEvent(event);
  }

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let index = buffer.indexOf('\n');
      while (index !== -1) {
        emit(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    }
    // 收尾：把解码器里剩下的字节吐出来，再处理没有换行结尾的最后一行
    buffer += decoder.decode();
    if (buffer) emit(buffer);
  } catch (err) {
    if (err && err.name === 'AbortError') throw abortError();
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch (err) {
      // 已经断开时 releaseLock 会抛，忽略
    }
  }
}

async function run(promise, onEvent, onOpen) {
  let res;
  try {
    res = await promise;
  } catch (err) {
    if (err && err.name === 'AbortError') throw abortError();
    throw new Error(t('api.networkFailed', { message: (err && err.message) || t('api.unknownError') }));
  }

  if (res.status === 401) {
    // 和 client.js 一样跳登录页；抛一个「已取消」的错，避免界面上再闪一条错误提示
    redirectToLogin();
    throw abortError();
  }
  if (!res.ok) throw await toError(res);
  if (!res.body) throw new Error(t('api.noStreamSupport'));

  // 长连接建立了（响应头到了）。重连成功时靠它把「重连中」的状态收回来 ——
  // 重连后服务端只补发 seq 之后的事件，不会再发一次 open 事件。
  if (onOpen) onOpen(res);

  return readStream(res, onEvent);
}

/**
 * @param {string} path 以 / 开头的接口路径，不含 /__admin/api 前缀
 * @param {any} body 按 JSON 序列化
 * @param {{signal?: AbortSignal, onEvent?: (event: object) => void, onOpen?: (res: Response) => void}} options
 */
export function postNdjson(path, body, options) {
  const opts = options || {};
  const init = {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, CUSTOM_HEADERS),
    body: JSON.stringify(body),
    credentials: 'same-origin'
  };
  if (opts.signal) init.signal = opts.signal;

  return run(fetch(API_PREFIX + path, init), opts.onEvent, opts.onOpen);
}

export function getNdjson(path, options) {
  const opts = options || {};
  const init = {
    method: 'GET',
    headers: Object.assign({}, CUSTOM_HEADERS),
    credentials: 'same-origin'
  };
  if (opts.signal) init.signal = opts.signal;

  return run(fetch(API_PREFIX + path, init), opts.onEvent, opts.onOpen);
}
