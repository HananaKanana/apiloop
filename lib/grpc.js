/**
 * gRPC 调试（第十一轮第 1 节）。
 *
 * 两件事，各自独立：
 * 1. **解析 proto**（`parse`）：把「文件名 + 内容」的一组 .proto 解析成服务清单，
 *    每个方法再按请求类型生成一份可以直接粘进消息框的 JSON 示例；
 * 2. **发起调用**（`call`）：一元调用和服务端流，事件（start / metadata / message / end / error）
 *    通过回调交给调用方，调用方负责写 NDJSON。
 *
 * 三个刻意的选择：
 *
 * - **proto 内容写进临时目录再读**。`@grpc/proto-loader` 只认文件路径，而用户手里只有
 *   字符串（界面上粘贴的）。写完读完立刻删掉，`mkdtemp` 保证多个调用之间不打架。
 * - **解析走 protobufjs、调用走 proto-loader**。protobufjs 的报错里带
 *   `(文件名, line N)`，正好是契约要求的「带文件名和行号的中文」；
 *   而 `google/protobuf/*.proto`（timestamp、empty、struct、wrappers…）protobufjs
 *   自带一份，不用用户提供。调用那一步再交给 proto-loader，省得自己做 PackageDefinition。
 * - **两个驱动都在函数里 `require`**。它们是可选依赖，进程启动时不需要，装不上也不该
 *   拖累别的功能（和 `lib/db-ops.js` 里的 mysql2 / pg / ioredis 一个道理）。
 *
 * 这一版**只做一元调用和服务端流**：客户端流、双向流在 `call` 一开始就返回一行 error
 * （见 `clientStreaming` 的判断）。
 */

var fs = require('fs');
var os = require('os');
var path = require('path');

/** 消息框空着时按空对象发（proto3 里全是默认值的请求是合法的） */
var EMPTY_MESSAGE = {};

/** 默认超时（毫秒）：和界面上的输入框默认值一致 */
var DEFAULT_DEADLINE_MS = 10000;

/** 超时的上下界：太小会让「点了取消」和「超时」分不清，太大等于没有超时 */
var MIN_DEADLINE_MS = 1;
var MAX_DEADLINE_MS = 10 * 60 * 1000;

/**
 * 存进 `extra.grpc.reflection.descriptorSet` 的大小上限（2 MB）。
 *
 * 描述里是**所有消息的完整定义**，大项目的服务很容易几百 KB；而这个字段是跟着接口
 * 一起同步给项目里所有人的，超过上限就不存（反射本身照常能用，只是不落库）。
 */
var MAX_DESCRIPTOR_SET_BYTES = 2 * 1024 * 1024;

/**
 * 状态码 → 中文提示（附在 details 后面）。
 *
 * 只给「用户看了这句话知道该去改什么」的那些；其余的原文照给 ——
 * 编一句「未知错误」还不如把服务端说的原样给出去。
 */
var STATUS_HINTS = {
    UNAVAILABLE: '连不上服务，检查地址、端口、TLS 开关',
    DEADLINE_EXCEEDED: '超时了，检查服务端有没有响应，或者把超时时间调大',
    UNIMPLEMENTED: '服务端没有这个方法，检查服务名、方法名和 proto 版本',
    UNAUTHENTICATED: '没通过身份验证，检查 metadata 里的凭据',
    PERMISSION_DENIED: '没有权限，检查 metadata 里的账号或角色',
    INVALID_ARGUMENT: '请求参数不合法，检查消息内容',
    NOT_FOUND: '服务端找不到请求的东西',
    ALREADY_EXISTS: '要创建的东西已经存在',
    RESOURCE_EXHAUSTED: '服务端资源不够（限流、配额），稍后再试',
    FAILED_PRECONDITION: '服务端当前状态不允许这个操作',
    ABORTED: '服务端的操作被中止了，可以重试',
    OUT_OF_RANGE: '参数超出范围',
    INTERNAL: '服务端内部错误',
    DATA_LOSS: '数据丢失或损坏',
    UNKNOWN: '服务端返回了未知错误',
    CANCELLED: '调用被取消了'
};

/* ------------------------------------------------------------------ 报错 */

/**
 * 参数/解析类的错误：`api/grpc.js` 见到它就按 400 返回。
 *
 * 单独一个类是因为「400 还是 500」不能靠错误文案猜 —— 用户少填一个字段
 * 和服务端真的崩了，对用户的行动指引完全不一样。
 */
function GrpcInputError(message) {
    Error.call(this, message);
    this.name = 'GrpcInputError';
    this.message = message;
    this.status = 400;
}

GrpcInputError.prototype = Object.create(Error.prototype);
GrpcInputError.prototype.constructor = GrpcInputError;

function inputError(message) {
    return new GrpcInputError(message);
}

/* ------------------------------------------------------------------ proto 文件 */

/**
 * 文件名清洗：只留相对路径。
 *
 * proto 里的 `import` 用的是相对名字（`common.proto`、`types/user.proto`），
 * 所以这里把绝对路径和前导斜杠都去掉。`..` 也去掉 —— 不能让用户借文件名
 * 把文件写到临时目录外面去。
 */
function safeName(value) {
    var cleaned = String(value === undefined || value === null ? '' : value).replace(/\\/g, '/').trim();
    var parts = cleaned.split('/').filter(function (part) {
        return part !== '' && part !== '.' && part !== '..';
    });
    return parts.join('/');
}

/** 清洗一组「文件名 + 内容」，顺手挡掉重名和空名字 */
function normalizeFiles(value) {
    if (!Array.isArray(value)) return [];

    var list = [];
    var seen = {};

    value.forEach(function (item) {
        if (!item || typeof item !== 'object') return;

        var name = safeName(item.name);
        if (!name) throw inputError('proto 文件名不能为空');
        if (seen[name]) return;   // 同名只认第一份：界面上重名是误操作
        seen[name] = true;

        list.push({ name: name, content: String(item.content === undefined || item.content === null ? '' : item.content) });
    });

    return list;
}

/**
 * 把 proto 内容写进临时目录，交给回调，结束后无论成败都删掉。
 *
 * 回调是同步的（`loadSync` 就够用，几十 KB 的 proto 不值得为它引入异步），
 * 所以直接 `finally` 清目录。
 */
function withTempDir(files, run) {
    if (!files.length) throw inputError('请先导入 proto 文件');

    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apiloop-grpc-'));

    try {
        var names = [];
        files.forEach(function (file) {
            var full = path.join(dir, file.name);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, file.content);
            names.push(file.name);
        });

        return run(dir, names);
    } finally {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
            // 临时目录没删掉不影响这次调用，只是系统临时目录里多一份垃圾
        }
    }
}

/**
 * proto-loader 的读取选项（契约定死的四个）。
 *
 * `keepCase` 让字段名保持 proto 里的写法（`user_id` 不会被改成 `userId`），
 * `longs: String` 让 int64 按字符串收发（JS 的 number 装不下），
 * `enums: String` 让枚举按名字收发，`defaults: true` 让默认值也出现在响应里
 * —— 界面上「这个字段没返回」和「返回了默认值」是两件事，用户要看得出来。
 */
function loaderOptions(dir) {
    var options = {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true
    };
    if (dir) options.includeDirs = [dir];
    return options;
}

/* ------------------------------------------------------------------ 反射拿到的描述 */

/** base64 → bytes。解不开就是「反射数据损坏」——这个 base64 只可能来自我们自己的 /grpc/reflect */
function decodeDescriptorSet(value) {
    var text = String(value === undefined || value === null ? '' : value).trim();
    if (!text) throw inputError('反射数据是空的，请重新获取');

    var bytes;
    try {
        bytes = Buffer.from(text, 'base64');
    } catch (err) {
        throw inputError('反射数据损坏，请重新获取');
    }

    // Buffer.from 对垃圾输入不抛错（它只是忽略非法字符），所以还要看长度：
    // 空的 base64、或者只有几个字节的，一定不是一份 FileDescriptorSet
    if (bytes.length < 8) throw inputError('反射数据损坏，请重新获取');
    return bytes;
}

/**
 * 一份「描述」的两种用法。
 *
 * - **服务清单 / 示例**：protobufjs 的 `Root.fromDescriptor`，和按 proto 文件解析
 *   出来的 Root 是同一个形状，所以 `collectServices` / `messageExample` 一个字都不用改；
 * - **发起调用**：proto-loader 的 `loadFileDescriptorSetFromBuffer`，直接吃 bytes。
 *
 * 每次用都重新解码一遍（不缓存）：描述可能几十 KB，缓存在内存里图省事，
 * 但接口改了描述之后就会用到旧的 —— 这类「改了没用」的问题最难查。
 */
function protoRootOf(source) {
    var protobuf = require('protobufjs');
    var descriptor = require('protobufjs/ext/descriptor');

    var bytes = decodeDescriptorSet(source.descriptorSet);
    var decoded;
    try {
        decoded = descriptor.FileDescriptorSet.decode(bytes);
    } catch (err) {
        throw inputError('反射数据损坏，请重新获取');
    }

    var root;
    try {
        root = protobuf.Root.fromDescriptor(decoded);
        root.resolveAll();
    } catch (err) {
        throw inputError('反射数据损坏，请重新获取');
    }
    return root;
}

/** 一次「这次用哪份 proto」的判断：描述优先，没有描述才用文件 */
function sourceKind(input) {
    var source = input || {};
    if (String(source.descriptorSet || '').trim()) return 'descriptorSet';
    if (normalizeFiles(source.protoFiles).length) return 'proto';
    throw inputError('请先导入 proto 文件，或者用反射拉一份描述');
}

/** 解析出服务清单（proto 文件 / 反射描述两条路都走这里） */
function servicesOf(input) {
    if (sourceKind(input) === 'descriptorSet') {
        var protobuf = require('protobufjs');
        return collectServices(protobuf, protoRootOf(input));
    }
    return parseProtoFiles(input.protoFiles);
}

/* ------------------------------------------------------------------ 解析 */

/** `.demo.User` → `demo.User` */
function withoutDot(name) {
    var text = String(name === undefined || name === null ? '' : name);
    return text.charAt(0) === '.' ? text.slice(1) : text;
}

/**
 * 把解析器抛出来的报错换成看得懂的中文。
 *
 * 三种要翻译的：
 * - 语法错：protobufjs 给的是 `非法记号 (路径/bad.proto, line 5)`，取出文件名和行号；
 * - 缺文件：`ENOENT ... /tmp/xxx/nope.proto`，说清楚缺的是哪个（路径是我们造的临时目录，
 *   给用户看没用）；
 * - 类型没定义：protobufjs 的原文还算清楚，加一句前缀就够。
 */
function protoErrorMessage(err) {
    var message = String((err && err.message) || err || 'proto 解析失败');

    if (err && err.code === 'ENOENT') {
        var missing = message.match(/([^/\\'"]+\.proto)['"]?\s*$/);
        return missing
            ? '缺少 proto 文件：' + missing[1] + '（被 import 了，但没有一起提供）'
            : 'proto 里 import 了没有提供的文件';
    }

    // `illegal id ';' (/tmp/apiloop-grpc-xxx/bad.proto, line 5)`
    var located = message.match(/^(.*?)\s*\(([^()]+),\s*line\s+(\d+)\)\s*$/);
    if (located) {
        return path.basename(located[2]) + ' 第 ' + located[3] + ' 行：' + located[1];
    }

    if (/^no such Type or Enum/.test(message)) {
        return 'proto 里用到了没定义的类型：' + message;
    }

    return message;
}

/* ------------------------------------------------------------------ 示例生成 */

/** 基本类型 → 示例值。64 位整数按字符串给（`longs: String`，发出去也是字符串） */
function scalarExample(type) {
    if (type === 'string' || type === 'bytes') return '';
    if (type === 'bool') return false;
    if (type === 'double' || type === 'float') return 0;
    if (type === 'int64' || type === 'uint64' || type === 'sint64' ||
        type === 'fixed64' || type === 'sfixed64') {
        return '0';
    }
    return 0;
}

/**
 * 一个字段的示例值。
 *
 * 返回 `undefined` 表示「这个字段先不写进去」（循环引用到此为止）。
 * 判定循环用的是**当前这条路径**上的类型名，不是全局见过一次就不再展开 ——
 * `A 里有两个 B` 这种要照样展开两次，只有 A → B → A 才停。
 */
function fieldExample(protobuf, field, seen) {
    var type = field.resolvedType;

    if (type && type instanceof protobuf.Enum) {
        var first = Object.keys(type.values || {})[0];
        // 枚举一个值都没有是不可能的（proto 要求 0 号位），兜一个空串更安全
        return first === undefined ? '' : first;
    }

    if (type && type instanceof protobuf.Type) {
        if (seen.indexOf(type.fullName) !== -1) return undefined;
        return messageExample(protobuf, type, seen);
    }

    return scalarExample(field.type);
}

/** map 字段的键：整数键给 '0'，其余给空串（JSON 里 map 的键一律是字符串） */
function mapKeyExample(field) {
    var keyType = String(field.keyType || 'string');
    return /int|fixed|sfixed/.test(keyType) ? '0' : '';
}

/**
 * 一个消息类型的示例对象。
 *
 * repeated 放一项、map 放一个键、枚举取第一个值，其余按基本类型的默认值。
 */
function messageExample(protobuf, type, seen) {
    var out = {};
    var nextSeen = seen.concat([type.fullName]);

    (type.fieldsArray || []).forEach(function (field) {
        var value;

        if (field.map) {
            value = fieldExample(protobuf, field, nextSeen);
            if (value === undefined) return;
            var entry = {};
            entry[mapKeyExample(field)] = value;
            out[field.name] = entry;
            return;
        }

        value = fieldExample(protobuf, field, nextSeen);
        if (value === undefined) return;

        out[field.name] = field.repeated ? [value] : value;
    });

    return out;
}

/* ------------------------------------------------------------------ 服务清单 */

/** 一个 rpc 方法的对外形状（`api/grpc.js` 直接回给前端） */
function methodInfo(protobuf, method) {
    var requestType = method.resolvedRequestType;
    var owner = method.parent && method.parent.fullName
        ? withoutDot(method.parent.fullName)
        : '';

    return {
        name: method.name,
        path: '/' + owner + '/' + method.name,
        requestType: requestType ? withoutDot(requestType.fullName) : '',
        responseType: method.resolvedResponseType ? withoutDot(method.resolvedResponseType.fullName) : '',
        clientStreaming: method.requestStream === true,
        serverStreaming: method.responseStream === true,
        // 请求类型展开成的 JSON 示例：界面上的「生成示例」按钮直接填它
        example: JSON.stringify(messageExample(protobuf, requestType, []), null, 2)
    };
}

/** 递归找出所有 service（它们可以嵌在多层 package 里） */
function collectServices(protobuf, namespace) {
    var out = [];

    (namespace.nestedArray || []).forEach(function (item) {
        if (item instanceof protobuf.Service) {
            out.push({
                name: withoutDot(item.fullName),
                methods: (item.methodsArray || []).map(function (method) {
                    return methodInfo(protobuf, method);
                })
            });
            return;
        }

        if (item.nestedArray && item.nestedArray.length) {
            out = out.concat(collectServices(protobuf, item));
        }
    });

    return out;
}

/**
 * 按 proto 文件文本解析出一棵 protobufjs 的 Root（写完临时文件读完就删）。
 *
 * @param {Array<{name: string, content: string}>} protoFiles
 * @returns {object} protobufjs 的 Root
 * @throws {GrpcInputError}
 */
function protoRootOfFiles(protoFiles) {
    var files = normalizeFiles(protoFiles);
    var protobuf = require('protobufjs');

    return withTempDir(files, function (dir, names) {
        var root = new protobuf.Root();

        // `google/protobuf/*.proto` 交给 protobufjs 自带的定义，其余按用户给的名字找
        root.resolvePath = function (origin, target) {
            if (/^google\/protobuf\//.test(target)) return target;
            return path.join(dir, target);
        };

        try {
            root.loadSync(names, { keepCase: true });
            root.resolveAll();
        } catch (err) {
            throw inputError(protoErrorMessage(err));
        }

        return root;
    });
}

/** 服务清单：proto 文件那条路 */
function parseProtoFiles(protoFiles) {
    var protobuf = require('protobufjs');
    return collectServices(protobuf, protoRootOfFiles(protoFiles));
}

/**
 * 按 proto 文件或反射描述解析，返回服务清单。
 *
 * @param {{protoFiles?: Array, descriptorSet?: string}|Array} input
 *   传数组是「只有 proto 文件」的老写法（内部用），新的调用方一律传对象
 * @returns {{services: Array<object>}}
 * @throws {GrpcInputError}
 */
function parse(input) {
    var source = Array.isArray(input) ? { protoFiles: input } : (input || {});
    return { services: servicesOf(source) };
}

/* ------------------------------------------------------------------ 调用 */

/** 地址：`demo.UserService` 在 `loadPackageDefinition` 出来的对象里逐层往下找 */
function lookupService(loaded, name) {
    var parts = withoutDot(name).split('.');
    var current = loaded;

    for (var i = 0; i < parts.length; i += 1) {
        if (!current || !parts[i]) return null;
        current = current[parts[i]];
    }

    // 认「是个服务」的方式：proto-loader 造出来的构造函数上带一个 `service` 描述表
    return current && current.service ? current : null;
}

/**
 * 按 proto 文件**或**反射描述，拿到某个服务的构造函数和某个方法的描述。
 *
 * 单独导出是因为它不止一处要用：`/grpc/call`（一元 / 服务端流）和
 * 会话式的那几种流（客户端流 / 双向流，第十二轮第 2 节）都要「先拿到 Ctor 和 method
 * 才能建客户端」。**这里只负责拿，不判断流式支不支持** —— 那是各个调用方自己的事。
 *
 * @param {object} input `{ protoFiles?, descriptorSet?, service, method }`
 * @returns {{Ctor: Function, method: object, kind: 'proto'|'descriptorSet'}}
 * @throws {GrpcInputError}
 */
function loadMethod(input) {
    var source = input || {};
    var grpc = require('@grpc/grpc-js');
    var protoLoader = require('@grpc/proto-loader');
    var kind = sourceKind(source);
    var Ctor = null;

    if (kind === 'descriptorSet') {
        var definition;
        try {
            definition = protoLoader.loadFileDescriptorSetFromBuffer(
                decodeDescriptorSet(source.descriptorSet), loaderOptions(null));
        } catch (err) {
            if (err && err.status) throw err;
            throw inputError('反射数据损坏，请重新获取');
        }

        Ctor = lookupService(grpc.loadPackageDefinition(definition), source.service);
        if (!Ctor) throw inputError('反射拿到的描述里没有服务「' + source.service + '」');
    } else {
        Ctor = withTempDir(normalizeFiles(source.protoFiles), function (dir, names) {
            var loaded;
            try {
                loaded = protoLoader.loadSync(names, loaderOptions(dir));
            } catch (err) {
                throw inputError(protoErrorMessage(err));
            }

            var found = lookupService(grpc.loadPackageDefinition(loaded), source.service);
            if (!found) throw inputError('proto 里没有服务「' + source.service + '」');
            return found;
        });
    }

    var method = Ctor.service[source.method];
    if (!method) throw inputError('服务「' + source.service + '」里没有方法「' + source.method + '」');

    return { Ctor: Ctor, method: method, kind: kind };
}

/** 地址里 `grpcs://` 等于开 TLS，`grpc://` 等于不开；两种前缀都去掉，留 host:port */
function splitTarget(value) {
    var text = String(value === undefined || value === null ? '' : value).trim();
    var tls = null;

    if (/^grpcs:\/\//i.test(text)) {
        tls = true;
        text = text.replace(/^grpcs:\/\//i, '');
    } else if (/^grpc:\/\//i.test(text)) {
        tls = false;
        text = text.replace(/^grpc:\/\//i, '');
    }

    text = text.replace(/\/+$/, '');
    if (!text) throw inputError('请填写 gRPC 服务地址（host:port）');

    return { target: text, tls: tls };
}

/** metadata 的键值行 → grpc.Metadata（`/grpc/reflect` 也要拼一份，所以单独导出） */
function buildMetadata(rows) {
    var grpc = require('@grpc/grpc-js');
    var metadata = new grpc.Metadata();

    (rows || []).forEach(function (row) {
        if (!row || row.enabled === false) return;

        var key = String(row.key === undefined || row.key === null ? '' : row.key).trim();
        if (!key) return;

        // 二进制 metadata（键以 -bin 结尾）这里不支持：界面给的是文本
        metadata.set(key, String(row.value === undefined || row.value === null ? '' : row.value));
    });

    return metadata;
}

/** Metadata → 普通对象，键是按 grpc-js 自己的写法收的（值一律数组） */
function metadataToObject(metadata) {
    if (!metadata || typeof metadata.toJSON !== 'function') return {};
    try {
        return metadata.toJSON();
    } catch (err) {
        return {};
    }
}

/** 状态码 → `{ code, name, details }`，details 后面接一句中文提示 */
function statusOf(grpc, status) {
    var code = status && Number.isFinite(Number(status.code)) ? Number(status.code) : 0;
    var name = grpc.status[code] || String(code);
    var details = status && status.details ? String(status.details) : '';
    var hint = STATUS_HINTS[name];

    return {
        code: code,
        name: name,
        details: hint ? (details ? details + '（' + hint + '）' : hint) : details
    };
}

/**
 * 建客户端 / 发消息时抛出来的英文错误换成中文。
 *
 * 目前只有一条：**metadata 的值不能有非 ASCII 字符**（HTTP/2 的规矩，中文进了 header
 * 就得先编码）。grpc-js 的原文是 `Metadata string value "…" contains illegal characters`，
 * 用户看不出「那我该怎么办」，所以这里补一句。二进制 metadata 的键要以 `-bin` 结尾。
 */
function callErrorMessage(err) {
    var message = (err && err.message) ? String(err.message) : '调用失败';
    if (/contains illegal characters/i.test(message)) {
        return 'metadata 的值里有中文或其它非 ASCII 字符 —— gRPC 的 metadata 只能是 ASCII，' +
            '请改成英文；确实要传二进制的话，键名以 -bin 结尾、值用 base64';
    }
    return message;
}

/** 消息文本 → 要发出去的对象。空着按空对象，不是对象直接报错（省得发给服务端再被拒） */
function parseMessage(text) {
    var raw = String(text === undefined || text === null ? '' : text).trim();
    if (!raw) return EMPTY_MESSAGE;

    var value;
    try {
        value = JSON.parse(raw);
    } catch (err) {
        throw inputError('消息不是合法的 JSON：' + (err && err.message ? err.message : '解析失败'));
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw inputError('消息必须是一个 JSON 对象，比如 {"id": 1}');
    }

    return value;
}

/* ------------------------------------------------------------------ 断言与提取 */

/**
 * 断言和提取里可以写正则，而正则是在**服务端**跑的：一个写坏的正则（`(a+)+$` 这种
 * 回溯爆炸的）能把进程卡住几分钟。和 `/send` 用同一个上限（见 lib/regex-guard.js）。
 */
var ASSERTION_TIMEOUT_MS = 2000;

/** 文本的 UTF-8 字节数（断言里的 `size` 用得上） */
function byteLength(text) {
    var value = String(text === undefined || text === null ? '' : text);
    return Buffer.byteLength(value, 'utf8');
}

/** metadata / trailers 转成「[名字, 值] 的数组」——和 HTTP 响应头的形状一样 */
function headerPairs(object, into) {
    var seen = {};
    (into || []).forEach(function (pair) { seen[String(pair[0]).toLowerCase()] = true; });

    Object.keys(object || {}).forEach(function (name) {
        var lower = name.toLowerCase();
        // 同名取第一个值：metadata 先来，trailers 里同名的就不再覆盖
        if (seen[lower]) return;
        seen[lower] = true;

        var values = object[name];
        var first = Array.isArray(values) ? values[0] : values;
        into.push([name, first === undefined || first === null ? '' : String(first)]);
    });
    return into;
}

/** 断言结果 → `end` 行里那个形状（`message` 是给人看的一句原因） */
function withMessage(entry) {
    return {
        name: entry.name,
        passed: entry.passed === true,
        message: entry.passed === true ? '' : (entry.error || '没通过'),
        error: entry.error || '',
        source: entry.source || '断言'
    };
}

/**
 * 把一次 gRPC 调用当成「一次响应」，跑可视化的断言和提取变量（第十二轮第 1 节）。
 *
 * 对照关系（界面上「断言」页签里那几个取值来源）：
 *   - **状态码** → gRPC 状态码的数字（OK 是 0），于是 `status eq 0` 就是「调用成功」；
 *   - **响应头** → metadata 和 trailers 合起来（同名取第一个值）；
 *   - **响应体** → 一元调用是那条消息的 JSON；服务端流是全部消息组成的数组；
 *   - **响应时间** → 这次调用的 `durationMs`。
 *
 * **不写库**：只算出结果，落库交给 `lib/api/grpc.js`（那里才有 handle、用户和角色）。
 * 这样 `lib/grpc.js` 保持「不碰数据库」，和它一直以来的分工一致。
 *
 * @returns {{tests: Array, extracted: Array, warnings: Array, console: Array}}
 */
function evaluate(input) {
    var assertions = require('./assertions');
    var regexGuard = require('./regex-guard');

    var empty = { tests: [], extracted: [], warnings: [], console: [] };

    var rows = assertions.toAssertions(input.assertions);
    var extracts = assertions.toExtracts(input.extracts);
    if (!rows.length && !extracts.length) return empty;

    var body = input.body;
    var ctx = assertions.createContext({
        response: {
            status: input.code,
            headers: input.headers || [],
            body: body,
            size: byteLength(body),
            bodyEncoding: 'utf8'
        },
        timings: { total: input.durationMs }
    });

    var computed = regexGuard.runWithTimeout(function () {
        return {
            tests: assertions.runAssertions(rows, ctx, input.vars || {}),
            outcome: assertions.runExtracts(extracts, ctx, { hasEnvironment: input.hasEnvironment === true })
        };
    }, ASSERTION_TIMEOUT_MS);

    if (computed.timedOut) {
        return {
            tests: [withMessage({
                name: '断言和提取变量',
                passed: false,
                error: '执行超时：里面的正则太复杂了，换个写法再试'
            })],
            extracted: [],
            warnings: [],
            console: []
        };
    }

    var outcome = computed.value.outcome;
    var extracted = [];
    ['environment', 'project'].forEach(function (scope) {
        Object.keys(outcome[scope]).forEach(function (key) {
            extracted.push({ key: key, value: outcome[scope][key], scope: scope });
        });
    });

    return {
        tests: computed.value.tests.map(withMessage),
        extracted: extracted,
        warnings: outcome.warnings,
        console: outcome.console
    };
}

/**
 * 发起一次调用。
 *
 * @param {object} input
 * @param {Array} [input.protoFiles] 已清洗过的 proto 文件
 * @param {string} [input.descriptorSet] 反射拿到的描述（base64）；有它就不用 protoFiles
 * @param {string} input.target `host:port`
 * @param {boolean} input.tls
 * @param {string} input.service 服务全名
 * @param {string} input.method 方法名
 * @param {Array} input.metadata 键值行
 * @param {string} input.messageText 消息原文（JSON 文本，变量已经替换过）
 * @param {number} input.deadlineMs
 * @param {string|null} [input.note] 附在 start 事件里的说明（代理提示）
 * @param {string[]} [input.missing] 没有值的变量名
 * @param {Array} [input.assertions] 断言行（`lib/assertions.js` 认的那种）
 * @param {Array} [input.extracts] 提取行
 * @param {Object<string,string>} [input.vars] 断言期望值里 `{{变量}}` 用的表
 * @param {boolean} [input.hasEnvironment] 选了真实环境吗（决定「存到环境」的提取是否生效）
 * @param {{onEvent: Function, onDone: Function}} handlers
 * @returns {{cancel: Function}} 取消用（浏览器断开时调）
 */
function startCall(input, handlers) {
    var grpc = require('@grpc/grpc-js');

    var state = { call: null, client: null, cancelled: false, finished: false };
    var onEvent = handlers.onEvent;

    /** 收到的响应消息（断言的服务端流要拿它拼成数组当响应体） */
    var messages = [];
    /** 握手回来的 metadata（和 trailers 合起来当「响应头」） */
    var handshakeMetadata = {};

    function emit(event) {
        onEvent(event);
    }

    function cleanup() {
        if (state.client) {
            try { state.client.close(); } catch (err) { /* 已经关了 */ }
            state.client = null;
        }
    }

    /** 收到状态就收尾：跑断言和提取、写 end、关连接、通知调用方可以结束了 */
    function finish(status) {
        if (state.finished) return;
        state.finished = true;

        var statusInfo = statusOf(grpc, status);
        var trailers = metadataToObject(status && status.metadata);
        var durationMs = Date.now() - startedAt;

        /**
         * 断言里的「响应体」：一元调用是那一条消息，服务端流是全部消息组成的数组。
         * 用 `null` 而不是空串：`null` 能被 `JSON.parse` 出来（`json` 那个取值来源仍然可用），
         * 空串会被判成「不是 JSON」。
         */
        var body = streamed
            ? JSON.stringify(messages)
            : JSON.stringify(messages.length ? messages[messages.length - 1] : null);

        var outcome = evaluate({
            assertions: input.assertions,
            extracts: input.extracts,
            vars: input.vars,
            hasEnvironment: input.hasEnvironment,
            code: statusInfo.code,
            headers: headerPairs(trailers, headerPairs(handshakeMetadata, [])),
            body: body,
            durationMs: durationMs
        });

        emit({
            type: 'end',
            status: statusInfo,
            trailers: trailers,
            durationMs: durationMs,
            tests: outcome.tests,
            extracted: outcome.extracted,
            // 提取失败的原因（没选环境、没这个字段……）：界面照 HTTP 那样提示一句
            warnings: outcome.warnings
        });

        cleanup();
        handlers.onDone();
    }

    var startedAt = Date.now();

    /* -------- start 先发：目标地址、TLS、没值的变量，用户第一时间就能看到 -------- */
    emit({
        type: 'start',
        target: input.target,
        tls: input.tls === true,
        missing: input.missing || [],
        note: input.note || null
    });

    /* -------- 准备（取描述、找方法、校验消息）：失败都是一行 error -------- */
    var ready;
    var message;
    var streamed = false;
    try {
        message = parseMessage(input.messageText);
        ready = loadMethod(input);

        // 客户端流 / 双向流要开「会话」（先建连接、再一条条发），是第十二轮第 2 节的事
        if (ready.method.requestStream) {
            throw inputError('这一版只支持一元调用和服务端流（客户端流、双向流还没做）');
        }
        streamed = ready.method.responseStream === true;
    } catch (err) {
        emit({ type: 'error', error: (err && err.message) || '调用准备失败' });
        handlers.onDone();
        return { cancel: function () {} };
    }

    /* -------- 真正发出去 -------- */
    var credentials = input.tls === true ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    var metadata;
    var deadline = new Date(startedAt + Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, Number(input.deadlineMs) || DEFAULT_DEADLINE_MS)));

    /** 收到一条响应：发一行 message，同时留着给断言用 */
    function receive(data) {
        messages.push(data);
        emit({ type: 'message', data: data, at: Date.now() });
    }

    try {
        metadata = buildMetadata(input.metadata);

        state.client = new ready.Ctor(input.target, credentials);
        var options = { deadline: deadline };

        if (ready.method.responseStream) {
            /* 服务端流：每收到一条 data 发一行 message */
            state.call = state.client[input.method](message, metadata, options);

            state.call.on('metadata', function (md) {
                handshakeMetadata = metadataToObject(md);
                emit({ type: 'metadata', metadata: handshakeMetadata });
            });
            state.call.on('data', receive);
            // 出错时 error 和 status 都会来；不挂这个监听器会抛出去
            state.call.on('error', function () {});
            state.call.on('status', function (status) { finish(status); });
        } else {
            /* 一元调用：响应只在回调里给，失败同样走 status */
            state.call = state.client[input.method](message, metadata, options, function (err, response) {
                if (!err) receive(response);
            });

            state.call.on('metadata', function (md) {
                handshakeMetadata = metadataToObject(md);
                emit({ type: 'metadata', metadata: handshakeMetadata });
            });
            state.call.on('status', function (status) { finish(status); });
        }
    } catch (err) {
        emit({ type: 'error', error: callErrorMessage(err) });
        cleanup();
        handlers.onDone();
        return { cancel: function () {} };
    }

    return {
        cancel: function () {
            state.cancelled = true;
            if (state.call) {
                try { state.call.cancel(); } catch (err) { /* 已经结束了 */ }
            }
            cleanup();
        }
    };
}

module.exports = {
    DEFAULT_DEADLINE_MS: DEFAULT_DEADLINE_MS,
    MIN_DEADLINE_MS: MIN_DEADLINE_MS,
    MAX_DEADLINE_MS: MAX_DEADLINE_MS,
    MAX_DESCRIPTOR_SET_BYTES: MAX_DESCRIPTOR_SET_BYTES,
    ASSERTION_TIMEOUT_MS: ASSERTION_TIMEOUT_MS,
    STATUS_HINTS: STATUS_HINTS,
    GrpcInputError: GrpcInputError,
    normalizeFiles: normalizeFiles,
    splitTarget: splitTarget,
    buildMetadata: buildMetadata,
    parse: parse,
    servicesOf: servicesOf,
    loadMethod: loadMethod,
    startCall: startCall,
    evaluate: evaluate,
    statusOf: statusOf,
    parseMessage: parseMessage,
    protoErrorMessage: protoErrorMessage,
    decodeDescriptorSet: decodeDescriptorSet,
    headerPairs: headerPairs
};
