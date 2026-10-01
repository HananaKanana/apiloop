/**
 * 推送、冲突（L3 Task 3，设计稿 5.2 第 3 步、5.3）。
 *
 * 待同步的行从 `apply.pendingKeys` 来（`changes` ∪ 六张表里没有基线的行）：
 * **本机现在有就推现在的行；没有就推 `deleted: true`**。`baseRev` 取基线里记的云端 rev，
 * 没有就是 0（本机新建的）。云端按 `baseRev` 判断这一行有没有被别人改过。
 *
 * 顺序：项目 → 环境 → 目录（父目录在前）→ 接口 → 示例 → 期望；删除的子级在前。
 * 父级先上去，子行才挂得住。
 *
 * 合并**只靠这一条路**：拉取时遇到「本机也改过的行」是跳过的（游标已经过去了，
 * 不会再拉一次），所以合并必须用推送返回的 `conflict`（它带着云端当前那一行）。
 */

var rows = require('../../sync/rows');
var apisRepo = require('../../db/repos/apis');
var projectsRepo = require('../../db/repos/projects');
var apply = require('./apply');
var merge = require('./merge');

/** 和云端 `lib/sync/index.js` 的 PUSH_MAX_ITEMS 对齐 */
var PUSH_MAX_ITEMS = 200;

/**
 * @param {{handle: object, cloud: {get: Function, post: Function}}} options
 * @returns {Promise<{pushed: number, conflicts: number, forbidden: number,
 *                    failed: number, recreated: number, warnings: string[], errors: string[]}>}
 */
function runPush(options) {
    var handle = options.handle;
    var cloud = options.cloud;

    var summary = {
        pushed: 0,
        conflicts: 0,
        forbidden: 0,
        failed: 0,
        recreated: 0,
        /** 自动合并掉、留在待同步里等下一轮推的行数 */
        merged: 0,
        warnings: [],
        errors: []
    };

    var pending = apply.pendingKeys(handle);
    if (!pending.size) return Promise.resolve(summary);

    // 这一批的边界：推成功之后要删掉**这一行**在这之前的流水记录。
    // 读一次就够 —— 之后本机再改，那些记录的 seq 比它大，不会被误删
    var marker = handle.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes').get().seq;

    var items = buildItems(handle, pending);
    var context = { snapshotCache: {} };
    var chain = Promise.resolve();

    for (var i = 0; i < items.length; i += PUSH_MAX_ITEMS) {
        var batch = items.slice(i, i + PUSH_MAX_ITEMS);
        chain = chain.then(sendBatch(handle, cloud, batch, summary, marker, context));
    }

    return chain.then(function () { return summary; });
}

function sendBatch(handle, cloud, batch, summary, marker, context) {
    return function () {
        // 这一批推上去的行，按 `entity:id` 存一份 —— 回包时要用它当基线（B8），
        // 不能重新读本机（推送在路上时用户可能又改了这一行）
        var pushed = {};
        batch.forEach(function (item) { pushed[item.entity + ':' + item.id] = item; });

        return cloud.post('/sync/push', {
            items: batch.map(function (item) {
                if (item.deleted) {
                    return { entity: item.entity, id: item.id, baseRev: item.baseRev, deleted: true };
                }
                return { entity: item.entity, id: item.id, baseRev: item.baseRev, row: item.row };
            })
        }).then(function (answer) {
            var results = answer.results || [];
            context.pushed = pushed;

            var chain = Promise.resolve();
            results.forEach(function (result) {
                chain = chain.then(function () {
                    return handleResult(handle, cloud, result, summary, marker, context);
                });
            });
            return chain;
        });
    };
}

/* ------------------------------------------------------------------ 组装 */

/**
 * 待同步的键 → 一批要推的行。
 *
 * 分两组：本机还有这一行的（推现在的样子）和本机已经删掉的（推 deleted）。
 * 各自按 `rows.ORDER` 排（目录再按父目录在前 / 子级在前）。
 */
function buildItems(handle, keys) {
    var writes = [];
    var deletions = [];

    // 有冲突的行**暂停推送**，等用户在界面上选完（设计稿 5.3）。
    // 不排掉的话每一轮都会把它再推一次、再判一次冲突，白跑
    var waiting = {};
    handle.db.prepare('SELECT entity, entity_id FROM sync_conflicts').all().forEach(function (row) {
        waiting[row.entity + ':' + row.entity_id] = true;
    });

    keys.forEach(function (key) {
        var index = key.indexOf(':');
        var entity = key.slice(0, index);
        var id = key.slice(index + 1);
        if (!rows.has(entity)) return;
        if (waiting[key]) return;

        var row = rows.get(handle, entity, id);
        var baseline = apply.getBaseline(handle, entity, id);
        var baseRev = baseline && baseline.rev !== undefined && baseline.rev !== null
            ? Number(baseline.rev) : 0;

        if (!row) deletions.push({ entity: entity, id: id, baseRev: baseRev, deleted: true });
        else writes.push({ entity: entity, id: id, baseRev: baseRev, row: row });
    });

    return apply.sortItems(handle, writes, false).concat(apply.sortItems(handle, deletions, true));
}

/* ------------------------------------------------------------------ 逐条处理 */

function handleResult(handle, cloud, result, summary, marker, context) {
    var entity = result && result.entity ? String(result.entity) : '';
    var id = result && result.id ? String(result.id) : '';
    if (!rows.has(entity) || !id) return Promise.resolve();

    var mine = rows.get(handle, entity, id);

    if (result.status === 'ok') {
        /**
         * 基线记的是**这一批推上去的那一行**（`pushed.row`）+ 云端回的 `rev`（B8），
         * 不是「回包时本机现在的行」。
         *
         * 推送在路上时用户又改了这一行的话，本机现在那一版里有**还没推上去**的值；
         * 基线记成它，下一轮拉取时同事也改了同一列，本机这一列就等于基线、被当成
         * 「只有云端改了」直接覆盖 —— 用户刚才那次修改没有任何提示就没了。
         */
        var item = (context.pushed || {})[entity + ':' + id] || null;

        if (item && item.row && mine) {
            apply.setBaseline(handle, entity, id, Object.assign({}, item.row, { rev: result.rev }));
            setLocalRev(handle, entity, id, result.rev);
        } else {
            // 这一批推的是删除，或者本机在回包之前就把它删了：基线跟着行一起清
            apply.dropBaseline(handle, entity, id);
        }

        apply.clearChanges(handle, entity, id, marker);
        summary.pushed++;

        if (result.recreated) {
            summary.recreated++;
            summary.warnings.push('云端删掉过这个' + rows.label(entity) + '，本机改过的版本已经重新建出来');
        }
        return Promise.resolve();
    }

    if (result.status === 'conflict') {
        return resolveConflictWithCloud(handle, cloud, entity, id, result.row || null,
            summary, marker, context);
    }

    if (result.status === 'forbidden') {
        return overwriteFromCloud(handle, cloud, entity, id, summary, marker, context);
    }

    // invalid：留着，原因交给状态栏
    summary.failed++;
    summary.errors.push(rows.label(entity) + ' ' + id + '：' + (result.error || '云端拒绝了这一行'));
    return Promise.resolve();
}

/** 云端说这一行和它的版本冲突了，`theirs` 是云端当前那一行 */
function resolveConflictWithCloud(handle, cloud, entity, id, theirs, summary, marker, context) {
    var mine = rows.get(handle, entity, id);

    // 本机删了、云端改了：取消删除，用云端的行重新建出来（设计稿 5.3）
    if (!mine) {
        if (theirs) {
            apply.applyRemote(handle, [{ entity: entity, id: id, row: theirs }]);
            summary.warnings.push('你删掉的这个' + rows.label(entity) + '云端已经改过，按云端的样子恢复了');
        }
        apply.clearChanges(handle, entity, id, marker);
        return Promise.resolve();
    }

    // 云端删了、本机改了：云端会直接重建并把 recreated 标出来（走 ok 分支）。
    // 真走到这里说明拿不到云端的行，那就当没冲突，把本机的版本再推一次
    if (!theirs) return Promise.resolve();

    var outcome = merge.resolveRow(handle, entity, id, theirs);

    if (outcome.action === 'conflict') {
        merge.writeConflict(handle, entity, id, outcome.fields, outcome.baseline, outcome.mine, outcome.theirs);
        summary.conflicts++;
        summary.warnings.push('「' + nameOf(handle, entity, id) + '」和云端改到了同一处，等你选一下');
        return Promise.resolve();
    }

    merge.applyMerged(handle, entity, id, outcome.row, outcome.theirs);
    apply.clearChanges(handle, entity, id, marker);
    summary.merged++;
    summary.warnings.push('「' + nameOf(handle, entity, id) + '」两边改的字段不一样，已经自动合并，马上推上去');
    return Promise.resolve();
}

/** 只读成员：云端不收，用云端的版本覆盖本机，提示一句 */
function overwriteFromCloud(handle, cloud, entity, id, summary, marker, context) {
    var projectId = projectIdFor(handle, entity, id);

    return fetchCloudRow(cloud, entity, id, projectId, context).then(function (cloudRow) {
        if (cloudRow) apply.applyRemote(handle, [{ entity: entity, id: id, row: cloudRow }]);
        else apply.applyRemote(handle, [{ entity: entity, id: id, row: null }]);

        apply.clearChanges(handle, entity, id, marker);
        summary.forbidden++;

        var project = projectId ? projectsRepo.getById(handle, projectId) : null;
        summary.warnings.push('你在项目「' + (project ? project.name : projectId) +
            '」里是只读成员，修改没有保存到云端');
    });
}

/** 这一行属于哪个项目：先看本机现在有没有它，再看基线里记的 */
function projectIdFor(handle, entity, id) {
    var row = rows.get(handle, entity, id);
    if (row) {
        var fromRow = rows.projectIdOf(handle, entity, row);
        if (fromRow) return fromRow;
    }

    var baseline = apply.getBaseline(handle, entity, id);
    if (baseline) {
        var fromBaseline = rows.projectIdOf(handle, entity, baseline);
        if (fromBaseline) return fromBaseline;
    }

    return null;
}

/* ------------------------------------------------------------------ 冲突处理（Task 5 的接口用） */

/**
 * 用户在界面上选了之后落地。
 *
 * - `mine`：基线换成云端的版本（`baseRev` 就是云端现在的 rev），这一行留在待同步里，
 *   下一轮按「本机改过」推上去；
 * - `theirs`：用云端的覆盖本机；
 * - `copy`：只对接口有效 —— 我的版本另存成「原名（我的副本）」（新 id，目录和位置不变），
 *   原行用云端的版本。
 *
 * @returns {{ok: boolean, error?: string, copyId?: string}}
 */
function resolve(handle, entity, id, choice, cloudRow) {
    var conflict = merge.readConflict(handle, entity, id);
    if (!conflict) return { ok: false, error: '这条冲突已经处理过了' };

    var theirs = cloudRow || conflict.remote || null;
    var mine = rows.get(handle, entity, id);

    if (choice === 'theirs') {
        if (theirs) apply.applyRemote(handle, [{ entity: entity, id: id, row: theirs }]);
        else apply.applyRemote(handle, [{ entity: entity, id: id, row: null }]);
        merge.removeConflict(handle, entity, id);
        // 本机已经和云端一样了，这一行的改动**处理完了**：整条流水删掉（N2）。
        // 留一条的话下一轮会把云端那一行原样推回去，白涨一次 rev，别的设备还要再拉一次。
        apply.clearChanges(handle, entity, id, null);
        return { ok: true };
    }

    if (choice === 'copy') {
        if (entity !== 'api') return { ok: false, error: '只有接口能另存为副本' };
        if (!mine) return { ok: false, error: '本机已经没有这一行了' };

        var projectId = rows.projectIdOf(handle, entity, mine);
        var copyId = null;

        handle.transaction(function () {
            var copy = apisRepo.insert(handle, projectId, {
                name: (mine.name || '接口') + '（我的副本）',
                description: mine.description,
                folderId: mine.folder_id,
                position: mine.position,
                method: mine.method,
                url: mine.url,
                params: JSON.parse(mine.params || '{}'),
                body: JSON.parse(mine.body || '{}'),
                auth: mine.auth ? JSON.parse(mine.auth) : null,
                scripts: JSON.parse(mine.scripts || '[]'),
                // 副本**不开 mock**（N3）：mock 路径和原接口一样，两个都开着的话
                // 同一个地址上会有两条规则，实际返回哪一条要看注册顺序，非常难查
                mockEnabled: false,
                mockPath: mine.mock_path,
                mockDelay: mine.mock_delay,
                mockCors: !!mine.mock_cors,
                mockExampleId: mine.mock_example_id,
                extra: JSON.parse(mine.extra || '{}')
            });
            copyId = copy.id;
        }, { projectId: projectId });

        // 原行用云端的版本（这就是「用云端的」那一半）
        if (theirs) apply.applyRemote(handle, [{ entity: entity, id: id, row: theirs }]);
        else apply.applyRemote(handle, [{ entity: entity, id: id, row: null }]);

        merge.removeConflict(handle, entity, id);
        // 原行的改动已经处理完了（N2）；副本是新行，它自己会被推上去
        apply.clearChanges(handle, entity, id, null);
        return { ok: true, copyId: copyId };
    }

    // 默认按「用我的」：基线换成云端的，本机这一行不动，下一轮推上去
    if (theirs) apply.setBaseline(handle, entity, id, theirs);
    else apply.dropBaseline(handle, entity, id);
    merge.removeConflict(handle, entity, id);
    return { ok: true };
}

/* ------------------------------------------------------------------ 小工具 */

/** 本机这一行的 rev 改成云端给的新值。**只写 rev**，不触发 v7 的更新触发器 */
function setLocalRev(handle, entity, id, rev) {
    if (rev === undefined || rev === null) return;
    handle.db.prepare('UPDATE ' + rows.table(entity) + ' SET rev = ? WHERE id = ?')
        .run(Number(rev), String(id));
}

function nameOf(handle, entity, id) {
    var row = rows.get(handle, entity, id);
    if (row && row.name) return row.name;
    return rows.label(entity) + ' ' + id;
}

/** 从云端的 snapshot 里取某一行的当前样子（只读成员覆盖本机时要用） */
function fetchCloudRow(cloud, entity, id, projectId, context) {
    if (!projectId) return Promise.resolve(null);
    if (context.snapshotCache[projectId]) return context.snapshotCache[projectId];

    context.snapshotCache[projectId] = cloud
        .get('/sync/projects/' + encodeURIComponent(projectId) + '/snapshot')
        .then(function (snapshot) {
            var found = (snapshot.rows || {})[entity] || [];
            for (var i = 0; i < found.length; i++) {
                if (String(found[i].id) === String(id)) return found[i];
            }
            return null;
        });

    return context.snapshotCache[projectId];
}

module.exports = {
    runPush: runPush,
    resolve: resolve,
    buildItems: buildItems,
    PUSH_MAX_ITEMS: PUSH_MAX_ITEMS
};
