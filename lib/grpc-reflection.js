/**
 * gRPC 服务端反射（第十二轮第 1 节）。
 *
 * 用户不想（或者拿不到）.proto 文件时，可以让 apiloop 直接问服务端：「你有哪些服务？
 * 它们的描述长什么样？」—— 这就是 gRPC 的 Server Reflection。
 *
 * 三件事在这里：
 * 1. **两版 reflection.proto 的常量**（`grpc.reflection.v1` 和 `v1alpha`）。
 *    gRPC 生态里两版并存，服务端只装了一版是常事，所以要**先试 v1、UNIMPLEMENTED 再试 v1alpha**；
 *    写成常量而不是外部文件，是因为这两份 proto 是我们自己用的，不该出现在用户的 proto 列表里。
 * 2. **拉描述**：`list_services` → 每个服务 `file_containing_symbol` → 缺的依赖继续
 *    `file_by_filename`，直到闭包完整（`google/protobuf/timestamp.proto` 这种就是这么收上来的）。
 * 3. 把收齐的 `FileDescriptorProto` 组装成一个 **`FileDescriptorSet`**（base64 交给前端存进
 *    `extra.grpc.reflection.descriptorSet`），后续 `/grpc/call` 不再需要 proto 文件。
 *
 * `ServerReflectionInfo` 是**双向流**：一个连接上可以先后问好几个问题，所以这里是一条
 * bidi 调用、按「还有几个问题在飞」来决定什么时候收工，不是一问一答开好几条连接。
 *
 * 驱动（`@grpc/grpc-js` / `@grpc/proto-loader`）都在函数里 require，和 `lib/grpc.js` 一样。
 */

/** 反射的协议版本：先试 v1，服务端说 UNIMPLEMENTED 再试 v1alpha */
var VERSIONS = ['v1', 'v1alpha'];

/** 反射服务自身的包前缀：它们不该出现在给用户看的服务清单里 */
var REFLECTION_PREFIX = 'grpc.reflection.';

/** 整体超时（毫秒）：反射是「用户点了按钮在等」的场景，不该比一次调用等得更久 */
var REFLECT_TIMEOUT_MS = 10000;

/** `ServerReflectionInfo` 的方法名（两版一样；`keepCase: true` 下不会被改成小驼峰） */
var METHOD_NAME = 'ServerReflectionInfo';

/** 加载出来的服务构造函数按版本缓存：每次反射都重新 parse 一遍没必要 */
var cachedCtor = {};

function protoText(pkg) {
    return 'syntax = "proto3";\n\npackage ' + pkg + ';\n\n' +
        'service ServerReflection {\n' +
        '  rpc ServerReflectionInfo(stream ServerReflectionRequest)\n' +
        '      returns (stream ServerReflectionResponse);\n' +
        '}\n\n' +
        'message ServerReflectionRequest {\n' +
        '  string host = 1;\n' +
        '  oneof message_request {\n' +
        '    string file_by_filename = 3;\n' +
        '    string file_containing_symbol = 4;\n' +
        '    ExtensionRequest file_containing_extension = 5;\n' +
        '    string all_extension_numbers_of_type = 6;\n' +
        '    string list_services = 7;\n' +
        '  }\n' +
        '}\n\n' +
        'message ExtensionRequest {\n' +
        '  string containing_type = 1;\n' +
        '  int32 extension_number = 2;\n' +
        '}\n\n' +
        'message ServerReflectionResponse {\n' +
        '  string valid_host = 1;\n' +
        '  ServerReflectionRequest original_request = 2;\n' +
        '  oneof message_response {\n' +
        '    FileDescriptorResponse file_descriptor_response = 4;\n' +
        '    ExtensionNumberResponse all_extension_numbers_response = 5;\n' +
        '    ListServiceResponse list_services_response = 6;\n' +
        '    ErrorResponse error_response = 7;\n' +
        '  }\n' +
        '}\n\n' +
        'message FileDescriptorResponse {\n' +
        '  repeated bytes file_descriptor_proto = 1;\n' +
        '}\n\n' +
        'message ExtensionNumberResponse {\n' +
        '  string base_type_name = 1;\n' +
        '  repeated int32 extension_number = 2;\n' +
        '}\n\n' +
        'message ListServiceResponse {\n' +
        '  repeated ServiceResponse service = 1;\n' +
        '}\n\n' +
        'message ServiceResponse {\n' +
        '  string name = 1;\n' +
        '}\n\n' +
        'message ErrorResponse {\n' +
        '  int32 error_code = 1;\n' +
        '  string error_message = 2;\n' +
        '}\n';
}

/**
 * 拿（并缓存）某一版反射服务的构造函数。
 *
 * 走 `protobufjs.parse` + `protoLoader.fromJSON`，**不落任何临时文件** ——
 * 这两份 proto 是程序自己的，没必要走「写文件再读」那条路。
 */
function reflectionCtor(version) {
    if (cachedCtor[version]) return cachedCtor[version];

    var pkg = 'grpc.reflection.' + version;
    var protobuf = require('protobufjs');
    var protoLoader = require('@grpc/proto-loader');
    var grpc = require('@grpc/grpc-js');

    var root = new protobuf.Root();
    protobuf.parse(protoText(pkg), root, { keepCase: true });
    root.resolveAll();

    var definition = protoLoader.fromJSON(root.toJSON(), {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true
    });

    var loaded = grpc.loadPackageDefinition(definition);
    var service = loaded.grpc.reflection[version].ServerReflection;

    cachedCtor[version] = { Ctor: service, clientPath: pkg + '.ServerReflection' };
    return cachedCtor[version];
}

/** 一个「反射调用失败」的错误：带 gRPC 状态码，调用方据此判断是不是 UNIMPLEMENTED */
function reflectError(code, message) {
    var err = new Error(message);
    err.grpcCode = code;
    return err;
}

/**
 * 在一版反射服务上把描述收齐。
 *
 * @param {object} input `{ target, credentials, metadata, deadlineMs, version }`
 * @returns {Promise<{fileBytes: Buffer[], services: string[]}>}
 */
function collectOnce(input) {
    var grpc = require('@grpc/grpc-js');
    var reflection = reflectionCtor(input.version);

    return new Promise(function (resolve, reject) {
        var client = new reflection.Ctor(input.target, input.credentials);
        var call = null;
        var settled = false;

        /** 收齐的描述：名字 → FileDescriptorProto（已经是普通对象，不是 bytes） */
        var files = {};
        /** 问过和正在问的文件名，别重复问 */
        var asked = {};
        /** 还有几个问题在飞 */
        var inflight = 0;
        var started = false;
        var services = [];

        function done(errOrValue) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { if (call) call.cancel(); } catch (err) { /* 已经结束了 */ }
            try { client.close(); } catch (err) { /* 已经关了 */ }
            if (errOrValue instanceof Error) reject(errOrValue);
            else resolve(errOrValue);
        }

        var timer = setTimeout(function () {
            done(reflectError(4, '反射超时：' + REFLECT_TIMEOUT_MS + ' 毫秒内没问完'));
        }, Math.min(REFLECT_TIMEOUT_MS, Number(input.deadlineMs) || REFLECT_TIMEOUT_MS));

        function ask(request) {
            inflight += 1;
            try {
                call.write(request);
            } catch (err) {
                done(reflectError(13, (err && err.message) || '反射请求发不出去'));
            }
        }

        /** 还缺哪些依赖文件（别的文件 import 了它、但我们还没拿到） */
        function missingDependencies() {
            var out = [];
            Object.keys(files).forEach(function (name) {
                (files[name].dependency || []).forEach(function (dep) {
                    if (files[dep] || asked[dep]) return;
                    asked[dep] = true;
                    out.push(dep);
                });
            });
            return out;
        }

        /** 手上的问题都答完了：要么收工，要么接着问缺的依赖 */
        function drain() {
            if (inflight > 0 || !started) return;

            var missing = missingDependencies();
            if (missing.length) {
                missing.forEach(function (name) { ask({ file_by_filename: name }); });
                return;
            }

            done({
                fileBytes: Object.keys(files).map(function (name) { return files[name].__bytes; }),
                services: services
            });
        }

        try {
            call = client[METHOD_NAME](input.metadata, { deadline: new Date(Date.now() + REFLECT_TIMEOUT_MS) });
        } catch (err) {
            done(reflectError(13, (err && err.message) || '反射连接建不起来'));
            return;
        }

        call.on('data', function (response) {
            inflight -= 1;

            if (response.error_response) {
                var failure = response.error_response;
                done(reflectError(Number(failure.error_code) || 2, failure.error_message || '反射请求被拒绝'));
                return;
            }

            if (response.list_services_response) {
                services = (response.list_services_response.service || [])
                    .map(function (item) { return String((item && item.name) || ''); })
                    .filter(function (name) {
                        return name && name.indexOf(REFLECTION_PREFIX) !== 0;
                    });

                started = true;
                if (!services.length) {
                    // 一个服务都没有：这也算成功（服务端可能只是没注册服务）
                    done({ fileBytes: [], services: [] });
                    return;
                }

                services.forEach(function (name) {
                    ask({ file_containing_symbol: name });
                });
                return;
            }

            if (response.file_descriptor_response) {
                var descriptor = require('protobufjs/ext/descriptor');
                (response.file_descriptor_response.file_descriptor_proto || []).forEach(function (raw) {
                    var bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
                    var decoded;
                    try {
                        decoded = descriptor.FileDescriptorProto.toObject(
                            descriptor.FileDescriptorProto.decode(bytes), { defaults: true });
                    } catch (err) {
                        done(reflectError(13, '反射返回的描述读不出来'));
                        return;
                    }
                    if (!decoded.name || files[decoded.name]) return;
                    // 原始字节留着：最后要原样装进 FileDescriptorSet
                    decoded.__bytes = bytes;
                    files[decoded.name] = decoded;
                });
                drain();
            }
        });

        call.on('error', function (err) {
            done(reflectError(Number(err && err.code) || 13, (err && err.details) || (err && err.message) || '反射调用出错'));
        });

        call.on('status', function (status) {
            if (status && status.code !== 0) {
                done(reflectError(status.code, status.details || '反射调用出错'));
            }
        });

        ask({ list_services: '' });
    });
}

/**
 * 问服务端要描述。两版都试，全 UNIMPLEMENTED 就抛「没开反射」。
 *
 * @param {object} input
 * @param {string} input.target `host:port`
 * @param {boolean} input.tls
 * @param {object|null} input.metadata 已经 build 好的 `grpc.Metadata`（或 null）
 * @param {number} [input.deadlineMs]
 * @returns {Promise<{descriptorSet: string, services: string[], version: string, fileCount: number}>}
 */
async function reflect(input) {
    var grpc = require('@grpc/grpc-js');
    var descriptor = require('protobufjs/ext/descriptor');

    var credentials = input.tls === true ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    var metadata = input.metadata || new grpc.Metadata();
    var last = null;

    for (var i = 0; i < VERSIONS.length; i += 1) {
        var version = VERSIONS[i];
        try {
            var got = await collectOnce({
                target: input.target,
                credentials: credentials,
                metadata: metadata,
                deadlineMs: input.deadlineMs,
                version: version
            });

            var set = descriptor.FileDescriptorSet.create({
                file: got.fileBytes.map(function (bytes) {
                    return descriptor.FileDescriptorProto.decode(bytes);
                })
            });
            var encoded = descriptor.FileDescriptorSet.encode(set).finish();

            return {
                descriptorSet: Buffer.from(encoded).toString('base64'),
                services: got.services,
                version: version,
                fileCount: got.fileBytes.length
            };
        } catch (err) {
            last = err;
            // 只有「服务端没实现这一版」才值得换下一版；连不上、超时、被拒绝都直接抛
            if (!(err && err.grpcCode === 12)) throw err;
        }
    }

    var missing = new Error('服务端没开反射，请导入 proto 文件');
    missing.grpcCode = last ? last.grpcCode : 12;
    missing.noReflection = true;
    throw missing;
}

module.exports = {
    VERSIONS: VERSIONS,
    REFLECT_TIMEOUT_MS: REFLECT_TIMEOUT_MS,
    REFLECTION_PREFIX: REFLECTION_PREFIX,
    METHOD_NAME: METHOD_NAME,
    // 导出 proto 文本：自测里那个「最小的反射服务端」要拿它来注册服务，
    // 两边用同一份文本才不会出现「客户端以为对、服务端以为不对」的假失败
    protoText: protoText,
    reflect: reflect
};
