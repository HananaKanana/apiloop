/**
 * 保密变量（第三轮第 3 节，设计见 docs/plans/2026-10-03-round3.md）。
 *
 * 变量行标了 `secret: true` 的，**值只属于填它的人**：
 *   - 共享数据（项目 / 目录 / 环境的 variables JSON）里 value 永远存空串，
 *     于是同步出去的是空、导出的是空、同事看到的也是空；
 *   - 真正的值按「人 + 位置 + 变量名」存在 `secret_values`（这张表不同步）。
 *
 * 三个入口，对应三条路径：
 *   - `split`：**写**。保存变量时，把保密行的值收进自己的表、共享数据里留空。
 *   - `merge`：**读**。返回给页面时，把当前用户自己的值填回去，页面不用改就能显示、编辑。
 *   - `valuesAt` / `applyChange`：**发送**。发送前要把值填回去；脚本写回变量时，
 *     保密 key 要写进自己的表而不是共享数据。
 *
 * 删目录 / 环境时顺手清掉它的保密值（`forgetScope`）；导入这种一次性写入之后用
 * `splitAll` 把整个项目重新分一遍（导入的 Postman 数据里 `type: secret` 是带明文的）。
 */

var secretValues = require('./db/repos/secret-values');
var projectsRepo = require('./db/repos/projects');
var foldersRepo = require('./db/repos/folders');
var environmentsRepo = require('./db/repos/environments');

/** 打码时值得替换的最短长度：太短的值（"1"、"on"）满屏误伤 */
var MIN_MASK_LENGTH = 4;

function isSecret(row) {
    return !!(row && row.secret === true);
}

function text(value) {
    return value === undefined || value === null ? '' : String(value);
}

/* ------------------------------------------------------------------ 写 */

/**
 * 保存路径：把保密行的值从共享数据里拿掉、存成自己的；返回去掉值的行。
 *
 * 值一律写进自己的表（**包括空串**），这样「清空某个保密值」也能生效；
 * 不再是保密、或者已经被删掉的行，表里的残留一起清掉。
 *
 * @param {Array<object>} rows 清洗过的变量行（见 dto.toVarRows）
 * @returns {Array<object>} 可以直接写进 variables JSON 的行
 */
function split(handle, userId, scope, scopeId, rows) {
    var source = Array.isArray(rows) ? rows : [];
    if (!userId) return source;

    var secretKeys = [];
    var out = source.map(function (row) {
        var next = Object.assign({}, row);
        if (!isSecret(next)) return next;

        secretKeys.push(next.key);
        secretValues.upsert(handle, userId, scope, scopeId, next.key, text(next.value));
        next.value = '';
        return next;
    });

    secretValues.keepOnly(handle, userId, scope, scopeId, secretKeys);
    return out;
}

/**
 * 导入这类「先写库、再收一遍」的路径用的：只把**带明文值**的保密行收进自己的表，
 * 不覆盖已有的值、也不删任何东西。
 *
 * 和 `split` 的区别：那边的入参是「界面提交的完整状态」，连空值一起写（所以清空也生效）；
 * 这里读的是库里的行，保密行的值本来就是空串，照 `split` 写会把用户已有的值冲掉。
 */
function adopt(handle, userId, scope, scopeId, rows) {
    var source = Array.isArray(rows) ? rows : [];
    if (!userId) return source;

    return source.map(function (row) {
        if (!isSecret(row)) return row;

        var next = Object.assign({}, row);
        if (next.value !== undefined && next.value !== null && String(next.value) !== '') {
            secretValues.upsert(handle, userId, scope, scopeId, next.key, String(next.value));
        }
        next.value = '';
        return next;
    });
}

/* ------------------------------------------------------------------ 读 */

/**
 * 读取路径：把当前用户自己的值填回保密行。别人的值读不到，填的是空串 ——
 * 界面上就是「这个变量存在，但值是空的，得自己填」。
 *
 * **自己没存过值时用共享数据里的值兜底**：「保密」开关在 2.1.0 之前就有（那时只是遮住显示），
 * 升级前标了保密的变量，值还在共享 JSON 里。不兜底的话，一升级所有人这些变量都变空、
 * 请求全挂。新格式的共享数据里保密行本来就是空串，兜底不改变它的结果；
 * 谁第一次保存这一层变量，`split` 就把值收进他自己的表、共享数据清空。
 */
function merge(handle, userId, scope, scopeId, rows) {
    var source = Array.isArray(rows) ? rows : [];
    if (!userId) return source;

    var any = source.some(function (row) { return isSecret(row); });
    if (!any) return source;

    var stored = secretValues.mapFor(handle, userId, scope, scopeId);
    return source.map(function (row) {
        if (!isSecret(row)) return row;

        var next = Object.assign({}, row);
        next.value = Object.prototype.hasOwnProperty.call(stored, row.key) ? stored[row.key] : text(row.value);
        return next;
    });
}

/* ------------------------------------------------------------------ 发送 */

/**
 * 这个用户在那个位置真正会用到的保密值（长度 >= 4 的）。发送时用来给历史打码。
 */
function valuesAt(handle, userId, scope, scopeId, rows) {
    var source = Array.isArray(rows) ? rows : [];
    if (!userId) return [];

    var secretRows = source.filter(isSecret);
    if (!secretRows.length) return [];

    // 和 merge 同一个兜底：自己没存过就是共享数据里的（升级前的老数据）
    var stored = secretValues.mapFor(handle, userId, scope, scopeId);
    return secretRows.map(function (row) {
        return Object.prototype.hasOwnProperty.call(stored, row.key) ? stored[row.key] : text(row.value);
    }).filter(function (value) {
        return typeof value === 'string' && value.length >= MIN_MASK_LENGTH;
    });
}

/**
 * 脚本写回变量（`pm.environment.set` 之类）。
 *
 * 和 `split` 的区别：这里的输入是「按 key 的增量」而不是整份行表，而且要处理新增 / 删除。
 * 保密 key 的新值写进自己的表，共享数据里那一行永远留空。
 *
 * @param {{set?: Object, unset?: Array<string>}} change
 * @returns {Array<object>} 新的行表
 */
function applyChange(handle, userId, scope, scopeId, rows, change) {
    var source = Array.isArray(rows) ? rows : [];
    var set = (change && change.set) || {};
    var unset = (change && change.unset) || [];

    var secretKeys = {};
    source.forEach(function (row) { if (isSecret(row)) secretKeys[row.key] = true; });

    var stored = {};
    var plain = {};
    Object.keys(set).forEach(function (key) {
        if (secretKeys[key]) stored[key] = set[key];
        else plain[key] = set[key];
    });

    var out = source.map(function (row) {
        var next = Object.assign({}, row);
        if (Object.prototype.hasOwnProperty.call(plain, row.key)) next.value = plain[row.key];
        // 保密行在共享数据里永远留空（脚本改了也只写进 secret_values）
        if (isSecret(row)) next.value = '';
        return next;
    });

    out = out.filter(function (row) { return unset.indexOf(row.key) === -1; });

    var existing = {};
    out.forEach(function (row) { existing[row.key] = true; });
    Object.keys(plain).forEach(function (key) {
        if (existing[key]) return;
        out.push({ key: key, value: plain[key], enabled: true });
    });

    if (userId) {
        Object.keys(stored).forEach(function (key) {
            secretValues.upsert(handle, userId, scope, scopeId, key, text(stored[key]));
        });
        var dropped = unset.filter(function (key) { return secretKeys[key]; });
        if (dropped.length) secretValues.removeKeys(handle, userId, scope, scopeId, dropped);
    }

    return out;
}

/* ------------------------------------------------------------------ 维护 */

/** 目录 / 环境被删掉时清掉它的保密值 */
function forgetScope(handle, scope, scopeId) {
    if (!scopeId) return;
    secretValues.removeScope(handle, scope, scopeId);
}

/**
 * 一次性写入之后（导入 Postman 数据）把整个项目重新分一遍。
 *
 * `postman.js` 解析 `type: 'secret'` 时是带明文的，导入那几条路直接写库，
 * 不经保存变量的接口，所以这里补一刀。包里原本就有值的照常收进自己的表。
 */
function splitAll(handle, userId, projectId) {
    if (!userId || !projectId) return;

    var project = projectsRepo.getById(handle, projectId);
    if (project) {
        projectsRepo.update(handle, project.id, {
            variables: adopt(handle, userId, 'project', project.id, project.variables)
        });
    }

    foldersRepo.list(handle, projectId).forEach(function (folder) {
        foldersRepo.update(handle, folder.id, {
            variables: adopt(handle, userId, 'folder', folder.id, folder.variables)
        });
    });

    environmentsRepo.list(handle, projectId).forEach(function (environment) {
        environmentsRepo.update(handle, environment.id, {
            variables: adopt(handle, userId, 'environment', environment.id, environment.variables)
        });
    });
}

module.exports = {
    MIN_MASK_LENGTH: MIN_MASK_LENGTH,
    split: split,
    adopt: adopt,
    merge: merge,
    valuesAt: valuesAt,
    applyChange: applyChange,
    forgetScope: forgetScope,
    splitAll: splitAll
};
