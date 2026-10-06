/**
 * 管理台 API 的统一封装。
 *
 * 三件事收在这里，组件里就不用各写一遍：
 * - 所有路径都拼上 /__admin/api 前缀；
 * - 401 统一跳登录页（并返回一个永远不 resolve 的 Promise，避免后面的错误提示闪一下）；
 * - 失败时抛出的 Error.message 一定是可以直接给用户看的中文。
 */

import { currentLocale } from '@/i18n';

export const API_PREFIX = '/__admin/api';

/**
 * 每个请求都带上的自定义头。
 *
 * 本地网关靠它把「别的网站借本机网关读数据 / 发请求」挡在外面：别的网站要带自定义头
 * 就得先过跨域预检，而网关的预检（OPTIONS）是一刀切 403 的。直接访问云端时云端会忽略它。
 * 见 `lib/gateway/index.js` 的 `createGuard`。
 */
export const CUSTOM_HEADERS = { 'X-Apiloop': '1' };

/**
 * 界面语言（第十五轮）：每个请求都带上，给后端以后按语言返回错误信息用
 * （这一轮后端还没用，先发过去）。
 */
function acceptLanguage() {
  return currentLocale() === 'en' ? 'en' : 'zh-CN';
}

/**
 * 请求头：自定义头 + 语言。请求体相关的头（Content-Type）由调用处再补。
 */
function baseHeaders() {
  return Object.assign({}, CUSTOM_HEADERS, { 'Accept-Language': acceptLanguage() });
}

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

/**
 * 把失败响应转成可以直接给用户看的 Error。
 * 导出是给 stream.js 用的：流式接口在返回 200 之前出错时也是普通 JSON，
 * 必须和普通接口抛出一模一样的错误，上层处理 403 / 404 的代码才不用改。
 */
export async function toError(res) {
  const text = await res.text().catch(() => '');
  const data = parseJson(text);
  const message = data && data.error
    ? data.error
    : t('api.httpFailed', { status: res.status });
  const error = new Error(message);
  error.status = res.status;
  error.data = data;
  return error;
}

/**
 * 网关对「只有云端有的功能」（改密码、用户管理、成员管理、mock 日志、安装包列表）
 * 在没登录时返回 409 + `code: 'LOGIN_REQUIRED'`。
 *
 * 这**不算出错** —— 只是这个功能要先登录 —— 所以调用方应该用 `message.warning` 提示，
 * 而且**不要跳登录页**（`request` 只在 401 时跳，409 不会）。
 *
 * 这些功能的入口在没登录时本来就是藏起来的，所以这是兜底路径：
 * 页面开着的时候登录态变了（比如会话过期），才会走到这里。
 */
export function isLoginRequired(err) {
  return Boolean(err && err.status === 409 && err.data && err.data.code === 'LOGIN_REQUIRED');
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
    headers: Object.assign(baseHeaders(), opts.headers),
    credentials: 'same-origin'
  };

  if (opts.raw !== undefined && opts.raw !== null) {
    init.body = opts.raw;
    if (opts.contentType) init.headers['Content-Type'] = opts.contentType;
  } else if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  // 发送请求的「取消」靠它：abort 之后 fetch 会 reject，调用方自己识别
  if (opts.signal) init.signal = opts.signal;

  return fetch(API_PREFIX + path, init).then(
    async function (res) {
      if (res.status === 401) {
        if (opts.noAuthRedirect) throw await toError(res);
        redirectToLogin();
        return pendingForever();
      }
      if (!res.ok) {
        const error = await toError(res);
        // 密码被管理员重置过、还没改：去「请先修改密码」页（服务端除了改密码之外的接口都会拒绝）
        if (res.status === 403 && error.data && error.data.code === 'PASSWORD_CHANGE_REQUIRED') {
          if (window.location.hash.indexOf('#/change-password') !== 0) {
            window.location.hash = '/change-password';
          }
          return pendingForever();
        }
        throw error;
      }

      const text = await res.text();
      const data = parseJson(text);
      if (data && data.ok === false) {
        const error = new Error(data.error || t('api.failed'));
        error.status = res.status;
        error.data = data;
        throw error;
      }
      return data || {};
    },
    function (err) {
      if (err && err.name === 'AbortError') {
        const aborted = new Error(t('api.cancelled'));
        aborted.aborted = true;
        throw aborted;
      }
      throw new Error(t('api.networkFailed', { message: (err && err.message) || t('api.unknownError') }));
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
  const res = await fetch(API_PREFIX + path, {
    method: method,
    headers: baseHeaders(),
    credentials: 'same-origin'
  });
  if (res.status === 401) {
    redirectToLogin();
    return pendingForever();
  }
  if (!res.ok) throw await toError(res);
  return res.json();
}
