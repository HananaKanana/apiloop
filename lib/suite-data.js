/**
 * 测试集的数据（数据驱动，第八轮第 1 节）。
 *
 * 一份数据就是一列列变量：**每一行跑一轮**，列名就是变量名（接口里写 `{{列名}}`，
 * 脚本里 `pm.iterationData.get('列名')`）。存的是**原文**，运行时 / 预览时才解析 ——
 * 这个文件是唯一的解析实现，运行和 `preview-data` 共用，前端不再写一份。
 *
 * CSV 的规则（和常见工具一致）：
 * - 第一行是列名，逗号分隔；
 * - 双引号转义：`""` 是一个双引号；
 * - **引号里可以有换行和逗号**；
 * - 开头有 UTF-8 BOM 就去掉（Excel 导出的 CSV 都带）；
 * - 全空的行跳过；
 * - `\r\n` 和 `\n` 都认。
 *
 * 值**一律是字符串**：JSON 里是数字 / 布尔也转成字符串，对象 / 数组 `JSON.stringify`
 * —— 变量表本来就是字符串表，运行时再转换一次只会让两边不一致。
 */

var i18n = require('./i18n');

/** 上限：1000 行、2 MB（计划里定的） */
var MAX_ROWS = 1000;
var MAX_BYTES = 2 * 1024 * 1024;

function stripBom(text) {
    return text.charAt(0) === '\uFEFF' ? text.slice(1) : text;
}

/** 一行是不是全空（空串或只有空白） */
function isEmptyRow(fields) {
    return fields.every(function (field) { return String(field).trim() === ''; });
}

/**
 * CSV 原文 → 二维数组。
 *
 * 手写状态机而不是 split(',')：引号里的逗号和换行是 CSV 里最常见的两个坑，
 * `split` 出来的东西在真实数据上一定错。
 */
function parseCsv(text) {
    var source = stripBom(String(text === undefined || text === null ? '' : text));
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var index = 0;

    while (index < source.length) {
        var ch = source.charAt(index);

        if (inQuotes) {
            if (ch === '"') {
                if (source.charAt(index + 1) === '"') {
                    field += '"';
                    index += 2;
                    continue;
                }
                inQuotes = false;
                index += 1;
                continue;
            }
            field += ch;
            index += 1;
            continue;
        }

        if (ch === '"') {
            inQuotes = true;
            index += 1;
            continue;
        }

        if (ch === ',') {
            row.push(field);
            field = '';
            index += 1;
            continue;
        }

        if (ch === '\r' || ch === '\n') {
            // \r\n 算一个换行
            if (ch === '\r' && source.charAt(index + 1) === '\n') index += 1;
            index += 1;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            continue;
        }

        field += ch;
        index += 1;
    }

    row.push(field);
    rows.push(row);

    return rows;
}

/** JSON 里的值 → 变量表要的字符串 */
function toCell(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);

    try {
        return JSON.stringify(value);
    } catch (err) {
        return String(value);
    }
}

function parseJson(text) {
    var parsed;
    try {
        parsed = JSON.parse(stripBom(String(text)));
    } catch (err) {
        return {
            ok: false,
            error: i18n.m('不是合法的 JSON：{reason}', { reason: (err && err.message) || err })
        };
    }

    if (!Array.isArray(parsed)) {
        return { ok: false, error: i18n.m('JSON 数据的顶层要是数组（对象数组）') };
    }
    if (!parsed.length) {
        return { ok: false, error: i18n.m('这个数组是空的，一行数据都没有') };
    }

    var columns = [];
    parsed.forEach(function (item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return;
        Object.keys(item).forEach(function (key) {
            if (columns.indexOf(key) === -1) columns.push(key);
        });
    });

    if (!columns.length) {
        return { ok: false, error: i18n.m('数组里的元素要是对象（比如 [{"账号":"a"}]）') };
    }

    var rows = parsed.map(function (item, index) {
        var row = {};
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            // 混进来的非对象元素当空行处理，但要说清楚是第几行
            columns.forEach(function (key) { row[key] = ''; });
            row.__problem = i18n.m('第 {n} 个元素不是对象', { n: index + 1 });
            return row;
        }
        columns.forEach(function (key) { row[key] = toCell(item[key]); });
        return row;
    });

    return { ok: true, columns: columns, rows: rows };
}

/**
 * 解析一份数据。
 *
 * @param {{format?: string, text?: string}|null} data
 * @returns {{ok: true, columns: string[], rows: Array<object>} | {ok: false, error: string}}
 */
function parse(data) {
    if (!data || !data.format || data.format === 'none') {
        return { ok: false, error: i18n.m('这份测试集没有用数据') };
    }

    var text = String(data.text === undefined || data.text === null ? '' : data.text);
    if (!text.trim()) return { ok: false, error: i18n.m('数据是空的') };

    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
        return { ok: false, error: i18n.m('数据超过 {mb} MB 了，拆小一点', { mb: MAX_BYTES / 1024 / 1024 }) };
    }

    if (data.format === 'json') {
        var fromJson = parseJson(text);
        if (!fromJson.ok) return fromJson;
        if (fromJson.rows.length > MAX_ROWS) {
            return {
                ok: false,
                error: i18n.m('数据有 {n} 行，最多 {max} 行', { n: fromJson.rows.length, max: MAX_ROWS })
            };
        }
        return { ok: true, columns: fromJson.columns, rows: fromJson.rows };
    }

    if (data.format !== 'csv') {
        return { ok: false, error: i18n.m('不认识的数据格式：{format}', { format: data.format }) };
    }

    var table = parseCsv(text).filter(function (fields) { return !isEmptyRow(fields); });
    if (!table.length) return { ok: false, error: i18n.m('数据是空的') };

    var header = table[0].map(function (name) { return String(name).trim(); });
    if (!header.length || header.every(function (name) { return name === ''; })) {
        return { ok: false, error: i18n.m('第一行是列名，现在是空的') };
    }

    var body = table.slice(1).filter(function (fields) {
        // 只留「这一行有内容」的；列数对不上的下面单独报错，不能静默丢掉
        return fields.some(function (field) { return String(field) !== ''; });
    });

    for (var index = 0; index < body.length; index += 1) {
        if (body[index].length !== header.length) {
            return {
                ok: false,
                error: i18n.m('第 {line} 行有 {got} 列，但表头（第一行）是 {want} 列',
                    { line: index + 2, got: body[index].length, want: header.length })
            };
        }
    }

    if (body.length > MAX_ROWS) {
        return {
            ok: false,
            error: i18n.m('数据有 {n} 行，最多 {max} 行', { n: body.length, max: MAX_ROWS })
        };
    }

    var rows = body.map(function (fields) {
        var row = {};
        header.forEach(function (name, at) { row[name] = fields[at] === undefined ? '' : fields[at]; });
        return row;
    });

    return { ok: true, columns: header, rows: rows };
}

/**
 * 预览：前 N 行 + 总行数（数据页签那张表用）。
 *
 * @param {{format?: string, text?: string}|null} data
 * @param {number} [limit] 默认 20 行
 */
function preview(data, limit) {
    var parsed = parse(data);
    if (!parsed.ok) return parsed;

    var size = Number(limit);
    if (!Number.isFinite(size) || size <= 0) size = 20;

    return {
        ok: true,
        columns: parsed.columns,
        rows: parsed.rows.slice(0, size),
        total: parsed.rows.length
    };
}

module.exports = {
    MAX_ROWS: MAX_ROWS,
    MAX_BYTES: MAX_BYTES,
    parse: parse,
    preview: preview,
    parseCsv: parseCsv,
    toCell: toCell
};
