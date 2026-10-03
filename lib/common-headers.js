/**
 * 公共请求头（第五轮第 1 节）。
 *
 * 很多接口都要带同样的请求头（`X-User-Info`、`X-Tenant-Id`），以前只能一个接口一个接口
 * 地加。现在项目 / 目录上各能配一组，发送时按「项目 → 外层目录 → 内层目录 → 接口」合并。
 *
 * 三条规则，四个调用方（发送、WebSocket 握手、分享文档、导出 OpenAPI）**共用这一份**：
 *
 * - **同名不分大小写**：`X-Token` 和 `x-token` 是同一个；
 * - **越靠近接口越优先**：接口 > 内层目录 > 外层目录 > 项目；
 * - **停用的行照样算「这一层表过态」**：内层把某个头停用，就是把外层的那个覆盖成「不发」。
 *   所以 `resolve` 先按优先级定出每一名字的赢家，最后才把停用的那些丢掉。
 *   少了前半句的话，用户在内层「关掉」一个头会发现它还在发。
 *
 * 存的地方是 `projects.extra.headers` / `folders.extra.headers`（会跟着同步走，不用迁移），
 * 行的形状和接口自己的请求头一样，所以两边能直接拼在一起。
 */

var dto = require('./api/dto');

/** 归一化成请求头行的形状；没有名字的行直接丢掉（界面上新建一行还没填名字是常事） */
function normalize(list) {
    return dto.toRows(list);
}

/** 某个项目 / 目录上配的公共请求头（存在 `extra.headers` 里） */
function headersOf(entity) {
    var extra = entity ? entity.extra : null;
    if (!extra || typeof extra !== 'object') return [];

    return normalize(extra.headers);
}

/**
 * 把公共请求头写回 `extra`：**先读出原来的再合并**，别把 extra 里别的字段冲掉。
 * 行清空时把这个键删掉，不留一个空数组在库里（读回来还是空，但导出文件干净些）。
 */
function withHeaders(extra, rows) {
    var next = Object.assign({}, extra && typeof extra === 'object' ? extra : {});
    var list = normalize(rows);

    if (list.length) next.headers = list;
    else delete next.headers;

    return next;
}

/**
 * 继承链上的各层，**从外到内**（项目 → 外层目录 → … → 接口自己所在的那个目录）。
 * 每一层带一个给界面看的名字（`来自哪里`）。
 *
 * @param {object} project
 * @param {Array<object>} folders 目录链，越靠后越内层（调用方按自己的顺序给，见 api/send.js 的 folderChain）
 */
function layersFor(project, folders) {
    var layers = [{ label: '项目', rows: headersOf(project) }];

    (folders || []).forEach(function (folder) {
        layers.push({ label: '目录 ' + folder.name, rows: headersOf(folder) });
    });

    return layers;
}

function lowerKey(row) {
    return String(row.key).toLowerCase();
}

/**
 * 把继承来的公共请求头合进接口自己那份。
 *
 * @param {Array} own 接口自己的请求头行
 * @param {Array<{label: string, rows: Array}>} layers 继承来的各层（外 → 内）
 * @returns {{rows: Array, inherited: Array}}
 *   `rows`：这次实际要发出去的（接口自己的在前，继承来的补在后面，停用的不在里面）；
 *   `inherited`：继承来的每一行（**同名只留优先级最高的那个**），带 `from`（哪一层给的）
 *     和 `shadowed`（被接口自己的同名行盖掉了）。界面和文档靠这两样显示「来自哪里」「已被覆盖」——
 *     停用的行也留在里面，界面上要能看出「这里有一行，但它不发」。
 */
function resolve(own, layers) {
    var ownRows = normalize(own);
    var taken = {};
    ownRows.forEach(function (row) { taken[lowerKey(row)] = true; });

    var byKey = {};
    var order = [];

    (layers || []).forEach(function (layer) {
        normalize(layer.rows).forEach(function (row) {
            var key = lowerKey(row);
            if (order.indexOf(key) === -1) order.push(key);
            // 后面的层覆盖前面的
            byKey[key] = { row: row, from: layer.label };
        });
    });

    var inherited = order.map(function (key) {
        return Object.assign({}, byKey[key].row, {
            from: byKey[key].from,
            shadowed: taken[key] === true
        });
    });

    var rows = ownRows.concat(inherited.filter(function (row) {
        return !row.shadowed && row.enabled !== false;
    }).map(function (row) {
        return {
            key: row.key,
            value: row.value,
            type: row.type,
            required: row.required,
            desc: row.desc,
            enabled: row.enabled
        };
    }));

    return { rows: rows, inherited: inherited };
}

module.exports = {
    normalize: normalize,
    headersOf: headersOf,
    withHeaders: withHeaders,
    layersFor: layersFor,
    resolve: resolve
};
