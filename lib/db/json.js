/**
 * JSON 列的读写小工具。
 *
 * 库里这类列存的是文本。读的时候一律容错：碰到坏数据回退成调用方给的默认值，
 * 不能因为一行脏数据让整个服务起不来。
 */

/**
 * @param {*} text 库里的原始文本，可能是 null / undefined / 空串
 * @param {*} fallback 解析失败或结果为空时返回的值
 */
function readJson(text, fallback) {
    if (text === null || text === undefined || text === '') return fallback;
    try {
        var value = JSON.parse(text);
        return value === null || value === undefined ? fallback : value;
    } catch (err) {
        return fallback;
    }
}

function writeJson(value) {
    return JSON.stringify(value === undefined ? null : value);
}

module.exports = {
    readJson: readJson,
    writeJson: writeJson
};
