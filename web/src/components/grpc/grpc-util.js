/**
 * gRPC 标签页里的纯逻辑（第十一轮第 3 节）。
 *
 * 放在组件目录下（而不是 `@/utils/`）：这一轮会话允许改的路径只有
 * `web/src/components/grpc/`，纯函数跟着组件走也不会有人找不到。
 * 好处是和 `utils/preflight.js` 一样 —— 能单独跑真断言，不用起浏览器。
 */

/** 选中值用服务名 + 方法名拼：服务名里不会有 `|`（proto 的标识符限制） */
export function methodValue(service, method) {
  const svc = String(service || '').trim();
  const name = String(method || '').trim();
  if (!svc || !name) return '';
  return svc + '|' + name;
}

export function splitMethodValue(value) {
  const text = String(value || '');
  const index = text.indexOf('|');
  if (index === -1) return { service: '', method: '' };
  return { service: text.slice(0, index), method: text.slice(index + 1) };
}

/**
 * 服务 / 方法下拉的选项。
 *
 * - 标签写成「服务全名 / 方法名」：下拉收起之后就只剩一个方法名的话，
 *   同名方法分散在几个服务里时分不清选的是谁；
 * - 服务端流后面标一下（用户要知道这次会收到多行）；
 * - **客户端流 / 双向流列出来但不能选**（这一版后端不做），提示写在标签里 ——
 *   直接不列的话用户会以为 proto 没解析对。
 */
export function methodOptions(services) {
  const out = [];
  (services || []).forEach(function (service) {
    const name = String((service && service.name) || '');
    (service && service.methods ? service.methods : []).forEach(function (method) {
      if (!method || !method.name) return;

      const suffix = method.clientStreaming
        ? ' · 客户端流（不支持）'
        : (method.serverStreaming ? ' · 服务端流' : '');

      out.push({
        label: name + ' / ' + method.name + suffix,
        value: methodValue(name, method.name),
        disabled: method.clientStreaming === true
      });
    });
  });
  return out;
}

/** 从解析结果里找一条方法的完整描述（找不到给 null） */
export function findMethod(services, service, method) {
  const svc = (services || []).filter(function (item) {
    return item && item.name === service;
  })[0];
  if (!svc) return null;

  return (svc.methods || []).filter(function (item) {
    return item && item.name === method;
  })[0] || null;
}

/** 「生成示例」要填进去的文本：拿请求类型的 JSON 示例 */
export function exampleOf(services, service, method) {
  const found = findMethod(services, service, method);
  return found && found.example ? found.example : '';
}

/**
 * 复制为 grpcurl 命令。
 *
 * `-import-path . -proto <文件名>` 只是提醒用户 proto 文件要在本地那份 ——
 * grpcurl 直接读磁盘上的 .proto，而我们的 proto 是存在接口里的文本，
 * 所以命令里的名字按用户起的名字写，注释里说明这一点。
 *
 * @param {{target, tls, metadata, message, service, method, protoFiles}} input
 * @returns {string}
 */
export function grpcurlCommand(input) {
  const source = input || {};
  const parts = ['grpcurl'];

  if (source.tls !== true) parts.push('-plaintext');

  const message = String(source.message || '').trim();
  if (message) parts.push('-d', shellQuote(message));

  (source.metadata || []).forEach(function (row) {
    if (!row || row.enabled === false) return;
    const key = String(row.key === undefined || row.key === null ? '' : row.key).trim();
    if (!key) return;
    parts.push('-H', shellQuote(key + ': ' + String(row.value === undefined || row.value === null ? '' : row.value)));
  });

  const files = source.protoFiles || [];
  if (files.length) {
    parts.push('-import-path', '.', '-proto', shellQuote(files[0].name));
  }

  parts.push(String(source.target || '').trim() || '<host:port>');
  const service = String(source.service || '').trim();
  const method = String(source.method || '').trim();
  parts.push(service && method ? service + '/' + method : '<服务>/<方法>');

  let command = parts.join(' ');

  const notes = [];
  if (files.length > 1) {
    notes.push('这个接口有 ' + files.length + ' 个 proto 文件，命令里只带了第一个；把 import 到的其它文件也放到 -import-path 那一层');
  } else if (files.length) {
    notes.push('先把 ' + files[0].name + ' 存到当前目录（proto 存在接口里，grpcurl 读的是本地文件）');
  }
  if (notes.length) command += '\n\n# ' + notes.join('\n# ');

  return command;
}

/** shell 里单引号包起来；内容里的单引号按 `'\''` 转义 */
function shellQuote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

/** 状态码名 → naive-ui 的 tag 类型：只有 OK 是绿的 */
export function statusTagType(name) {
  return String(name || '').toUpperCase() === 'OK' ? 'success' : 'error';
}

/** 浏览器里的 JSON 文本 → 缩进过的文本（解析不了就原样返回） */
export function prettyJson(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch (err) {
    return raw;
  }
}

/**
 * 把一条消息包成 `BodyViewer` 认的响应对象。
 *
 * 复用响应面板那个组件是为了 JSON 树、格式化、复制、下载这些小功能不用再写一份；
 * 它读的就是这几个字段（headers / body / size / truncated）。
 *
 * **`headers` 是「[名字, 值] 的数组」**（和 HTTP 响应同一个形状，`headerValue` 按对遍历），
 * 给它一个对象会在渲染时炸 —— 自测里撞到过。
 */
export function messageResponse(data) {
  const body = JSON.stringify(data === undefined ? null : data, null, 2);
  return {
    headers: [['content-type', 'application/json']],
    body: body,
    size: byteLength(body),
    truncated: false,
    bodyEncoding: 'utf8'
  };
}

/** UTF-8 字节数（响应面板显示大小用的） */
export function byteLength(text) {
  const value = String(text === undefined || text === null ? '' : text);
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  return value.length;
}

/** `14:07:31.812`，服务端流每条消息旁边显示收到的时间 */
export function formatClock(ts) {
  const date = new Date(Number(ts) || Date.now());
  const pad = function (n, width) { return String(n).padStart(width || 2, '0'); };
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
    '.' + pad(date.getMilliseconds(), 3);
}

/** 超时的可填范围（和后端 `lib/grpc.js` 的上下界一致） */
export const DEADLINE_MIN = 1;
export const DEADLINE_MAX = 10 * 60 * 1000;
export const DEADLINE_DEFAULT = 10000;

/** 超时输入框 → 数字（认不出来就给默认值） */
export function clampDeadline(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEADLINE_DEFAULT;
  return Math.round(Math.min(DEADLINE_MAX, Math.max(DEADLINE_MIN, number)));
}

/** proto 文件的默认名字：new1.proto、new2.proto…… */
export function nextProtoName(files) {
  const taken = {};
  (files || []).forEach(function (file) { taken[String((file && file.name) || '')] = true; });
  for (let index = 1; index < 1000; index += 1) {
    const name = 'new' + index + '.proto';
    if (!taken[name]) return name;
  }
  return 'new.proto';
}
