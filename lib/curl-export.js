/**
 * 「代码片段 → cURL」。
 *
 * 请求的整理（变量解析、地址拼接、鉴权、请求体）已经搬到 `lib/code-export.js`，
 * 和别的语言共用同一份中间形状；这里只保留原来的入口，老调用方不用改。
 * 新代码请直接用 `lib/code-export.js` 的 `fromPrepared(prepared, language)`。
 */

var codeExport = require('./code-export');

module.exports = {
    /**
     * @param {object} prepared `lib/api/send.js` 的 prepare 产物
     * @returns {{curl: string, code: Object<string,string>, missing: string[]}}
     */
    fromPrepared: codeExport.fromPrepared,
    quote: codeExport.quote
};
