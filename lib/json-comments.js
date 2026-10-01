/**
 * JSON 请求体里的注释（和 Postman 一样：请求体里可以写注释，发送时去掉）。
 *
 * 用户习惯在请求体里用 `//` 把暂时不传的字段注释掉，或者写一句说明（2026-10-01 用户要求）。
 * 标准 JSON 不认注释，原样发出去对方会报格式错误，所以发送前在这里去掉。
 *
 * 规则：
 * - 只去掉**字符串外面**的 `// …`（到行尾）和块注释（斜杠星号开头、星号斜杠结尾）；字符串里的 `"http://…"` 原样保留；
 * - 再去掉 `}` / `]` 前面多余的逗号 —— 把最后一个字段注释掉时很常见，留着它 JSON 就不合法；
 * - 换行保留（块注释跨行时，里面的换行也留着），行号和原文对得上。
 *
 * 不认识的内容一律原样输出：这不是 JSON 解析器，`{{变量}}` 这类模板写法照样过得去。
 */

/**
 * @param {string} text
 * @returns {string}
 */
function stripJsonComments(text) {
    var source = String(text === undefined || text === null ? '' : text);
    var out = '';
    var i = 0;
    var inString = false;

    while (i < source.length) {
        var ch = source[i];
        var next = source[i + 1];

        if (inString) {
            out += ch;
            if (ch === '\\' && next !== undefined) {
                out += next;
                i += 2;
                continue;
            }
            if (ch === '"') inString = false;
            i += 1;
            continue;
        }

        if (ch === '"') {
            inString = true;
            out += ch;
            i += 1;
            continue;
        }

        // 行注释：吃到行尾，换行本身留着
        if (ch === '/' && next === '/') {
            while (i < source.length && source[i] !== '\n') i += 1;
            continue;
        }

        // 块注释：吃到 */，里面的换行留着
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
                if (source[i] === '\n') out += '\n';
                i += 1;
            }
            i += 2;
            continue;
        }

        out += ch;
        i += 1;
    }

    return removeTrailingCommas(out);
}

/** 去掉 `}` / `]` 前面多余的逗号（中间只隔着空白）。同样只看字符串外面 */
function removeTrailingCommas(text) {
    var out = '';
    var inString = false;

    for (var i = 0; i < text.length; i++) {
        var ch = text[i];

        if (inString) {
            out += ch;
            if (ch === '\\' && i + 1 < text.length) {
                out += text[i + 1];
                i += 1;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }

        if (ch === ',') {
            var j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j += 1;
            if (text[j] === '}' || text[j] === ']') continue; // 多余的逗号，丢掉
        }

        out += ch;
    }

    return out;
}

module.exports = {
    stripJsonComments: stripJsonComments
};
