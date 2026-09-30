/**
 * repo 层内部共用的小工具。
 *
 * 计划里没有单列这个文件，但 id 生成和「按 patch 拼 UPDATE」这两件事六张表都要用，
 * 复制六份不如收在一处。
 */

var ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 生成主键。前缀区分实体类型（u_ 用户、p_ 项目、a_ 接口……），
 * 后接时间戳与随机串，肉眼可读又不会撞。
 */
function newId(prefix) {
    var random = '';
    for (var i = 0; i < 8; i++) {
        random += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
    }
    return prefix + '_' + Date.now().toString(36) + random;
}

/**
 * 只更新 patch 里出现的、且 columnMap 认识的列。
 * 不认识的键直接忽略 —— 界面上多传字段不应该把库写坏。
 *
 * @param {string} table
 * @param {object} columnMap { camelCase: 'column_name' }
 * @param {object} patch
 * @param {Function} [encode] (camelKey, value) => 绑定值，默认原样
 * @returns {{sql: string, values: Array}|null} 没有任何可更新列时返回 null
 */
function buildUpdate(table, columnMap, patch, encode) {
    var sets = [];
    var values = [];

    Object.keys(patch || {}).forEach(function (key) {
        if (!columnMap[key]) return;
        sets.push(columnMap[key] + ' = ?');
        values.push(encode ? encode(key, patch[key]) : patch[key]);
    });

    if (!sets.length) return null;
    return {
        sql: 'UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE id = ?',
        values: values
    };
}

/** 执行 buildUpdate 的结果；没有可更新列就什么也不做，返回是否真的写了 */
function applyUpdate(handle, table, columnMap, id, patch, encode) {
    var built = buildUpdate(table, columnMap, patch, encode);
    if (!built) return false;

    built.values.push(id);
    var statement = handle.db.prepare(built.sql);
    // node:sqlite 的 run 是「展开参数」签名，得用 apply 而不是传数组
    statement.run.apply(statement, built.values);
    return true;
}

module.exports = {
    newId: newId,
    buildUpdate: buildUpdate,
    applyUpdate: applyUpdate
};
