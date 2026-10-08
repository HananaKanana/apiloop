/**
 * 导出接口文档（第九轮第 2 节）。
 *
 * 三件事分开：
 * 1. **取数据**：`buildDoc` 直接把分享文档页那份数据（`lib/api/shares.js` 的 `publicDoc`）
 *    拿来用 —— 内容和打码规则**必须**和分享页一模一样，两边各写一份迟早一个遮了一个没遮；
 * 2. **中间结构**：章节 → 接口 → 各块，三种格式共用这一份，不在渲染函数里读库；
 * 3. **渲染**：`renderMarkdown` / `renderHtml` / `renderDocx` 各一个纯函数。
 *
 * 打码不用管：`publicDoc` 出来的东西已经过 `maskJsonText` / `maskUrlQuery` /
 * `isSensitiveHeaderName` 了（密码、token、cookie 一律 `******`）。
 */

var shares = require('./api/shares');
var dto = require('./api/dto');
var apisRepo = require('./db/repos/apis');
var urlUtils = require('./url-utils');
var foldersRepo = require('./db/repos/folders');
var i18n = require('./i18n');

/**
 * 文档里的**固定文字**按导出那次请求的语言取（i18n.locale()）。
 *
 * 下面大量出现「整份文档三种格式各写一遍」的情况（Markdown / HTML / Word），
 * 所以统一走这一个 T()，要改措辞只改一处。
 */
function T(text, params) {
    return i18n.m(text, params);
}
var i18n = require('./i18n');

/**
 * 文档里的**固定文字**按导出那次请求的语言取（i18n.locale()）。
 *
 * 下面大量出现「整份文档三种格式各写一遍」的情况（Markdown / HTML / Word），
 * 所以统一走这一个 T()，要改措辞只改一处。
 */
function T(text, params) {
    return i18n.m(text, params);
}
var i18n = require('./i18n');

/**
 * 文档里的**固定文字**按导出那次请求的语言取（i18n.locale()）。
 *
 * 下面大量出现「整份文档三种格式各写一遍」的情况（Markdown / HTML / Word），
 * 所以统一走这一个 T()，要改措辞只改一处。
 */
function T(text, params) {
    return i18n.m(text, params);
}

var STATUS_LABELS = {
    designing: '设计中',
    developing: '开发中',
    done: '已完成',
    deprecated: '已废弃'
};

/** MQTT 的协议版本：库里存的是 3 / 4 / 5，文档里写成人看的名字（第十三轮） */
var PROTOCOL_LABELS = {
    3: '3.1',
    4: '3.1.1',
    5: '5'
};

/** 发送格式的中文名（TCP / UDP，第十五轮） */
var ENCODING_LABELS = { text: '文本', hex: '十六进制', base64: 'Base64' };

/** 文本发送时补的行尾 */
var LINE_ENDING_LABELS = { none: '不加', lf: 'LF', crlf: 'CRLF' };

/**
 * 分帧方式写成人看的一句话（TCP / UDP 第十五轮）。
 *
 * UDP 一个数据报就是一条消息，分帧在它上面不生效 —— 文档里要写清楚，不然照着配会白折腾。
 * 分隔符用 `JSON.stringify` 出来（`"\n"` 这样），比直接把一个真换行塞进文档里看得清。
 */
function framingLabel(framing, method) {
    var config = framing || {};
    if (String(method).toUpperCase() === 'UDP') return T('不适用（UDP 一个数据报就是一条消息）');

    if (config.type === 'delimiter') {
        return T('按分隔符切（{delimiter}）', { delimiter: JSON.stringify(config.delimiter) });
    }
    if (config.type === 'length') {
        return T('长度前缀（{n} 字节，{endian}，长度不含前缀本身）', {
            n: config.lengthBytes,
            endian: config.endian === 'le' ? T('小端') : T('大端')
        });
    }
    return T('不分帧（收到一块算一条）');
}

function str(value) {
    return value === undefined || value === null ? '' : String(value);
}

/** `2026-10-04`（文件名用）/ `2026-10-04 09:12`（文档里用） */
function stamp(ts, withTime) {
    var date = new Date(ts);
    var pad = function (n) { return String(n).padStart(2, '0'); };

    var text = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    if (!withTime) return text;
    return text + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/** 目录的完整路径（父 / 子），章节标题用它 —— 嵌套目录在文档里排成一列比缩进好读 */
function folderPaths(handle, projectId) {
    var folders = foldersRepo.list(handle, projectId);
    var byId = {};
    folders.forEach(function (folder) { byId[folder.id] = folder; });

    var paths = {};
    folders.forEach(function (folder) {
        var names = [];
        var current = folder;
        var guard = 0;

        while (current && guard < 32) {
            guard += 1;
            names.unshift(current.name || T('未命名目录'));
            current = current.parentId ? byId[current.parentId] : null;
        }
        paths[folder.id] = names.join(' / ');
    });

    return paths;
}

/**
 * 组装要写进文档的那份数据。
 *
 * @param {object} handle
 * @param {object} ctx
 * @param {{project: object, folderId?: string|null, options?: object}} input
 * @returns {object} 中间结构（三种渲染函数都吃它）
 */
function buildDoc(handle, ctx, input) {
    var options = input.options || {};
    var project = input.project;

    // 借分享页那份数据：内容和打码规则完全一致（`share` 只用得到 projectId / folderId）
    var raw = shares.publicDoc(handle, ctx, {
        projectId: project.id,
        folderId: input.folderId || null,
        title: '',
        createdAt: Date.now(),
        expiresAt: null
    });
    if (!raw) return null;

    var mockPaths = {};
    // gRPC（第十一轮第 1 节）：服务、方法、请求消息示例都要写进文档。
    // 分享文档那份数据（shares.publicDoc）不带这些字段（它是给外人看的最小集合），
    // 所以这里从库里按 apiId 补一份 —— 和 mockPaths 同一次遍历，只多读一次 apisRepo.list。
    // **只留要写进文档的四样**：protoFiles 的内容可能几十 KB 一份，不需要跟着走。
    var grpcConfigs = {};
    // MQTT（第十三轮）：broker 地址就是接口自己的 url（文档里那行 `MQTT mqtt://…` 已经写了），
    // 这里补的是「用哪个协议版本连、订了哪些主题、存了哪些常用发布」—— 光有地址调不起来。
    var mqttConfigs = {};
    // TCP / UDP（第十五轮）：地址同样是接口自己的 url，这里补「怎么分帧、默认发什么格式、
    // 存了哪些常用发送」—— 裸套接字光有主机端口，不知道怎么切包就调不通。
    var socketConfigs = {};
    // RabbitMQ（第十六轮 T40）：地址就是接口自己的 url（文档里那行 `AMQP amqp://…`），
    // 这里补「消费哪些队列 / 交换机、存了哪些常用发布」—— 光有地址不知道去哪个队列收。
    var amqpConfigs = {};
    // RabbitMQ（第十六轮 T40）：地址就是接口自己的 url（文档里那行 `AMQP amqp://…`），
    // 这里补「消费哪些队列 / 交换机、存了哪些常用发布」—— 光有地址不知道去哪个队列收。
    var amqpConfigs = {};
    // RabbitMQ（第十六轮 T40）：地址就是接口自己的 url（文档里那行 `AMQP amqp://…`），
    // 这里补「消费哪些队列 / 交换机、存了哪些常用发布」—— 光有地址不知道去哪个队列收。
    var amqpConfigs = {};

    apisRepo.list(handle, project.id).forEach(function (api) {
        // 没存 mockPath 的（老数据、直接写库造出来的）按地址推一个 —— 界面上新建 / 改地址时
        // 也是这么推的（见 lib/api/tree.js），不然文档里这一行会莫名其妙地空着
        mockPaths[api.id] = dto.str(api.mockPath) || urlUtils.deriveMockPath(api.url);

        var method = String(api.method || '').toUpperCase();

        if (method === 'GRPC') {
            var config = dto.apiGrpcOf(api);
            if (config) {
                grpcConfigs[api.id] = {
                    service: config.service,
                    method: config.method,
                    tls: config.tls,
                    message: config.message
                };
            }
        }

        if (method === 'MQTT') {
            var mqtt = dto.apiMqttOf(api);
            if (mqtt) {
                mqttConfigs[api.id] = {
                    protocolVersion: mqtt.protocolVersion,
                    protocolLabel: PROTOCOL_LABELS[mqtt.protocolVersion] || String(mqtt.protocolVersion),
                    clientId: mqtt.clientId,
                    subscriptions: mqtt.subscriptions,
                    saved: mqtt.saved
                };
            }
        }

        if (method === 'AMQP') {
            var amqp = dto.apiAmqpOf(api);
            if (amqp) {
                amqpConfigs[api.id] = {
                    consumers: amqp.consumers,
                    saved: amqp.saved
                };
            }
        }

        if (method === 'AMQP') {
            var amqp = dto.apiAmqpOf(api);
            if (amqp) {
                amqpConfigs[api.id] = {
                    consumers: amqp.consumers,
                    saved: amqp.saved
                };
            }
        }

        if (method === 'AMQP') {
            var amqp = dto.apiAmqpOf(api);
            if (amqp) {
                amqpConfigs[api.id] = {
                    consumers: amqp.consumers,
                    saved: amqp.saved
                };
            }
        }

        if (method === 'TCP' || method === 'UDP') {
            var socketConfig = dto.apiSocketOf(api);
            if (socketConfig) {
                socketConfigs[api.id] = {
                    method: method,
                    framing: framingLabel(socketConfig.framing, method),
                    sendEncoding: socketConfig.sendEncoding,
                    lineEnding: socketConfig.lineEnding,
                    udp: socketConfig.udp,
                    saved: socketConfig.saved
                };
            }
        }
    });

    var paths = folderPaths(handle, project.id);
    var apis = raw.apis.filter(function (api) {
        // 「只导出已完成的接口」：状态不是 done 的都去掉（没设状态的也算没完成）
        if (options.doneOnly) return api.status === 'done';
        return true;
    });

    /* 按目录分章节：目录顺序按树（父在前），没分组的放最后 */
    var chapters = [];
    var byFolder = {};

    raw.folders.forEach(function (folder) {
        var chapter = {
            id: folder.id,
            name: paths[folder.id] || folder.name,
            description: dto.str(folder.description),
            apis: []
        };
        byFolder[folder.id] = chapter;
        chapters.push(chapter);
    });

    var loose = { id: null, name: T('（未分组）'), description: '', apis: [] };

    apis.forEach(function (api) {
        var item = Object.assign({}, api, {
            // 状态名是文档里的固定文字：库里的 status 值本身不动，只翻显示名
            statusLabel: STATUS_LABELS[api.status]
                ? T(STATUS_LABELS[api.status])
                : (api.status ? api.status : T('未设置')),
            mockUrl: '',
            // gRPC 接口多一份「服务 / 方法 / 请求消息」（其他方法上是 null）
            grpc: grpcConfigs[api.id] || null,
            // MQTT 接口多一份「协议版本 / 订阅列表 / 常用发布」（其他方法上是 null）
            mqtt: mqttConfigs[api.id] || null,
            // TCP / UDP 接口多一份「分帧 / 默认发送格式 / UDP 设置 / 常用发送」（其他方法上是 null）
            socket: socketConfigs[api.id] || null,
            // RabbitMQ 接口多一份「消费者 / 常用发布」（其他方法上是 null）
            amqp: amqpConfigs[api.id] || null,
            // RabbitMQ 接口多一份「消费者 / 常用发布」（其他方法上是 null）
            amqp: amqpConfigs[api.id] || null,
            // RabbitMQ 接口多一份「消费者 / 常用发布」（其他方法上是 null）
            amqp: amqpConfigs[api.id] || null
        });

        if (options.mock && input.mockBase && mockPaths[api.id]) {
            item.mockUrl = String(input.mockBase).replace(/\/+$/, '') + mockPaths[api.id];
        }
        if (!options.examples) item.examples = [];

        var chapter = api.folderId ? byFolder[api.folderId] : null;
        if (chapter) chapter.apis.push(item);
        else loose.apis.push(item);
    });

    if (loose.apis.length) chapters.push(loose);

    var used = chapters.filter(function (chapter) { return chapter.apis.length; });

    return {
        project: { name: raw.project.name, description: dto.str(project.description) },
        scope: {
            folderId: input.folderId || null,
            name: input.folderId ? (paths[input.folderId] || '') : ''
        },
        exportedAt: Date.now(),
        exportedAtText: stamp(Date.now(), true),
        includeExamples: options.examples !== false,
        includeMock: options.mock === true,
        mockBase: dto.str(input.mockBase),
        stats: {
            apis: used.reduce(function (sum, chapter) { return sum + chapter.apis.length; }, 0),
            folders: used.length
        },
        chapters: used
    };
}

/** 文件名里不能有的字符去掉，再拼上日期 */
function fileName(projectName, format, ts) {
    var cleaned = str(projectName).replace(/[/\\:*?"<>|\u0000-\u001f]/g, '').trim() || T('项目');
    return cleaned + T('-接口文档-') + stamp(ts || Date.now()).replace(/-/g, '') +
        (format === 'docx' ? '.docx' : (format === 'html' ? '.html' : '.md'));
}

/**
 * 一个消费者的说明（三种渲染共用）：
 * queue 模式写队列名，exchange 模式写「交换机 + 路由键」，并说明是临时队列旁听。
 */
function amqpConsumerText(row) {
    var ack = row.ack === 'manual' ? T('手动确认') : T('自动确认');
    if (row.mode === 'exchange') {
        return T('exchange「{exchange}」路由键「{routingKey}」（临时队列旁听，{ack}）',
            { exchange: row.exchange, routingKey: row.routingKey, ack: ack });
    }
    return T('queue「{queue}」（{ack}）', { queue: row.queue, ack: ack });
}

/**
 * 一个消费者的说明（三种渲染共用）：
 * queue 模式写队列名，exchange 模式写「交换机 + 路由键」，并说明是临时队列旁听。
 */
function amqpConsumerText(row) {
    var ack = row.ack === 'manual' ? T('手动确认') : T('自动确认');
    if (row.mode === 'exchange') {
        return T('exchange「{exchange}」路由键「{routingKey}」（临时队列旁听，{ack}）',
            { exchange: row.exchange, routingKey: row.routingKey, ack: ack });
    }
    return T('queue「{queue}」（{ack}）', { queue: row.queue, ack: ack });
}

/**
 * 一个消费者的说明（三种渲染共用）：
 * queue 模式写队列名，exchange 模式写「交换机 + 路由键」，并说明是临时队列旁听。
 */
function amqpConsumerText(row) {
    var ack = row.ack === 'manual' ? T('手动确认') : T('自动确认');
    if (row.mode === 'exchange') {
        return T('exchange「{exchange}」路由键「{routingKey}」（临时队列旁听，{ack}）',
            { exchange: row.exchange, routingKey: row.routingKey, ack: ack });
    }
    return T('queue「{queue}」（{ack}）', { queue: row.queue, ack: ack });
}

/* ================================================================== Markdown */

function mdCell(value) {
    // 表格里 `|` 会把列切断，换行会把行切断
    return str(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdTable(headers, rows) {
    if (!rows.length) return '';

    var lines = [
        '| ' + headers.join(' | ') + ' |',
        '| ' + headers.map(function () { return '---'; }).join(' | ') + ' |'
    ];
    rows.forEach(function (row) {
        lines.push('| ' + row.map(mdCell).join(' | ') + ' |');
    });
    return lines.join('\n') + '\n';
}

function anchorOf(text) {
    return 'api-' + str(text).toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
}

function renderMarkdown(doc) {
    var out = [];

    out.push('# ' + doc.project.name + ' ' + T('接口文档'));
    out.push('');
    if (doc.project.description) {
        out.push(doc.project.description);
        out.push('');
    }
    out.push(T('- 导出时间：{time}', { time: doc.exportedAtText }));
    out.push(T('- 接口数量：{apis} 个（{folders} 个目录）',
        { apis: doc.stats.apis, folders: doc.stats.folders }));
    if (doc.scope.folderId) {
        out.push(T('- 范围：目录「{name}」', { name: doc.scope.name }));
    }
    out.push('');
    out.push('> ' + T('密码、token 这类值已自动遮住；环境变量的值、脚本不会出现在文档里。'));
    out.push('');

    out.push('## ' + T('目录（文档）'));
    out.push('');
    doc.chapters.forEach(function (chapter) {
        out.push('- ' + chapter.name);
        chapter.apis.forEach(function (api) {
            out.push('  - [' + api.name + '](' + '#' + anchorOf(chapter.name + ' ' + api.name) + ')');
        });
    });
    out.push('');

    doc.chapters.forEach(function (chapter) {
        out.push('## ' + chapter.name);
        out.push('');
        if (chapter.description) {
            out.push(chapter.description);
            out.push('');
        }

        chapter.apis.forEach(function (api) {
            out.push('### ' + api.name);
            out.push('');
            out.push('```http');
            out.push(api.method + ' ' + api.url);
            out.push('```');
            out.push('');
            out.push(T('- 状态：{status}', { status: api.statusLabel }) +
                (api.ownerName ? T('　负责人：{name}', { name: api.ownerName }) : ''));
            if (api.authType && api.authType !== 'none') {
                out.push(T('- 鉴权：{type}', { type: api.authType }));
            }
            if (api.mockUrl) out.push(T('- Mock 地址：{url}', { url: api.mockUrl }));

            // gRPC（第十一轮第 1 节）：地址就是上面那行 `GRPC host:port`，
            // 这里补上「调用哪个服务的哪个方法」和请求消息示例 ——
            // 没有这两样，这份文档对着一份 proto 也没法照着调。
            if (api.grpc) {
                if (api.grpc.service) out.push(T('- 服务：{name}', { name: api.grpc.service }));
                if (api.grpc.method) out.push(T('- 方法：{name}', { name: api.grpc.method }));
                if (api.grpc.tls) out.push('- ' + T('TLS：开'));
            }

            // RabbitMQ（第十六轮 T40）：地址就是上面那行 \`AMQP amqp://…\`，
            // 这里补上消费哪些队列 / 交换机、存了哪些常用发布
            if (api.amqp) {
                api.amqp.consumers.forEach(function (row) {
                    out.push(T('- 消费者：{text}', { text: amqpConsumerText(row) }));
                });

                if (api.amqp.saved.length) {
                    out.push('');
                    out.push('**' + T('常用发布') + '**');
                    out.push('');
                    api.amqp.saved.forEach(function (row) {
                        out.push(T('- {name}：exchange「{exchange}」路由键「{routingKey}」', {
                            name: row.name,
                            exchange: row.exchange || T('（默认交换机）'),
                            routingKey: row.routingKey
                        }));
                        if (row.payload) {
                            out.push('');
                            out.push('\`\`\`');
                            out.push(row.payload);
                            out.push('\`\`\`');
                        }
                    });
                    out.push('');
                }
            }

            // MQTT（第十三轮）：地址就是上面那行 \`MQTT mqtt://host:1883\`,，
            // 这里补上协议版本、客户端 ID、订阅列表和常用发布
            if (api.mqtt) {
                var mqttMeta = [T('- 协议版本：{value}', { value: api.mqtt.protocolLabel })];
                if (api.mqtt.clientId) {
                    mqttMeta.push(T('客户端 ID：{value}', { value: api.mqtt.clientId }));
                }
                out.push(mqttMeta.join('　'));
            }

            // TCP / UDP（第十五轮）：地址就是上面那行 `TCP tcp://host:9000`，
            // 这里补上分帧方式、默认发送格式和常用发送 —— 裸套接字不知道分帧就切不出消息来
            if (api.socket) {
                out.push(T('- 分帧：{value}', { value: api.socket.framing }));
                out.push(T('- 默认发送格式：{encoding}　行尾：{ending}', {
                    encoding: T(ENCODING_LABELS[api.socket.sendEncoding] || api.socket.sendEncoding),
                    ending: T(LINE_ENDING_LABELS[api.socket.lineEnding] || api.socket.lineEnding)
                }));
                if (api.socket.method === 'UDP') {
                    out.push(T('- 本机端口：{port}　允许广播：{broadcast}', {
                        port: api.socket.udp.bindPort === null ? T('随机') : api.socket.udp.bindPort,
                        broadcast: api.socket.udp.broadcast ? T('是') : T('否')
                    }));
                }
            }
            out.push('');

            if (api.mqtt && api.mqtt.subscriptions.length) {
                out.push('**' + T('订阅主题') + '**');
                out.push('');
                out.push(mdTable([T('主题'), T('QoS'), T('启用')], api.mqtt.subscriptions.map(function (row) {
                    return [row.topic, String(row.qos), row.enabled === false ? T('否') : T('是')];
                })));
            }

            if (api.mqtt && api.mqtt.saved.length) {
                out.push('**' + T('常用发布') + '**');
                out.push('');
                api.mqtt.saved.forEach(function (row) {
                    out.push(T('- {name}：{topic}（QoS {qos}{retain}）', {
                        name: row.name,
                        topic: row.topic || T('(未填主题)'),
                        qos: row.qos,
                        retain: row.retain ? T('，retain') : ''
                    }));
                    if (row.payload) {
                        out.push('');
                        out.push('```');
                        out.push(row.payload);
                        out.push('```');
                    }
                });
                out.push('');
            }

            if (api.socket && api.socket.saved.length) {
                out.push('**' + T('常用发送') + '**');
                out.push('');
                api.socket.saved.forEach(function (row) {
                    out.push(T('- {name}（{encoding}）', {
                        name: row.name,
                        encoding: T(ENCODING_LABELS[row.encoding] || row.encoding)
                    }));
                    if (row.payload) {
                        out.push('');
                        out.push('```');
                        out.push(row.payload);
                        out.push('```');
                    }
                });
                out.push('');
            }

            if (api.grpc && api.grpc.message) {
                out.push('**' + T('请求消息') + '**');
                out.push('');
                out.push('```json');
                out.push(api.grpc.message);
                out.push('```');
                out.push('');
            }

            if (api.description) {
                out.push(api.description);
                out.push('');
            }

            if (api.params.path.length) {
                out.push('**' + T('路径参数') + '**');
                out.push('');
                out.push(mdTable([T('名字'), T('示例值'), T('必填'), T('说明')],
                    api.params.path.map(function (row) {
                        return [row.key, row.value, row.required ? T('是') : '', row.desc];
                    })));
            }
            if (api.params.query.length) {
                out.push('**' + T('查询参数') + '**');
                out.push('');
                out.push(mdTable([T('名字'), T('示例值'), T('必填'), T('说明')],
                    api.params.query.map(function (row) {
                        return [row.key, row.value, row.required ? T('是') : '', row.desc];
                    })));
            }
            if (api.headers.length) {
                out.push('**' + T('请求头') + '**');
                out.push('');
                out.push(mdTable([T('名字'), T('示例值'), T('必填'), T('说明')],
                    api.headers.map(function (row) {
                        return [row.key, row.value, row.required ? T('是') : '', (row.common ? T('（继承）') : '') + row.desc];
                    })));
            }

            var body = api.body || { mode: 'none' };
            if (body.mode === 'raw' && body.raw) {
                out.push('**' + T('请求体') + '**');
                out.push('');
                out.push('```' + (body.language === 'json' ? 'json' : ''));
                out.push(body.raw);
                out.push('```');
                out.push('');
            } else if (body.form && body.form.length) {
                out.push('**' + T('请求体（{kind}）', {
                    kind: body.mode === 'formdata' ? 'form-data' : T('表单')
                }) + '**');
                out.push('');
                out.push(mdTable([T('名字'), T('值'), T('说明')],
                    body.form.map(function (row) { return [row.key, row.value, row.desc]; })));
            } else if (body.mode === 'graphql' && body.graphql && body.graphql.query) {
                out.push('**' + T('请求体（GraphQL）') + '**');
                out.push('');
                out.push('```graphql');
                out.push(body.graphql.query);
                out.push('```');
                out.push('');
                if (body.graphql.variables) {
                    out.push(T('变量：'));
                    out.push('');
                    out.push('```json');
                    out.push(body.graphql.variables);
                    out.push('```');
                    out.push('');
                }
            }

            (api.examples || []).forEach(function (example) {
                out.push('**' + T('示例响应{name} · HTTP {status}', {
                    name: example.name ? T('（{name}）', { name: example.name }) : '',
                    status: example.status
                }) + '**');
                out.push('');
                out.push('```' + (example.responseType === 'json' ? 'json' : ''));
                out.push(example.body);
                out.push('```');
                out.push('');
            });

            if ((api.responseFields || []).length) {
                out.push('**' + T('响应字段说明') + '**');
                out.push('');
                out.push(mdTable([T('字段'), T('类型'), T('说明')],
                    api.responseFields.map(function (row) {
                        return [row.path, row.type, (row.required ? T('（必有）') : '') + row.desc];
                    })));
            }

            out.push('');
        });
    });

    return out.join('\n');
}

/* ================================================================== HTML */

function escapeHtml(value) {
    return str(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function htmlTable(headers, rows) {
    if (!rows.length) return '';

    var head = '<tr>' + headers.map(function (name) {
        return '<th>' + escapeHtml(name) + '</th>';
    }).join('') + '</tr>';

    var body = rows.map(function (row) {
        return '<tr>' + row.map(function (cell) {
            return '<td>' + escapeHtml(cell) + '</td>';
        }).join('') + '</tr>';
    }).join('');

    return '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
}

function renderHtml(doc) {
    var toc = doc.chapters.map(function (chapter, chapterIndex) {
        var items = chapter.apis.map(function (api, apiIndex) {
            return '<li><a href="#' + anchorOf(chapter.name + ' ' + api.name + '-' + chapterIndex + '-' + apiIndex) + '">' +
                escapeHtml(api.name) + '</a> <span class="m">' + escapeHtml(api.method) + '</span></li>';
        }).join('');
        return '<li class="chapter"><a href="#chapter-' + chapterIndex + '">' + escapeHtml(chapter.name) + '</a>' +
            '<ul>' + items + '</ul></li>';
    }).join('');

    var body = doc.chapters.map(function (chapter, chapterIndex) {
        var apis = chapter.apis.map(function (api, apiIndex) {
            var blocks = [];

            blocks.push('<h3 id="' + anchorOf(chapter.name + ' ' + api.name + '-' + chapterIndex + '-' + apiIndex) + '">' +
                escapeHtml(api.name) + '</h3>');
            blocks.push('<pre class="code">' + escapeHtml(api.method + ' ' + api.url) + '</pre>');
            blocks.push('<p class="meta">' + T('状态：{status}', { status: escapeHtml(api.statusLabel) }) +
                (api.ownerName ? T('　负责人：{name}', { name: escapeHtml(api.ownerName) }) : '') +
                (api.authType && api.authType !== 'none'
                    ? T('　鉴权：{type}', { type: escapeHtml(api.authType) }) : '') + '</p>');
            if (api.mockUrl) {
                blocks.push('<p class="meta">' + T('Mock 地址：{url}', { url: escapeHtml(api.mockUrl) }) + '</p>');
            }

            // gRPC（第十一轮第 1 节）：服务 / 方法 / TLS 和请求消息示例
            if (api.grpc) {
                var grpcMeta = [];
                if (api.grpc.service) {
                    grpcMeta.push(T('服务：{name}', { name: escapeHtml(api.grpc.service) }));
                }
                if (api.grpc.method) {
                    grpcMeta.push(T('方法：{name}', { name: escapeHtml(api.grpc.method) }));
                }
                if (api.grpc.tls) grpcMeta.push(T('TLS：开'));
                if (grpcMeta.length) blocks.push('<p class="meta">' + grpcMeta.join('　') + '</p>');

                if (api.grpc.message) {
                    blocks.push('<h4>' + T('请求消息') + '</h4><pre class="code">' +
                        escapeHtml(api.grpc.message) + '</pre>');
                }
            }

            // RabbitMQ（第十六轮 T40）：消费者 / 常用发布
            if (api.amqp) {
                blocks.push('<h4>' + T('消费者') + '</h4><ul class="saved">' +
                    api.amqp.consumers.map(function (row) {
                        return '<li>' + escapeHtml(amqpConsumerText(row)) + '</li>';
                    }).join('') + '</ul>');

                if (api.amqp.saved.length) {
                    var amqpSaved = api.amqp.saved.map(function (row) {
                        var line = '<li>' + escapeHtml(T('{name}：exchange「{exchange}」路由键「{routingKey}」', {
                            name: row.name,
                            exchange: row.exchange || T('（默认交换机）'),
                            routingKey: row.routingKey
                        }));
                        if (row.payload) line += '<pre class="code">' + escapeHtml(row.payload) + '</pre>';
                        return line + '</li>';
                    }).join('');
                    blocks.push('<h4>' + T('常用发布') + '</h4><ul class="saved">' + amqpSaved + '</ul>');
                }
            }

            // RabbitMQ（第十六轮 T40）：消费者 / 常用发布
            if (api.amqp) {
                blocks.push('<h4>' + T('消费者') + '</h4><ul class="saved">' +
                    api.amqp.consumers.map(function (row) {
                        return '<li>' + escapeHtml(amqpConsumerText(row)) + '</li>';
                    }).join('') + '</ul>');

                if (api.amqp.saved.length) {
                    var amqpSaved = api.amqp.saved.map(function (row) {
                        var line = '<li>' + escapeHtml(T('{name}：exchange「{exchange}」路由键「{routingKey}」', {
                            name: row.name,
                            exchange: row.exchange || T('（默认交换机）'),
                            routingKey: row.routingKey
                        }));
                        if (row.payload) line += '<pre class="code">' + escapeHtml(row.payload) + '</pre>';
                        return line + '</li>';
                    }).join('');
                    blocks.push('<h4>' + T('常用发布') + '</h4><ul class="saved">' + amqpSaved + '</ul>');
                }
            }

            // RabbitMQ（第十六轮 T40）：消费者 / 常用发布
            if (api.amqp) {
                blocks.push('<h4>' + T('消费者') + '</h4><ul class="saved">' +
                    api.amqp.consumers.map(function (row) {
                        return '<li>' + escapeHtml(amqpConsumerText(row)) + '</li>';
                    }).join('') + '</ul>');

                if (api.amqp.saved.length) {
                    var amqpSaved = api.amqp.saved.map(function (row) {
                        var line = '<li>' + escapeHtml(T('{name}：exchange「{exchange}」路由键「{routingKey}」', {
                            name: row.name,
                            exchange: row.exchange || T('（默认交换机）'),
                            routingKey: row.routingKey
                        }));
                        if (row.payload) line += '<pre class="code">' + escapeHtml(row.payload) + '</pre>';
                        return line + '</li>';
                    }).join('');
                    blocks.push('<h4>' + T('常用发布') + '</h4><ul class="saved">' + amqpSaved + '</ul>');
                }
            }

            // MQTT（第十三轮）：协议版本 / 客户端 ID / 订阅列表 / 常用发布
            if (api.mqtt) {
                var mqttParts = [T('协议版本：{value}', { value: escapeHtml(api.mqtt.protocolLabel) })];
                if (api.mqtt.clientId) {
                    mqttParts.push(T('客户端 ID：{value}', { value: escapeHtml(api.mqtt.clientId) }));
                }
                blocks.push('<p class="meta">' + mqttParts.join('　') + '</p>');

                if (api.mqtt.subscriptions.length) {
                    blocks.push('<h4>' + T('订阅主题') + '</h4>' + htmlTable([T('主题'), T('QoS'), T('启用')],
                        api.mqtt.subscriptions.map(function (row) {
                            return [row.topic, String(row.qos), row.enabled === false ? T('否') : T('是')];
                        })));
                }

                if (api.mqtt.saved.length) {
                    var savedHtml = api.mqtt.saved.map(function (row) {
                        var line = '<li>' + escapeHtml(T('{name}：{topic}（QoS {qos}{retain}）', {
                            name: row.name,
                            topic: row.topic || T('(未填主题)'),
                            qos: row.qos,
                            retain: row.retain ? T('，retain') : ''
                        }));
                        if (row.payload) line += '<pre class="code">' + escapeHtml(row.payload) + '</pre>';
                        return line + '</li>';
                    }).join('');
                    blocks.push('<h4>' + T('常用发布') + '</h4><ul class="saved">' + savedHtml + '</ul>');
                }
            }

            // TCP / UDP（第十五轮）：分帧 / 默认发送格式 / UDP 设置 / 常用发送
            if (api.socket) {
                var socketParts = [
                    T('分帧：{value}', { value: escapeHtml(api.socket.framing) }),
                    T('默认发送格式：{value}', {
                        value: escapeHtml(T(ENCODING_LABELS[api.socket.sendEncoding] || api.socket.sendEncoding))
                    }),
                    T('行尾：{value}', {
                        value: escapeHtml(T(LINE_ENDING_LABELS[api.socket.lineEnding] || api.socket.lineEnding))
                    })
                ];
                if (api.socket.method === 'UDP') {
                    socketParts.push(T('本机端口：{value}', {
                        value: escapeHtml(api.socket.udp.bindPort === null ? T('随机') : String(api.socket.udp.bindPort))
                    }));
                    socketParts.push(T('允许广播：{value}',
                        { value: api.socket.udp.broadcast ? T('是') : T('否') }));
                }
                blocks.push('<p class="meta">' + socketParts.join('　') + '</p>');

                if (api.socket.saved.length) {
                    var socketSaved = api.socket.saved.map(function (row) {
                        var item = '<li>' + escapeHtml(T('{name}（{encoding}）', {
                            name: row.name,
                            encoding: T(ENCODING_LABELS[row.encoding] || row.encoding)
                        }));
                        if (row.payload) item += '<pre class="code">' + escapeHtml(row.payload) + '</pre>';
                        return item + '</li>';
                    }).join('');
                    blocks.push('<h4>' + T('常用发送') + '</h4><ul class="saved">' + socketSaved + '</ul>');
                }
            }

            if (api.description) blocks.push('<p class="desc">' + escapeHtml(api.description) + '</p>');

            if (api.params.path.length) {
                blocks.push('<h4>' + T('路径参数') + '</h4>' + htmlTable([T('名字'), T('示例值'), T('必填'), T('说明')],
                    api.params.path.map(function (row) { return [row.key, row.value, row.required ? T('是') : '', row.desc]; })));
            }
            if (api.params.query.length) {
                blocks.push('<h4>' + T('查询参数') + '</h4>' + htmlTable([T('名字'), T('示例值'), T('必填'), T('说明')],
                    api.params.query.map(function (row) { return [row.key, row.value, row.required ? T('是') : '', row.desc]; })));
            }
            if (api.headers.length) {
                blocks.push('<h4>' + T('请求头') + '</h4>' + htmlTable([T('名字'), T('示例值'), T('必填'), T('说明')],
                    api.headers.map(function (row) {
                        return [row.key, row.value, row.required ? T('是') : '', (row.common ? T('（继承）') : '') + row.desc];
                    })));
            }

            var payload = api.body || { mode: 'none' };
            if (payload.mode === 'raw' && payload.raw) {
                blocks.push('<h4>' + T('请求体') + '</h4><pre class="code">' + escapeHtml(payload.raw) + '</pre>');
            } else if (payload.form && payload.form.length) {
                blocks.push('<h4>' + T('请求体（{kind}）', {
                    kind: payload.mode === 'formdata' ? 'form-data' : T('表单')
                }) + '</h4>' +
                    htmlTable([T('名字'), T('值'), T('说明')],
                        payload.form.map(function (row) { return [row.key, row.value, row.desc]; })));
            } else if (payload.mode === 'graphql' && payload.graphql && payload.graphql.query) {
                blocks.push('<h4>' + T('请求体（GraphQL）') + '</h4><pre class="code">' +
                    escapeHtml(payload.graphql.query) + '</pre>');
                if (payload.graphql.variables) {
                    blocks.push('<h4>' + T('变量') + '</h4><pre class="code">' +
                        escapeHtml(payload.graphql.variables) + '</pre>');
                }
            }

            (api.examples || []).forEach(function (example) {
                blocks.push('<h4>' + T('示例响应{name} · HTTP {status}', {
                    name: example.name ? T('（{name}）', { name: escapeHtml(example.name) }) : '',
                    status: escapeHtml(example.status)
                }) + '</h4>' +
                    '<pre class="code">' + escapeHtml(example.body) + '</pre>');
            });

            if ((api.responseFields || []).length) {
                blocks.push('<h4>' + T('响应字段说明') + '</h4>' + htmlTable([T('字段'), T('类型'), T('说明')],
                    api.responseFields.map(function (row) {
                        return [row.path, row.type, (row.required ? T('（必有）') : '') + row.desc];
                    })));
            }

            return '<section class="api">' + blocks.join('\n') + '</section>';
        }).join('\n');

        return '<section class="chapter">' +
            '<h2 id="chapter-' + chapterIndex + '">' + escapeHtml(chapter.name) + '</h2>' +
            (chapter.description ? '<p class="desc">' + escapeHtml(chapter.description) + '</p>' : '') +
            apis + '</section>';
    }).join('\n');

    return '<!DOCTYPE html>\n<html lang="' + (i18n.locale() === 'en' ? 'en' : 'zh-CN') + '">\n<head>\n' +
        '<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        '<title>' + escapeHtml(doc.project.name + ' ' + T('接口文档')) + '</title>\n' +
        '<style>\n' +
        'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;' +
        'margin:0;padding:0;color:#1f2937;background:#fff;font-size:14px;line-height:1.7}\n' +
        '.wrap{display:flex;align-items:flex-start;max-width:1180px;margin:0 auto;padding:28px 24px}\n' +
        'nav{position:sticky;top:28px;flex:0 0 240px;max-height:calc(100vh - 56px);overflow:auto;' +
        'padding-right:16px;border-right:1px solid #eee;font-size:13px}\n' +
        'nav ul{list-style:none;margin:0;padding-left:12px}\n' +
        'nav>ul{padding-left:0}\n' +
        'nav li{margin:2px 0}\n' +
        'nav a{color:#374151;text-decoration:none}\n' +
        'nav a:hover{color:#2563eb;text-decoration:underline}\n' +
        '.m{color:#6b7280;font-size:12px;font-family:ui-monospace,Menlo,monospace}\n' +
        'main{flex:1;min-width:0;padding-left:28px}\n' +
        'h1{font-size:24px;margin:0 0 6px}\n' +
        'h2{font-size:19px;margin:34px 0 10px;padding-bottom:6px;border-bottom:1px solid #eee}\n' +
        'h3{font-size:16px;margin:24px 0 8px}\n' +
        'h4{font-size:13px;margin:14px 0 6px;color:#6b7280}\n' +
        '.meta{color:#6b7280;margin:2px 0;font-size:13px}\n' +
        '.desc{white-space:pre-wrap;margin:6px 0}\n' +
        'pre.code{background:#f7f8fa;border-radius:6px;padding:10px 12px;overflow:auto;' +
        'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-all}\n' +
        'table{border-collapse:collapse;width:100%;margin:6px 0;font-size:13px}\n' +
        'th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #eee;vertical-align:top}\n' +
        'th{color:#6b7280;font-weight:500;background:#fafafa}\n' +
        '.note{color:#6b7280;font-size:13px;background:#fafafa;border-radius:6px;padding:8px 12px}\n' +
        '@media print{nav{display:none}main{padding-left:0}}\n' +
        '</style>\n</head>\n<body>\n<div class="wrap">\n' +
        '<nav><strong>' + escapeHtml(T('目录（文档）')) + '</strong><ul>' + toc + '</ul></nav>\n' +
        '<main>\n' +
        '<h1>' + escapeHtml(doc.project.name + ' ' + T('接口文档')) + '</h1>\n' +
        (doc.project.description ? '<p class="desc">' + escapeHtml(doc.project.description) + '</p>\n' : '') +
        '<p class="meta">' + escapeHtml(T('导出时间：{time}　接口数量：{apis} 个（{folders} 个目录）{scope}', {
            time: doc.exportedAtText,
            apis: doc.stats.apis,
            folders: doc.stats.folders,
            scope: doc.scope.folderId ? T('　范围：目录「{name}」', { name: doc.scope.name }) : ''
        })) + '</p>\n' +
        '<p class="note">' + escapeHtml(T('密码、token 这类值已自动遮住；环境变量的值、脚本不会出现在文档里。')) + '</p>\n' +
        body + '\n</main>\n</div>\n</body>\n</html>\n';
}

/* ================================================================== Word */

/**
 * Word（`.docx`）。
 *
 * `docx` 这个包用到时才 require：云端和网关每次启动都去加载一个文档库不划算
 * （和 mysql2 / socket.io-client 那些一个道理，见计划第 0 节）。
 *
 * 目录用 Word 自己的目录域（`TableOfContents`）：打开文档时 Word 会提示更新域，
 * 更新之后就带页码了 —— 我们自己拼一份静态目录反而没有页码。
 */
async function renderDocx(doc) {
    var docx = require('docx');

    var Document = docx.Document;
    var Packer = docx.Packer;
    var Paragraph = docx.Paragraph;
    var TextRun = docx.TextRun;
    var HeadingLevel = docx.HeadingLevel;
    var Table = docx.Table;
    var TableRow = docx.TableRow;
    var TableCell = docx.TableCell;
    var WidthType = docx.WidthType;
    var TableOfContents = docx.TableOfContents;
    var AlignmentType = docx.AlignmentType;

    var MONO = 'Menlo';

    function text(value, options) {
        return new Paragraph(Object.assign({
            children: [new TextRun(Object.assign({ text: str(value) }, (options || {}).run || {}))],
            spacing: { before: 40, after: 40 }
        }, (options || {}).paragraph || {}));
    }

    /** 等宽 + 浅灰底的代码块（一行一个段落，段落底纹拼起来才像一块） */
    function codeBlock(value) {
        var lines = str(value).split(/\r?\n/);
        return lines.map(function (line, index) {
            return new Paragraph({
                children: [new TextRun({ text: line || ' ', font: MONO, size: 18 })],
                shading: { fill: 'F5F5F5' },
                spacing: { before: index === 0 ? 60 : 0, after: index === lines.length - 1 ? 120 : 0 },
                indent: { left: 120, right: 120 }
            });
        });
    }

    function table(headers, rows) {
        if (!rows.length) return [];

        function cell(value, bold) {
            return new TableCell({
                width: { size: 100 / headers.length, type: WidthType.PERCENTAGE },
                children: [new Paragraph({
                    children: [new TextRun({ text: str(value), bold: bold === true, size: 18 })]
                })]
            });
        }

        return [new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [new TableRow({ children: headers.map(function (name) { return cell(name, true); }) })]
                .concat(rows.map(function (row) {
                    return new TableRow({ children: row.map(function (value) { return cell(value); }) });
                }))
        }), new Paragraph({ text: '', spacing: { after: 80 } })];
    }

    var children = [];

    children.push(new Paragraph({
        children: [new TextRun({ text: doc.project.name + ' ' + T('接口文档'), bold: true, size: 36 })],
        spacing: { after: 120 }
    }));
    if (doc.project.description) children.push(text(doc.project.description));
    children.push(text(T('导出时间：{time}　接口数量：{apis} 个（{folders} 个目录）{scope}', {
        time: doc.exportedAtText,
        apis: doc.stats.apis,
        folders: doc.stats.folders,
        scope: doc.scope.folderId ? T('　范围：目录「{name}」', { name: doc.scope.name }) : ''
    })));
    children.push(text(T('密码、token 这类值已自动遮住；环境变量的值、脚本不会出现在文档里。')));

    children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
    children.push(new Paragraph({ children: [new TextRun({ text: T('目录（文档）'), bold: true, size: 28 })] }));
    children.push(new TableOfContents(T('目录（文档）'), { hyperlink: true, headingStyleRange: '1-3' }));
    children.push(new Paragraph({ text: '', pageBreakBefore: true }));

    doc.chapters.forEach(function (chapter) {
        children.push(new Paragraph({ text: chapter.name, heading: HeadingLevel.HEADING_1 }));
        if (chapter.description) children.push(text(chapter.description));

        chapter.apis.forEach(function (api) {
            children.push(new Paragraph({ text: api.name, heading: HeadingLevel.HEADING_2 }));
            children.push(new Paragraph({
                children: [new TextRun({ text: api.method + ' ' + api.url, font: MONO, bold: true })],
                spacing: { after: 60 }
            }));
            children.push(text(T('状态：{status}', { status: api.statusLabel }) +
                (api.ownerName ? T('　负责人：{name}', { name: api.ownerName }) : '') +
                (api.authType && api.authType !== 'none' ? T('　鉴权：{type}', { type: api.authType }) : '')));
            if (api.mockUrl) children.push(text(T('Mock 地址：{url}', { url: api.mockUrl })));

            // gRPC（第十一轮第 1 节）：服务 / 方法 / TLS 和请求消息示例
            if (api.grpc) {
                var grpcParts = [];
                if (api.grpc.service) grpcParts.push(T('服务：{name}', { name: api.grpc.service }));
                if (api.grpc.method) grpcParts.push(T('方法：{name}', { name: api.grpc.method }));
                if (api.grpc.tls) grpcParts.push(T('TLS：开'));
                if (grpcParts.length) children.push(text(grpcParts.join('　')));

                if (api.grpc.message) {
                    children.push(new Paragraph({ text: T('请求消息'), heading: HeadingLevel.HEADING_3 }));
                    codeBlock(api.grpc.message).forEach(function (node) { children.push(node); });
                }
            }

            // RabbitMQ（第十六轮 T40）：消费者 / 常用发布
            if (api.amqp) {
                children.push(new Paragraph({ text: T('消费者'), heading: HeadingLevel.HEADING_3 }));
                api.amqp.consumers.forEach(function (row) {
                    children.push(text(amqpConsumerText(row)));
                });

                if (api.amqp.saved.length) {
                    children.push(new Paragraph({ text: T('常用发布'), heading: HeadingLevel.HEADING_3 }));
                    api.amqp.saved.forEach(function (row) {
                        children.push(text(T('{name}：exchange「{exchange}」路由键「{routingKey}」', {
                            name: row.name,
                            exchange: row.exchange || T('（默认交换机）'),
                            routingKey: row.routingKey
                        })));
                        if (row.payload) {
                            codeBlock(row.payload).forEach(function (node) { children.push(node); });
                        }
                    });
                }
            }

            // RabbitMQ（第十六轮 T40）：消费者 / 常用发布
            if (api.amqp) {
                children.push(new Paragraph({ text: T('消费者'), heading: HeadingLevel.HEADING_3 }));
                api.amqp.consumers.forEach(function (row) {
                    children.push(text(amqpConsumerText(row)));
                });

                if (api.amqp.saved.length) {
                    children.push(new Paragraph({ text: T('常用发布'), heading: HeadingLevel.HEADING_3 }));
                    api.amqp.saved.forEach(function (row) {
                        children.push(text(T('{name}：exchange「{exchange}」路由键「{routingKey}」', {
                            name: row.name,
                            exchange: row.exchange || T('（默认交换机）'),
                            routingKey: row.routingKey
                        })));
                        if (row.payload) {
                            codeBlock(row.payload).forEach(function (node) { children.push(node); });
                        }
                    });
                }
            }

            // RabbitMQ（第十六轮 T40）：消费者 / 常用发布
            if (api.amqp) {
                children.push(new Paragraph({ text: T('消费者'), heading: HeadingLevel.HEADING_3 }));
                api.amqp.consumers.forEach(function (row) {
                    children.push(text(amqpConsumerText(row)));
                });

                if (api.amqp.saved.length) {
                    children.push(new Paragraph({ text: T('常用发布'), heading: HeadingLevel.HEADING_3 }));
                    api.amqp.saved.forEach(function (row) {
                        children.push(text(T('{name}：exchange「{exchange}」路由键「{routingKey}」', {
                            name: row.name,
                            exchange: row.exchange || T('（默认交换机）'),
                            routingKey: row.routingKey
                        })));
                        if (row.payload) {
                            codeBlock(row.payload).forEach(function (node) { children.push(node); });
                        }
                    });
                }
            }

            // MQTT（第十三轮）：协议版本 / 客户端 ID / 订阅列表 / 常用发布
            if (api.mqtt) {
                var mqttParts = [T('协议版本：{value}', { value: api.mqtt.protocolLabel })];
                if (api.mqtt.clientId) {
                    mqttParts.push(T('客户端 ID：{value}', { value: api.mqtt.clientId }));
                }
                children.push(text(mqttParts.join('　')));

                if (api.mqtt.subscriptions.length) {
                    children.push(new Paragraph({ text: T('订阅主题'), heading: HeadingLevel.HEADING_3 }));
                    table([T('主题'), T('QoS'), T('启用')], api.mqtt.subscriptions.map(function (row) {
                        return [row.topic, String(row.qos), row.enabled === false ? T('否') : T('是')];
                    })).forEach(function (node) { children.push(node); });
                }

                if (api.mqtt.saved.length) {
                    children.push(new Paragraph({ text: T('常用发布'), heading: HeadingLevel.HEADING_3 }));
                    api.mqtt.saved.forEach(function (row) {
                        children.push(text(T('{name}：{topic}（QoS {qos}{retain}）', {
                            name: row.name,
                            topic: row.topic || T('(未填主题)'),
                            qos: row.qos,
                            retain: row.retain ? T('，retain') : ''
                        })));
                        if (row.payload) {
                            codeBlock(row.payload).forEach(function (node) { children.push(node); });
                        }
                    });
                }
            }

            // TCP / UDP（第十五轮）：分帧 / 默认发送格式 / UDP 设置 / 常用发送
            if (api.socket) {
                var socketParts = [
                    T('分帧：{value}', { value: api.socket.framing }),
                    T('默认发送格式：{value}', {
                        value: T(ENCODING_LABELS[api.socket.sendEncoding] || api.socket.sendEncoding)
                    }),
                    T('行尾：{value}', {
                        value: T(LINE_ENDING_LABELS[api.socket.lineEnding] || api.socket.lineEnding)
                    })
                ];
                if (api.socket.method === 'UDP') {
                    socketParts.push(T('本机端口：{value}', {
                        value: api.socket.udp.bindPort === null ? T('随机') : String(api.socket.udp.bindPort)
                    }));
                    socketParts.push(T('允许广播：{value}',
                        { value: api.socket.udp.broadcast ? T('是') : T('否') }));
                }
                children.push(text(socketParts.join('　')));

                if (api.socket.saved.length) {
                    children.push(new Paragraph({ text: T('常用发送'), heading: HeadingLevel.HEADING_3 }));
                    api.socket.saved.forEach(function (row) {
                        children.push(text(T('{name}（{encoding}）', {
                            name: row.name,
                            encoding: T(ENCODING_LABELS[row.encoding] || row.encoding)
                        })));
                        if (row.payload) {
                            codeBlock(row.payload).forEach(function (node) { children.push(node); });
                        }
                    });
                }
            }

            if (api.description) children.push(text(api.description));

            if (api.params.path.length) {
                children.push(new Paragraph({ text: T('路径参数'), heading: HeadingLevel.HEADING_3 }));
                table([T('名字'), T('示例值'), T('必填'), T('说明')], api.params.path.map(function (row) {
                    return [row.key, row.value, row.required ? T('是') : '', row.desc];
                })).forEach(function (node) { children.push(node); });
            }
            if (api.params.query.length) {
                children.push(new Paragraph({ text: T('查询参数'), heading: HeadingLevel.HEADING_3 }));
                table([T('名字'), T('示例值'), T('必填'), T('说明')], api.params.query.map(function (row) {
                    return [row.key, row.value, row.required ? T('是') : '', row.desc];
                })).forEach(function (node) { children.push(node); });
            }
            if (api.headers.length) {
                children.push(new Paragraph({ text: T('请求头'), heading: HeadingLevel.HEADING_3 }));
                table([T('名字'), T('示例值'), T('必填'), T('说明')], api.headers.map(function (row) {
                    return [row.key, row.value, row.required ? T('是') : '', (row.common ? T('（继承）') : '') + row.desc];
                })).forEach(function (node) { children.push(node); });
            }

            var payload = api.body || { mode: 'none' };
            if (payload.mode === 'raw' && payload.raw) {
                children.push(new Paragraph({ text: T('请求体'), heading: HeadingLevel.HEADING_3 }));
                codeBlock(payload.raw).forEach(function (node) { children.push(node); });
            } else if (payload.form && payload.form.length) {
                children.push(new Paragraph({
                    text: T('请求体（{kind}）', {
                        kind: payload.mode === 'formdata' ? 'form-data' : T('表单')
                    }),
                    heading: HeadingLevel.HEADING_3
                }));
                table([T('名字'), T('值'), T('说明')], payload.form.map(function (row) {
                    return [row.key, row.value, row.desc];
                })).forEach(function (node) { children.push(node); });
            } else if (payload.mode === 'graphql' && payload.graphql && payload.graphql.query) {
                children.push(new Paragraph({ text: T('请求体（GraphQL）'), heading: HeadingLevel.HEADING_3 }));
                codeBlock(payload.graphql.query).forEach(function (node) { children.push(node); });
            }

            (api.examples || []).forEach(function (example) {
                children.push(new Paragraph({
                    text: T('示例响应{name} · HTTP {status}', {
                        name: example.name ? T('（{name}）', { name: example.name }) : '',
                        status: example.status
                    }),
                    heading: HeadingLevel.HEADING_3
                }));
                codeBlock(example.body).forEach(function (node) { children.push(node); });
            });

            if ((api.responseFields || []).length) {
                children.push(new Paragraph({ text: T('响应字段说明'), heading: HeadingLevel.HEADING_3 }));
                table([T('字段'), T('类型'), T('说明')], api.responseFields.map(function (row) {
                    return [row.path, row.type, (row.required ? T('（必有）') : '') + row.desc];
                })).forEach(function (node) { children.push(node); });
            }
        });
    });

    var document = new Document({
        creator: 'apiloop',
        title: doc.project.name + ' ' + T('接口文档'),
        sections: [{
            properties: {},
            children: children
        }]
    });

    return Packer.toBuffer(document);
}

module.exports = {
    buildDoc: buildDoc,
    renderMarkdown: renderMarkdown,
    renderHtml: renderHtml,
    renderDocx: renderDocx,
    fileName: fileName,
    STATUS_LABELS: STATUS_LABELS
};
