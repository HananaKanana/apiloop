/**
 * 三方合并（L3 Task 3，设计稿 5.3）。
 *
 * **字段的单位是「列」**：接口的 `name`、`method`、`url` 各算一个字段；`headers`、
 * `params`、`body`、`auth`、`scripts` 这类 JSON 列各自整块算一个字段。
 *
 * 对每一列比较「基线 / 我的 / 云端的」三份：
 *   - 两边改成一样 → 用它；
 *   - 只有一边改了 → 用改了的那边（**这就是「不同字段自动合并」**）；
 *   - 两边改得不一样 → 冲突。
 *
 * 位置类的列（`folder_id`、`parent_id`、`position`）冲突时直接用云端的、不提示 ——
 * 位置本来就没什么「谁对」可言，为它打断用户不值得。
 *
 * `rev`、`created_at`、`updated_at` 不参与比较；项目的 `slug`、`created_by` 也不比
 * （它们由服务端决定，本机看到的和云端不一样是正常的，B4 / B5）。
 */

var rows = require('../../sync/rows');
var apply = require('./apply');

/** 不参与比较的列 */
var SKIP = ['rev', 'created_at', 'updated_at'];

/** 位置类：冲突时用云端的 */
var POSITION = ['folder_id', 'parent_id', 'position'];

function sameValue(left, right) {
    var a = left === undefined ? null : left;
    var b = right === undefined ? null : right;
    if (a === null || b === null) return a === b;
    return String(a) === String(b);
}

/** 这个实体参与比较（也就是能被本机改）的列 */
function fieldsOf(entity) {
    return rows.columns(entity).filter(function (column) {
        return SKIP.indexOf(column) === -1;
    });
}

/**
 * @param {string} entity
 * @param {object|null} base 基线（上次和云端对齐时那一行）
 * @param {object|null} mine 本机现在的行
 * @param {object|null} theirs 云端现在的行
 * @returns {{merged: object, conflictFields: Array<string>}}
 */
function mergeRow(entity, base, mine, theirs) {
    var merged = Object.assign({}, mine || {});
    var conflictFields = [];

    fieldsOf(entity).forEach(function (column) {
        var b = base ? base[column] : undefined;
        var m = mine ? mine[column] : undefined;
        var t = theirs ? theirs[column] : undefined;

        if (sameValue(m, t)) { merged[column] = m; return; }        // 两边一样（含都没改）
        if (sameValue(m, b)) { merged[column] = t; return; }        // 只有云端改了
        if (sameValue(t, b)) { merged[column] = m; return; }        // 只有本机改了
        if (POSITION.indexOf(column) > -1) { merged[column] = t; return; }

        conflictFields.push(column);
    });

    return { merged: merged, conflictFields: conflictFields };
}

/**
 * 拿这一行的三方做一次判断，**推送和拉取两条路都走这里**。
 *
 * 返回的动作：
 *   - `restore`：本机删了、云端改了 —— 取消删除，用云端的行重新建出来（不打断用户）；
 *   - `conflict`：两边改得不一致，交给 `sync_conflicts`，这一行暂停推送；
 *   - `merged`：合出来了，写回本机、基线换成云端的，留在待同步里下一轮推。
 */
function resolveRow(handle, entity, id, theirs) {
    var baseline = apply.getBaseline(handle, entity, id);
    var mine = rows.get(handle, entity, id);

    // 本机把这一行删掉了（还留在待同步里），云端却改过它 —— 保留改了的那份
    if (!mine || !theirs) return { action: theirs ? 'restore' : 'merged' };

    var out = mergeRow(entity, baseline, mine, theirs);
    if (out.conflictFields.length) {
        return { action: 'conflict', fields: out.conflictFields, baseline: baseline, mine: mine, theirs: theirs };
    }

    return {
        action: 'merged',
        // rev 用云端的：基线已经是云端的这一份了，两边对齐下一轮推送才不会被判成冲突
        row: Object.assign({}, mine, out.merged, { rev: theirs.rev }),
        theirs: theirs
    };
}

/** 写回合并的结果：本机写成 merged，基线换成云端的 */
function applyMerged(handle, entity, id, row, theirs) {
    apply.applyRemote(handle, [{ entity: entity, id: id, row: row }]);
    apply.setBaseline(handle, entity, id, theirs);
}

/** 记进冲突表。`fields` 是给界面看的「哪几列不一致」 */
function writeConflict(handle, entity, id, fields, base, mine, theirs) {
    var payload = fields.map(function (field) {
        return {
            field: field,
            base: base ? jsonOf(base[field]) : null,
            mine: mine ? jsonOf(mine[field]) : null,
            theirs: theirs ? jsonOf(theirs[field]) : null
        };
    });

    handle.transaction(function () {
        handle.db.prepare(
            'DELETE FROM sync_conflicts WHERE entity = ? AND entity_id = ?'
        ).run(entity, String(id));

        handle.db.prepare(
            'INSERT INTO sync_conflicts (entity, entity_id, fields_json, remote_row_json, created_at) ' +
            'VALUES (?, ?, ?, ?, ?)'
        ).run(entity, String(id), JSON.stringify(payload), JSON.stringify(theirs || {}), Date.now());
    }, { projectId: null });

    return payload;
}

/** 原样存字符串（JSON 列本来就是字符串），别的转一下，保证能放进 JSON */
function jsonOf(value) {
    if (value === undefined) return null;
    return value;
}

/**
 * 读一条冲突。**必须把两个 JSON 列解开** —— `remote` 是云端当时那一行，
 * 「用我的」要靠它把基线换过去（原始列名是 `remote_row_json`，不解析的话拿到的是
 * undefined，基线会被清掉，那一行就永远推不上去了）。
 */
function readConflict(handle, entity, id) {
    var row = handle.db.prepare('SELECT * FROM sync_conflicts WHERE entity = ? AND entity_id = ?')
        .get(entity, String(id));
    if (!row) return null;

    var remote = null;
    var fields = [];
    try { remote = JSON.parse(row.remote_row_json); } catch (err) { remote = null; }
    try { fields = JSON.parse(row.fields_json); } catch (err) { fields = []; }

    return {
        entity: row.entity,
        entityId: row.entity_id,
        remote: remote,
        fields: fields,
        createdAt: row.created_at
    };
}

function listConflicts(handle) {
    return handle.db.prepare('SELECT * FROM sync_conflicts ORDER BY created_at').all().map(function (row) {
        return readConflict(handle, row.entity, row.entity_id);
    });
}

function removeConflict(handle, entity, id) {
    handle.db.prepare('DELETE FROM sync_conflicts WHERE entity = ? AND entity_id = ?')
        .run(entity, String(id));
}

module.exports = {
    mergeRow: mergeRow,
    resolveRow: resolveRow,
    applyMerged: applyMerged,
    writeConflict: writeConflict,
    readConflict: readConflict,
    listConflicts: listConflicts,
    removeConflict: removeConflict,
    fieldsOf: fieldsOf,
    POSITION: POSITION,
    SKIP: SKIP
};
