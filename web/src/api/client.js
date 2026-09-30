/**
 * 管理台 API 的统一封装。
 *
 * 三件事收在这里，组件里就不用各写一遍：
 * - 所有路径都拼上 /__admin/api 前缀；
 * - 401 统一跳登录页（并返回一个永远不 resolve 的 Promise，避免后面的错误提示闪一下）；
 * - 失败时抛出的 Error.message 一定是可以直接给用户看的中文。
 */

export const API_PREFIX = '/__admin/api';

/** 当前 hash 形式的路径，用来在登录后跳回来。不是 #/ 开头就退回首页 */
export function currentHashPath() {
  const hash = window.location.hash;
  return hash && hash.indexOf('#/') === 0 ? hash : '#/';
}

export function redirectToLogin() {
  // 已经在登录页了就别再跳，否则会把自己套进去
  if (window.location.hash.indexOf('#/login') === 0) return;
  window.location.hash = '/login?next=' + encodeURIComponent(currentHashPath());
}

/** 永远不 resolve 的 Promise：登录态失效时用它把当前这条链路冻住 */
function pendingForever() {
  return new Promise(() => {});
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

async function toError(res) {
  const text = await res.text().catch(() => '');
  const data = parseJson(text);
  const message = data && data.error
    ? data.error
    : '请求失败（HTTP ' + res.status + '）';
  const error = new Error(message);
  error.status = res.status;
  error.data = data;
  return error;
}

/**
 * @param {string} method
 * @param {string} path 以 / 开头的接口路径，不含 /__admin/api 前缀
 * @param {any} [body] 会按 JSON 序列化
 * @param {{raw?: Blob|ArrayBuffer, headers?: object, contentType?: string, noAuthRedirect?: boolean}} [options]
 *        raw 用来直接发二进制（上传文件），此时 body 会被忽略；
 *        noAuthRedirect 给「探测登录态」这类调用用 —— 401 时照常抛错，不要跳登录页，
 *        否则路由守卫会被那个永不 resolve 的 Promise 挂住，登录页永远出不来
 */
export function request(method, path, body, options) {
  const opts = options || {};
  const init = {
    method: method,
    headers: Object.assign({}, opts.headers),
    credentials: 'same-origin'
  };

  if (opts.raw !== undefined && opts.raw !== null) {
    init.body = opts.raw;
    if (opts.contentType) init.headers['Content-Type'] = opts.contentType;
  } else if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  return fetch(API_PREFIX + path, init).then(
    async function (res) {
      if (res.status === 401) {
        if (opts.noAuthRedirect) throw await toError(res);
        redirectToLogin();
        return pendingForever();
      }
      if (!res.ok) throw await toError(res);

      const text = await res.text();
      const data = parseJson(text);
      if (data && data.ok === false) {
        const error = new Error(data.error || '请求失败');
        error.status = res.status;
        error.data = data;
        throw error;
      }
      return data || {};
    },
    function (err) {
      throw new Error('网络请求失败：' + (err && err.message ? err.message : '未知错误'));
    }
  );
}

export function get(path) {
  return request('GET', path);
}

export function post(path, body) {
  return request('POST', path, body);
}

export function put(path, body) {
  return request('PUT', path, body);
}

export function del(path) {
  return request('DELETE', path);
}

/**
 * 下载接口（导出 Postman 集合 / 环境）返回的是 JSON，但我们要按文件下载。
 * 这里直接拿原始响应，交给调用方生成 Blob。
 */
export async function requestBlob(method, path) {
  const res = await fetch(API_PREFIX + path, { method: method, credentials: 'same-origin' });
  if (res.status === 401) {
    redirectToLogin();
    return pendingForever();
  }
  if (!res.ok) throw await toError(res);
  return res.json();
}
