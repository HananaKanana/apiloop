/**
 * repo 行对象 → 接口 DTO，以及入参清洗。
 *
 * 为什么要多这一层：repo 返回的是**表的形状**，接口给的是**契约的形状**，两者并不相同 ——
 * 契约里的 Project 有 `isRoot`（跟进程有关，库里没有），又刻意不要 `scripts` / `extra`
 * （前端用不上）；Api 要把 apis 的平铺列收进一个 `mock: {...}` 子对象。
 * 把这些差异集中在这里，路由文件就只剩「校验 + 调 repo + 回 DTO」。
 *
 * 另一件事是**入参清洗**：客户端传来的数组和对象一律不可信，行列形状、布尔列都要
 * 规整过再写库，否则脏数据会一层层流到前端。
 */

var access = require('../access');
var respond = require('./respond');
var secrets = require('../secrets');
var assertionsModule = require('../assertions');
var dbOpsModule = require('../db-ops');
var grpcModule = require('../grpc');
var mqttSessions = require('../mqtt-sessions');
var projectsRepo = require('../db/repos/projects');

/** 请求体里允许出现的模式，和契约的 RequestSpec.body.mode 一致 */
var BODY_MODES = ['none', 'raw', 'urlencoded', 'formdata', 'binary', 'graphql'];

/** Socket.IO 的传输方式（第九轮第 4 节）：只有这两档，见 lib/sio-sessions.js */
var SIO_TRANSPORTS = ['polling', 'websocket'];

/** gRPC 的描述来源（第十二轮第 1 节）：导进来的 proto 文件，或者反射拉回来的 */
var GRPC_SOURCES = ['proto', 'reflection'];

/** MQTT 的 keepalive 默认值（秒）；0 是合法的，表示不发心跳 */
var MQTT_DEFAULT_KEEPALIVE = 60;

/** MQTT 连接超时的上下界（毫秒）：太小会和「手动断开」分不清，太大等于没有 */
var MQTT_MIN_CONNECT_TIMEOUT_MS = 1000;
var MQTT_MAX_CONNECT_TIMEOUT_MS = 60 * 1000;

function str(value) {
    if (value === null || value === undefined) return '';
    return String(value);
}

/**
 * 变量行：`{ key, value, enabled, secret?, desc? }`。
 * 空 key 的行没有意义，直接丢掉 —— 界面上新建一行还没填名字是常事。
 */
function toVarRows(list) {
    if (!Array.isArray(list)) return [];

    var rows = [];
    list.forEach(function (item) {
        if (!item || typeof item !== 'object') return;

        var key = str(item.key);
        if (!key) return;

        var row = { key: key, value: str(item.value), enabled: item.enabled !== false };
        if (item.secret) row.secret = true;
        if (item.desc) row.desc = str(item.desc);
        rows.push(row);
    });
    return rows;
}

/** 只留下能安全 JSON 化的键；不是对象就当没传 */
function plainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    var result = {};
    Object.keys(value).forEach(function (key) {
        var item = value[key];
        if (item === undefined || typeof item === 'function') return;
        result[key] = item;
    });
    return result;
}

/** 鉴权：`null | { type, ... }`。没有 type 的不认，避免存进去一个没法用的对象 */
function toAuth(value) {
    var auth = plainObject(value);
    if (!auth || !auth.type) return null;
    return auth;
}

/** 扩展字段：各层没被映射到的原始字段，原样存 */
function toExtra(value) {
    return plainObject(value) || {};
}

/**
 * 参数 / 请求头 / 查询串的行：`{ key, value, type, required, desc, enabled }`。
 * 契约给了默认值，这里一律补全，前端不用自己兜底。
 */
function toRows(list) {
    if (!Array.isArray(list)) return [];

    var rows = [];
    list.forEach(function (item) {
        if (!item || typeof item !== 'object') return;

        var key = str(item.key);
        if (!key) return;

        rows.push({
            key: key,
            value: str(item.value),
            type: str(item.type) || 'string',
            required: item.required === true,
            desc: str(item.desc),
            enabled: item.enabled !== false
        });
    });
    return rows;
}

/** 表单行 = 普通行 + `kind`（text / file）与 `src`（本地文件路径，file 才有） */
function toFormRows(list) {
    if (!Array.isArray(list)) return [];

    var rows = [];
    list.forEach(function (item) {
        if (!item || typeof item !== 'object') return;

        var key = str(item.key);
        if (!key) return;

        // 不能拿 toRows 的结果再按下标回去找原对象：它会过滤掉空 key 的行，
        // 下标就对不上了，kind / src 会串到别的行上去。
        var kind = item.kind === 'file' ? 'file' : 'text';
        rows.push({
            key: key,
            value: str(item.value),
            type: str(item.type) || 'string',
            required: item.required === true,
            desc: str(item.desc),
            enabled: item.enabled !== false,
            kind: kind,
            src: kind === 'file' && item.src !== undefined && item.src !== null ? str(item.src) : null
        });
    });
    return rows;
}

/**
 * 请求体。只保留当前 mode 用得上的那几个字段 —— 切模式之后留着旧模式的残留，
 * 导出成 Postman 时会把两个模式的内容一起写出去。
 */
function toBody(value) {
    var body = plainObject(value) || {};
    var mode = BODY_MODES.indexOf(str(body.mode)) > -1 ? str(body.mode) : 'none';

    var result = { mode: mode };

    if (mode === 'raw') {
        result.raw = str(body.raw);
        result.language = str(body.language) || 'text';
    }
    if (mode === 'urlencoded' || mode === 'formdata') {
        result.form = toFormRows(body.form);
    }
    if (mode === 'binary') {
        var file = plainObject(body.file) || {};
        result.file = { src: file.src === undefined || file.src === null ? null : str(file.src) };
    }
    if (mode === 'graphql') {
        var graphql = plainObject(body.graphql) || {};
        result.graphql = { query: str(graphql.query), variables: str(graphql.variables) };
    }

    return result;
}

/** 请求参数三件套 */
function toParams(value) {
  var params = plainObject(value) || {};
  return {
    path: toRows(params.path),
    query: toRows(params.query),
    headers: toRows(params.headers)
  };
}

/* ------------------------------------------------------------------ 接口的状态与负责人 */

/**
 * 状态和负责人（第四轮第 1 节）存在 `apis.extra` 里，没占新列 —— 那一列本来就会同步，
 * 所以两台设备之间天然能对上，也不用动迁移。
 *
 * 取的时候**不认识的照原样给出去**：以后加了新状态，旧客户端至少不会把它弄丢
 * （界面按「未设置」显示，只有用户主动改过才会被换掉）。
 */
var API_STATUSES = ['designing', 'developing', 'done', 'deprecated'];

function extraOf(api) {
  var extra = api && api.extra;
  return extra && typeof extra === 'object' ? extra : {};
}

/** `apis.extra.status`，没设过是 null */
function apiStatusOf(api) {
  var value = extraOf(api).status;
  return typeof value === 'string' && value ? value : null;
}

/** `apis.extra.ownerId`，没设过是 null */
function apiOwnerOf(api) {
  var value = extraOf(api).ownerId;
  return typeof value === 'string' && value ? value : null;
}

/* ------------------------------------------------------------------ 响应字段说明 */

/**
 * 响应字段说明（第六轮第 2 节）：`[{ path, type, desc, required }]`，
 * `path` 形如 `data.list[].id`（数组元素写成 `list[]`，不按下标展开）。
 *
 * 和状态 / 负责人一样存在 `apis.extra` 里，不占新列。读的时候宽容一点：
 * 路径为空、或者同一个路径重复出现的行直接丢掉 —— 表格是按路径唯一的，
 * 留着重复行只会让界面上出现两行一模一样的。
 */
function toResponseFields(list) {
  if (!Array.isArray(list)) return [];

  var out = [];
  var seen = {};

  list.forEach(function (item) {
    if (!item || typeof item !== 'object') return;

    var path = str(item.path).trim();
    if (!path || seen[path]) return;
    seen[path] = true;

    out.push({
      path: path,
      type: str(item.type) || 'string',
      desc: str(item.desc),
      required: item.required === true
    });
  });

  return out;
}

/** `apis.extra.responseFields`，没写过是空数组 */
function apiResponseFieldsOf(api) {
  return toResponseFields(extraOf(api).responseFields);
}

/* ------------------------------------------------------------------ Mock 故障模拟 */

/**
 * Mock 故障模拟（第七轮第 1 节）：`projects.extra.mockFaults`。
 *
 * ```
 * { enabled, scope: { type: 'all'|'folders'|'apis', ids: [] },
 *   rules: [{ id, enabled, type, percent, status?, body?, minMs?, maxMs?, timeoutMs?, retryAfter? }] }
 * ```
 *
 * 这份设置**会同步**（住在会同步的 extra 列里），而且**所有调这个项目 Mock 的人都受影响**
 * —— 所以读的时候要把数值夹到合理区间：比例 0–100、状态码 100–599，
 * 一个手改库写进来的 `percent: 5000` 不该让 mock 每次都故障。
 */
var FAULT_TYPES = ['error', 'delay', 'timeout', 'disconnect', 'throttle'];
var FAULT_SCOPES = ['all', 'folders', 'apis'];

function clampNumber(value, min, max, fallback) {
  var number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function toMockFaults(value) {
  if (!value || typeof value !== 'object') return null;

  var rules = [];
  (Array.isArray(value.rules) ? value.rules : []).forEach(function (rule) {
    if (!rule || typeof rule !== 'object') return;

    var type = FAULT_TYPES.indexOf(String(rule.type)) > -1 ? String(rule.type) : '';
    if (!type) return;

    var next = {
      id: str(rule.id),
      enabled: rule.enabled !== false,
      type: type,
      percent: clampNumber(rule.percent, 0, 100, 100)
    };

    if (type === 'error') {
      next.status = clampNumber(rule.status, 100, 599, 500);
      next.body = str(rule.body);
    } else if (type === 'delay') {
      next.minMs = clampNumber(rule.minMs, 0, 10 * 60 * 1000, 1000);
      next.maxMs = clampNumber(rule.maxMs, 0, 10 * 60 * 1000, 3000);
      if (next.maxMs < next.minMs) next.maxMs = next.minMs;
    } else if (type === 'timeout') {
      next.timeoutMs = clampNumber(rule.timeoutMs, 0, 10 * 60 * 1000, 30000);
    } else if (type === 'throttle') {
      next.retryAfter = clampNumber(rule.retryAfter, 0, 24 * 60 * 60, 1);
    }

    rules.push(next);
  });

  var scope = value.scope && typeof value.scope === 'object' ? value.scope : {};
  var scopeType = FAULT_SCOPES.indexOf(String(scope.type)) > -1 ? String(scope.type) : 'all';
  var ids = (Array.isArray(scope.ids) ? scope.ids : []).map(function (id) {
    return str(id);
  }).filter(function (id) { return id !== ''; });

  return {
    enabled: value.enabled === true,
    scope: { type: scopeType, ids: scopeType === 'all' ? [] : ids },
    rules: rules
  };
}

/** `projects.extra.mockFaults`，没设过是 null */
function projectMockFaultsOf(project) {
  return toMockFaults(extraOf(project).mockFaults);
}

/**
 * 可视化断言与提取变量（第六轮第 1 节）：`[{ id, enabled, source, path, op, value }]` 和
 * `[{ id, enabled, source, path, scope, name }]`，和状态 / 负责人一样住在 `apis.extra` 里。
 *
 * 清洗规则全在 `lib/assertions.js`（执行时要用的也是那一份），这里只是取一下 ——
 * 两边各写一套的话，「读出来能显示、跑起来却被丢掉」这种偏差迟早会出现。
 */
function apiAssertionsOf(api) {
  return assertionsModule.toAssertions(extraOf(api).assertions);
}

function apiExtractsOf(api) {
  return assertionsModule.toExtracts(extraOf(api).extracts);
}

/* ------------------------------------------------------------------ 数据库操作 */

/**
 * 数据库连接（第九轮第 3 节）：`projects.extra.databases`。
 *
 * `[{ id, name, type: 'mysql' | 'postgres' | 'redis', host, port, user, password, database }]`。
 * 连接是**项目级**的（一个项目里所有接口共用），密码跟着项目同步给所有成员 ——
 * 所以设置页会提示「建议用保密变量」。
 *
 * 清洗规则全在 `lib/db-ops.js`（执行时要用的也是那一份），这里只是取一下。
 */
function projectDatabasesOf(project) {
  return dbOpsModule.toDatabases(extraOf(project).databases);
}

/** `apis.extra.dbOps`，没写过是空数组 */
function apiDbOpsOf(api) {
  return dbOpsModule.toDbOps(extraOf(api).dbOps);
}

/* ------------------------------------------------------------------ Socket.IO */

/**
 * Socket.IO 接口的连接参数与「常用发送」（第九轮第 4 节）：住在 `apis.extra.sio`。
 *
 * `{ path, namespace, transports, listenEvents, sends: [{ id, event, args, ack }] }`。
 * 地址和请求头沿用接口自己的 `url` / `params.headers` / `auth` —— 那是所有接口共用的字段，
 * 没必要在 sio 里再存一份（存两份迟早有一份是旧的）。
 *
 * `sends[].args` 存的是**用户写的 JSON 原文**（字符串）：界面上就是那个输入框，
 * 原样存原样读，格式化、注释、缩进都不会丢。
 *
 * 返回 null 表示「没配过」—— 界面上拿默认值（`/socket.io`、`/`、先长轮询）。
 */
function toApiSio(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  var transports = str(value.transports);
  var listens = Array.isArray(value.listenEvents) ? value.listenEvents : [];
  var sends = Array.isArray(value.sends) ? value.sends : [];
  var path = str(value.path).trim() || '/socket.io';
  var namespace = str(value.namespace).trim() || '/';

  // 前导 / 在这里补齐：path 和 namespace 都是路径，少了斜杠拼出来的地址是错的，
  // 让用户自己去补太容易漏（client 那边还会再兜一次，这里要先存成规范形状）
  if (path.charAt(0) !== '/') path = '/' + path;
  if (namespace.charAt(0) !== '/') namespace = '/' + namespace;

  return {
    path: path,
    namespace: namespace,
    transports: SIO_TRANSPORTS.indexOf(transports) > -1 ? transports : 'polling',
    // 握手时的 auth（JSON 对象，可以写 {{变量}}）。以前这里漏了，保存接口时就被丢掉
    auth: value.auth && typeof value.auth === 'object' && !Array.isArray(value.auth) ? value.auth : null,
    listenEvents: listens.map(function (item) {
      return str(item).trim();
    }).filter(Boolean),
    sends: sends.filter(function (item) {
      return item && typeof item === 'object' && str(item.event).trim() !== '';
    }).map(function (item, index) {
      return {
        id: str(item.id).trim() || ('s' + index),
        event: str(item.event).trim(),
        args: str(item.args),
        ack: item.ack === true
      };
    })
  };
}

function apiSioOf(api) {
  return toApiSio(extraOf(api).sio);
}

/* ------------------------------------------------------------------ gRPC */

/**
 * gRPC 接口的连接参数（第十一轮第 1 节）：住在 `apis.extra.grpc`。
 *
 * `{ source, protoFiles, reflection, service, method, tls, metadata, message, deadlineMs,
 * savedMessages }`。
 * 地址沿用接口自己的 `url`（`host:port`；写成 `grpcs://` 就是开 TLS）—— 那是所有接口
 * 共用的字段，没必要在 grpc 里再存一份（存两份迟早有一份是旧的）。
 *
 * `message` 和 `savedMessages[].message` 存的是**用户写的 JSON 原文**（字符串）：
 * 界面上就是那个输入框，格式化、缩进原样存原样读。因为 int64 按字符串收发，
 * 用户手写的 `"seq": "9007199254740993"` 也不会在存的过程中被改掉。
 *
 * 返回 null 表示「没配过」—— 界面上拿默认值。
 */
function toApiGrpc(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  var files = Array.isArray(value.protoFiles) ? value.protoFiles : [];
  var metadata = Array.isArray(value.metadata) ? value.metadata : [];
  var saved = Array.isArray(value.savedMessages) ? value.savedMessages : [];
  var deadline = Number(value.deadlineMs);

  return {
    // 这次用哪份描述：导进来的 proto 文件，还是反射拉回来的（第十二轮第 1 节）。
    // 认不出来的值一律当 proto —— 老数据里没有这个字段，也要能正常打开
    source: GRPC_SOURCES.indexOf(str(value.source)) > -1 ? str(value.source) : 'proto',
    protoFiles: files.filter(function (item) {
      return item && typeof item === 'object' && str(item.name).trim() !== '';
    }).map(function (item) {
      return { name: str(item.name).trim(), content: str(item.content) };
    }),
    reflection: toGrpcReflection(value.reflection),
    service: str(value.service).trim(),
    method: str(value.method).trim(),
    tls: value.tls === true,
    // metadata 的行只留这三格：其他接口那种「必填 / 说明」在 gRPC 上没有意义
    metadata: metadata.filter(function (item) {
      return item && typeof item === 'object' && str(item.key).trim() !== '';
    }).map(function (item) {
      return {
        key: str(item.key).trim(),
        value: str(item.value),
        enabled: item.enabled !== false
      };
    }),
    message: str(value.message),
    // 超时的上下界和 lib/grpc.js 里那两条一致：太小会和「手动取消」分不清，太大等于没有
    deadlineMs: Number.isFinite(deadline)
      ? Math.round(Math.min(grpcModule.MAX_DEADLINE_MS, Math.max(grpcModule.MIN_DEADLINE_MS, deadline)))
      : grpcModule.DEFAULT_DEADLINE_MS,
    savedMessages: saved.filter(function (item) {
      return item && typeof item === 'object' && str(item.name).trim() !== '';
    }).map(function (item) {
      return { name: str(item.name).trim(), message: str(item.message) };
    })
  };
}

/**
 * 反射拿回来的那份描述（`extra.grpc.reflection`）。
 *
 * **超过 2 MB 直接丢掉、返回 null**：这个字段是跟着接口一起同步给项目里所有人的，
 * 一个几 MB 的 base64 每次同步都要传一遍不值当。丢掉的只是「不用导 proto 也能调」这个便利，
 * 界面上会给一句提示（`/grpc/reflect` 响应里的 `tooLarge`）。
 */
function toGrpcReflection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  var descriptorSet = str(value.descriptorSet).trim();
  if (!descriptorSet) return null;
  if (Buffer.byteLength(descriptorSet, 'utf8') > grpcModule.MAX_DESCRIPTOR_SET_BYTES) return null;

  var fetchedAt = Number(value.fetchedAt);

  return {
    descriptorSet: descriptorSet,
    fetchedAt: Number.isFinite(fetchedAt) && fetchedAt > 0 ? Math.round(fetchedAt) : Date.now()
  };
}

function apiGrpcOf(api) {
  return toApiGrpc(extraOf(api).grpc);
}

/* ------------------------------------------------------------------ MQTT */

/** keepalive：不填给 60，填 0 就是「不发心跳」，负数 / 乱填回默认 */
function toKeepalive(value) {
  if (value === '' || value === null || value === undefined) return MQTT_DEFAULT_KEEPALIVE;

  var num = Number(value);
  if (!Number.isFinite(num) || num < 0) return MQTT_DEFAULT_KEEPALIVE;
  return Math.min(65535, Math.round(num));
}

/** 连接超时：不填给 10 秒，超出上下界的夹回来 */
function toConnectTimeout(value) {
  if (value === '' || value === null || value === undefined) return mqttSessions.CONNECT_TIMEOUT_MS;

  var num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return mqttSessions.CONNECT_TIMEOUT_MS;
  return Math.min(MQTT_MAX_CONNECT_TIMEOUT_MS, Math.max(MQTT_MIN_CONNECT_TIMEOUT_MS, Math.round(num)));
}

/**
 * MQTT 接口的连接参数（第十三轮）：住在 `apis.extra.mqtt`。
 *
 * `{ clientId, username, password, protocolVersion, clean, keepalive, connectTimeoutMs,
 * will, subscriptions, saved }`。
 * 地址沿用接口自己的 `url`（`mqtt://host:1883`、`mqtts://`、`ws://`、`wss://`）——
 * 那是所有接口共用的字段，没必要在 mqtt 里再存一份（存两份迟早有一份是旧的）。
 *
 * - `will.topic` 为空表示**没有遗嘱消息**（界面上「不填就是不设」）；
 * - `saved` 是「常用发布」，`payload` 存的是**用户写的原文**（界面上就是一个输入框，
 *   格式化、缩进原样存原样读）；
 * - `protocolVersion` 和 `qos` 的判定只有 `lib/mqtt-sessions.js` 那一份 —— 真连 broker
 *   时用的就是它，两处不能各写一套。
 *
 * 返回 null 表示「没配过」—— 界面上拿默认值。
 */
function toApiMqtt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  var will = value.will && typeof value.will === 'object' && !Array.isArray(value.will)
    ? value.will
    : null;
  var subscriptions = Array.isArray(value.subscriptions) ? value.subscriptions : [];
  var saved = Array.isArray(value.saved) ? value.saved : [];

  return {
    clientId: str(value.clientId),
    username: str(value.username),
    password: str(value.password),
    protocolVersion: mqttSessions.toProtocolVersion(value.protocolVersion),
    clean: value.clean !== false,
    keepalive: toKeepalive(value.keepalive),
    connectTimeoutMs: toConnectTimeout(value.connectTimeoutMs),
    // 遗嘱的四格总在这里（不管有没有用）：界面上那个折叠面板展开就是要填这四样
    will: {
      topic: will ? str(will.topic) : '',
      payload: will ? str(will.payload) : '',
      qos: mqttSessions.toQos(will && will.qos, 0),
      retain: Boolean(will && will.retain === true)
    },
    // 订阅行：空主题没有意义（界面上新建一行还没填是常事），直接丢掉
    subscriptions: subscriptions.filter(function (item) {
      return item && typeof item === 'object' && str(item.topic).trim() !== '';
    }).map(function (item) {
      return {
        topic: str(item.topic).trim(),
        qos: mqttSessions.toQos(item.qos, 0),
        enabled: item.enabled !== false
      };
    }),
    // 常用发布：只要有个名字就留着（主题可以先空着，选的时候再填）
    saved: saved.filter(function (item) {
      return item && typeof item === 'object' && str(item.name).trim() !== '';
    }).map(function (item) {
      return {
        name: str(item.name).trim(),
        topic: str(item.topic).trim(),
        payload: str(item.payload),
        qos: mqttSessions.toQos(item.qos, 0),
        retain: item.retain === true
      };
    })
  };
}

function apiMqttOf(api) {
  return toApiMqtt(extraOf(api).mqtt);
}

/* ------------------------------------------------------------------ 前置接口 */

/**
 * 前置接口设置（第十轮第 3 节）：`{ apiId, whenMissing, retryOn401 }`，住在 `extra.preflight`。
 *
 * - `apiId` 为 **null** 表示**显式「这里不用前置接口」** —— 目录上用它挡住往上找
 *   （「没配过」是整份 null，两者含义完全不同，不能合并成一个）；
 * - `whenMissing` 是**变量名**：那个变量没有值（空串也算没有）时，先调一次前置接口；
 *   空串表示不按这个条件触发；
 * - `retryOn401`：主请求回 401 时自动调一次前置接口再重发一次。
 */
function toPreflight(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  return {
    apiId: str(value.apiId).trim() || null,
    whenMissing: str(value.whenMissing).trim(),
    retryOn401: value.retryOn401 === true
  };
}

/** 项目 / 目录上的前置接口设置（同一个字段名，两边共用这一份清洗） */
function preflightOf(entity) {
  var extra = entity && entity.extra;
  if (!extra || typeof extra !== 'object') return null;
  return toPreflight(extra.preflight);
}

/** `apis.extra.noPreflight`：这个接口自己不使用前置接口 */
function apiNoPreflightOf(api) {
  return extraOf(api).noPreflight === true;
}

/** 契约第 16 节：每段脚本最长 64KB */
var SCRIPT_MAX_BYTES = 64 * 1024;

/**
 * 读取路径用的脚本清洗：形状不对的丢掉就行。
 *
 * 库里可能存着写坏的行，读的时候宽容一点 —— 一条坏脚本不该让整个接口 500。
 * 写入路径要用 `toScriptsStrict`，那里的坏输入必须明确报 400。
 */
function toScripts(list) {
    if (!Array.isArray(list)) return [];

    var scripts = [];
    list.forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var listen = str(item.listen);
        if (listen !== 'prerequest' && listen !== 'test') return;
        scripts.push({ listen: listen, exec: str(item.exec) });
    });
    return scripts;
}

/**
 * 写入路径用的脚本校验（契约第 16 节）：不合法直接抛 400。
 *
 * 这里**不能**像读路径那样「把不认识的丢掉」—— 用户刚在编辑器里写完一段脚本，
 * 保存时被静默吞掉，他会以为存上了。
 */
function toScriptsStrict(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw respond.apiError(400, 'scripts 必须是数组');

    return value.map(function (item) {
        if (!item || typeof item !== 'object') {
            throw respond.apiError(400, '每段脚本必须是 { listen, exec } 对象');
        }

        var listen = str(item.listen);
        if (listen !== 'prerequest' && listen !== 'test') {
            throw respond.apiError(400, 'listen 只能是 prerequest 或 test，收到：' + (item.listen === undefined ? '空' : item.listen));
        }

        var exec = str(item.exec);
        if (Buffer.byteLength(exec, 'utf8') > SCRIPT_MAX_BYTES) {
            throw respond.apiError(400, '脚本最长 64KB，超出 ' +
                (Buffer.byteLength(exec, 'utf8') - SCRIPT_MAX_BYTES) + ' 字节');
        }

        return { listen: listen, exec: exec };
    });
}

/**
 * 变量行过一遍「保密变量」：把**当前用户自己的**值填回保密行。
 *
 * 共享数据里保密行的值是空串（值在 secret_values，见 lib/secrets.js），不填回去的话
 * 页面看到的就是空的 —— 自己填的值自己都看不到。别人调用时读不到（表里没有他的行），
 * 填出来仍是空串，正好就是「同事看到变量名、值是空的」。
 */
function withSecrets(handle, user, scope, scopeId, rows) {
  if (!handle || !user) return toVarRows(rows);
  return toVarRows(secrets.merge(handle, user.id, scope, scopeId, rows));
}

/**
 * 项目 / 目录的公共请求头（第五轮第 1 节）。
 *
 * 存在 `extra.headers` 里，行的形状和接口自己的请求头一样 —— 前端要能把两边直接拼起来，
 * 发送时也是同一套合并规则（见 `lib/common-headers.js`）。
 *
 * **这里不 require common-headers**：那个模块要用 dto 的 `toRows`，两头互相 require 会成环
 * （`module.exports = {}` 被后赋的新对象顶掉，拿到的是空壳）。读这一份读的是同一列，规则一致。
 */
function headersOf(entity) {
  var extra = entity && entity.extra;
  if (!extra || typeof extra !== 'object') return [];
  return toRows(extra.headers);
}

/** 目录 DTO：projectId 与 extra 是内部字段，前端用不上 */
function toFolderDto(folder, ctx, user) {
  if (!folder) return null;
  return {
    id: folder.id,
    parentId: folder.parentId,
    name: folder.name,
    description: folder.description,
    position: folder.position,
    auth: folder.auth || null,
    variables: withSecrets(ctx && ctx.handle, user, 'folder', folder.id, folder.variables),
        // 这个目录下的所有接口发送时都会带上的请求头（可被更内层 / 接口自己覆盖）
        headers: headersOf(folder),
        scripts: toScripts(folder.scripts),
        // 前置接口（第十轮第 3 节）：`extra.preflight`，没配过是 null（目录上是「跟随上层」）
        preflight: preflightOf(folder)
  };
}

/** 示例 DTO。`extra` 是 Postman 往返用的，界面不展示，导出时直接查库拿 */
function toExampleDto(example) {
    if (!example) return null;
    return {
        id: example.id,
        apiId: example.apiId,
        name: example.name,
        position: example.position,
        status: example.status,
        headers: toRows(example.headers),
        body: example.body,
        responseType: example.responseType,
        isTemplate: example.isTemplate,
        source: example.source,
        createdAt: example.createdAt
    };
}

/** 期望 DTO。`conditions` 的形状由 lib/api/expectations.js 负责清洗 */
function toExpectationDto(expectation) {
    if (!expectation) return null;
    return {
        id: expectation.id,
        apiId: expectation.apiId,
        name: expectation.name,
        position: expectation.position,
        enabled: expectation.enabled,
        exampleId: expectation.exampleId,
        conditions: expectation.conditions
    };
}

/**
 * 项目成员 DTO（契约第 10 节）。
 * `projectId` 是 repo 那边的内部字段 —— 调用方本来就知道问的是哪个项目。
 */
function toMemberDto(member) {
    if (!member) return null;
    return {
        userId: member.userId,
        username: member.username,
        displayName: member.displayName,
        role: member.role,
        disabled: member.disabled
    };
}

/** 树上的接口条目：只够画侧边栏，不带请求体和示例 */
function toApiSummary(api) {
  if (!api) return null;
  return {
    id: api.id,
    folderId: api.folderId,
    name: api.name,
    method: api.method,
    url: api.url,
    position: api.position,
    mockEnabled: api.mockEnabled,
    mockPath: api.mockPath,
    // 目录树要画状态小色点、要按「我负责的」筛，所以这里就得带上
    status: apiStatusOf(api),
    ownerId: apiOwnerOf(api)
  };
}

/**
 * 完整接口：请求定义 + mock 配置 + 全部示例 + 全部期望。
 * `expectations` 由调用方按 position 排好传进来（repo 的 listByApi 已经排过）。
 */
function toApiDto(api, examples, expectations) {
    if (!api) return null;
    return {
        id: api.id,
        projectId: api.projectId,
        folderId: api.folderId,
        name: api.name,
        description: api.description,
        method: api.method,
        url: api.url,
        params: toParams(api.params),
        body: toBody(api.body),
        auth: api.auth || null,
        scripts: toScripts(api.scripts),
        mock: {
            enabled: api.mockEnabled,
            path: api.mockPath,
            delay: api.mockDelay,
            cors: api.mockCors,
            exampleId: api.mockExampleId
        },
        // 状态与负责人（第四轮第 1 节）、响应字段说明（第六轮第 2 节），都存在 extra 里
        status: apiStatusOf(api),
        ownerId: apiOwnerOf(api),
        responseFields: apiResponseFieldsOf(api),
        // 可视化断言与提取变量（第六轮第 1 节），同样住在 extra 里
        assertions: apiAssertionsOf(api),
        extracts: apiExtractsOf(api),
        // 数据库操作（第九轮第 3 节）：连接表在项目上，这里只有「用哪个连接、跑什么」
        dbOps: apiDbOpsOf(api),
        // Socket.IO（第九轮第 4 节）：连接参数与「常用发送」，没配过是 null
        sio: apiSioOf(api),
        // gRPC（第十一轮第 1 节）：proto 文件、服务方法、metadata、消息示例，没配过是 null
        grpc: apiGrpcOf(api),
        // MQTT（第十三轮）：broker 凭据、遗嘱、订阅列表、常用发布，没配过是 null
        mqtt: apiMqttOf(api),
        // 前置接口（第十轮第 3 节）：这个接口自己不使用前置接口
        noPreflight: apiNoPreflightOf(api),
        examples: (examples || []).map(toExampleDto),
        expectations: (expectations || []).map(toExpectationDto),
        createdAt: api.createdAt,
        updatedAt: api.updatedAt
    };
}

/**
 * 项目 DTO。`extra` 是给导入导出用的，界面上不展示，不往外发；`scripts` 现在可编辑，要发出去。
 * `isRoot` 表示在这个进程里挂在根路径（而不是 /mock/<slug>）。
 * `myRole` 是**调用者**在这个项目里的角色（契约第 10 节），前端据此决定哪些按钮能点。
 */
function toProjectDto(project, ctx, user) {
    if (!project) return null;
    return {
        id: project.id,
        slug: project.slug,
        name: project.name,
        description: project.description,
        sourceDir: project.sourceDir,
        isDefault: project.isDefault,
        isRoot: !!ctx && ctx.rootProjectId === project.id,
        myRole: ctx ? access.roleOf(ctx.handle, user, project.id) : null,
        variables: withSecrets(ctx && ctx.handle, user, 'project', project.id, project.variables),
        auth: project.auth || null,
        // 整个项目的接口发送时都会带上的请求头（可被目录 / 接口自己覆盖）
        headers: headersOf(project),
        scripts: toScripts(project.scripts),
        // 内置 Mock 环境改过的变量表（值里的 $MOCK_BASE 由页面换成 mock 地址）；没改过是 null
        mockVariables: project.extra && Array.isArray(project.extra.mockVariables)
            ? toVarRows(project.extra.mockVariables)
            : null,
        // Mock 故障模拟（第七轮第 1 节）：住在 extra 里，会同步
        mockFaults: projectMockFaultsOf(project),
        // 数据库连接（第九轮第 3 节）：也在 extra 里，同样会同步给项目里所有人
        databases: projectDatabasesOf(project),
        // 前置接口（第十轮第 3 节）：`extra.preflight`，没配过是 null
        preflight: preflightOf(project),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
    };
}

function toEnvironmentDto(environment, ctx, user) {
  if (!environment) return null;
  return {
    id: environment.id,
    projectId: environment.projectId,
    name: environment.name,
    position: environment.position,
    variables: withSecrets(ctx && ctx.handle, user, 'environment', environment.id, environment.variables)
  };
}

/**
 * 按 id 或 slug 找项目。
 *
 * 契约里路径参数叫 `:pid`，没说是不是 slug；两种都收，因为 /meta 的 rootProject
 * 同时给了 id 和 slug，前端抓着哪个都能用。
 */
function findProject(handle, pid) {
    var key = str(pid);
    if (!key) return null;
    return projectsRepo.getById(handle, key) || projectsRepo.getBySlug(handle, key);
}

module.exports = {
    str: str,
    toVarRows: toVarRows,
    API_STATUSES: API_STATUSES,
    apiStatusOf: apiStatusOf,
    apiOwnerOf: apiOwnerOf,
    toRows: toRows,
    toFormRows: toFormRows,
    toBody: toBody,
    toParams: toParams,
    toScripts: toScripts,
    toScriptsStrict: toScriptsStrict,
    toResponseFields: toResponseFields,
    apiResponseFieldsOf: apiResponseFieldsOf,
    toMockFaults: toMockFaults,
    projectMockFaultsOf: projectMockFaultsOf,
    toAssertions: assertionsModule.toAssertions,
    toExtracts: assertionsModule.toExtracts,
    apiAssertionsOf: apiAssertionsOf,
    apiExtractsOf: apiExtractsOf,
    toDatabases: dbOpsModule.toDatabases,
    toDbOps: dbOpsModule.toDbOps,
    projectDatabasesOf: projectDatabasesOf,
    apiDbOpsOf: apiDbOpsOf,
    // Socket.IO（第九轮第 4 节）
    SIO_TRANSPORTS: SIO_TRANSPORTS,
    toApiSio: toApiSio,
    apiSioOf: apiSioOf,
    // gRPC（第十一轮第 1 节；`source` / `reflection` 是第十二轮第 1 节加的）
    GRPC_SOURCES: GRPC_SOURCES,
    toApiGrpc: toApiGrpc,
    toGrpcReflection: toGrpcReflection,
    apiGrpcOf: apiGrpcOf,
    // MQTT（第十三轮）
    MQTT_DEFAULT_KEEPALIVE: MQTT_DEFAULT_KEEPALIVE,
    toApiMqtt: toApiMqtt,
    apiMqttOf: apiMqttOf,
    // 前置接口（第十轮第 3 节）
    toPreflight: toPreflight,
    preflightOf: preflightOf,
    apiNoPreflightOf: apiNoPreflightOf,
    SCRIPT_MAX_BYTES: SCRIPT_MAX_BYTES,
    toAuth: toAuth,
    toExtra: toExtra,
    plainObject: plainObject,
    toProjectDto: toProjectDto,
    toEnvironmentDto: toEnvironmentDto,
    toFolderDto: toFolderDto,
    toExampleDto: toExampleDto,
    toExpectationDto: toExpectationDto,
    toMemberDto: toMemberDto,
    toApiSummary: toApiSummary,
    toApiDto: toApiDto,
    findProject: findProject
};
