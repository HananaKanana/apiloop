/**
 * 把云端的行落到本机（L3 Task 2，设计稿 5.2）。
 *
 * 三件事：
 *
 *   1. **建同步用的两张表**（`sync_base`、`sync_conflicts`）。这两张表只有网关这边有，
 *      不在迁移里 —— 云端不需要它们，而迁移是两边共用的。
 *   2. **应用云端的行**（`applyRemote`）。两条硬规矩写在代码里：
 *      **不能用 `INSERT OR REPLACE`**（它会先删行，外键级联会把子行一起带走）；
 *      **自己写进去的改动不算待同步**（本机触发器照样会记 changes，要在同一个事务里删掉）。
 *   3. **算出「哪些行还没同步上去」**（`pendingKeys`，见下面的 B1 说明）。
 *
 * 行格式和 `lib/sync/rows.js` 一样：列名用下划线写法、JSON 列保持字符串的原始行。
 */

var rows = require('../../sync/rows');
var projectsRepo = require('../../db/repos/projects');
var i18n = require('../../i18n');

var ORDER = rows.ORDER;

/* ------------------------------------------------------------------ 建表 */

var CREATE_STATEMENTS = [
    // 基线上次和云端对齐时这一行是什么样（含云端的 rev）。推送时的 baseRev 就从这儿取，
    // 没有就是 0（本机新建的，云端还没有）。
    'CREATE TABLE IF NOT EXISTS sync_base (' +
    '    entity TEXT NOT NULL,' +
    '    entity_id TEXT NOT NULL,' +
    '    rev INTEGER NOT NULL DEFAULT 0,' +
    "    row_json TEXT NOT NULL DEFAULT '{}'," +
    '    PRIMARY KEY (entity, entity_id)' +
    ')',

    // 合并时两边改得不一样的行。这一行暂停推送，等用户在界面上选（Task 5）。
    'CREATE TABLE IF NOT EXISTS sync_conflicts (' +
    '    entity TEXT NOT NULL,' +
    '    entity_id TEXT NOT NULL,' +
    "    fields_json TEXT NOT NULL DEFAULT '[]'," +
    "    remote_row_json TEXT NOT NULL DEFAULT '{}'," +
    '    created_at INTEGER NOT NULL DEFAULT 0,' +
    '    PRIMARY KEY (entity, entity_id)' +
    ')'
];

/** 打开任何空间都要调一次。`IF NOT EXISTS`，重复调没有代价 */
function ensureTables(handle) {
    handle.transaction(function () {
        CREATE_STATEMENTS.forEach(function (sql) {
            handle.db.exec(sql);
        });
    }, { projectId: null });
}

/* ------------------------------------------------------------------ 表名与列 */

function tableOf(entity) {
    return rows.table(entity);
}

/** 这张表现在有哪些列（`id` 也在里面） */
function columnsOf(handle, table) {
    return handle.db.prepare('PRAGMA table_info(' + table + ')').all()
        .map(function (column) { return column.name; });
}

/* ------------------------------------------------------------------ 基线 */

function setBaseline(handle, entity, id, row) {
    var rev = row && row.rev !== undefined && row.rev !== null ? Number(row.rev) : 0;
    var payload = JSON.stringify(row || {});

    var updated = handle.db.prepare(
        'UPDATE sync_base SET rev = ?, row_json = ? WHERE entity = ? AND entity_id = ?'
    ).run(rev, payload, entity, String(id));

    // 已经有这一行就到此为止 —— **不要用 INSERT OR REPLACE**：这里虽然还没有子表引用它，
    // 但「先删后插」这个习惯一旦带进数据表就会踩到外键级联（见 applyRemote 的注释）
    if (updated && updated.changes > 0) return;

    var inserted = handle.db.prepare(
        'INSERT INTO sync_base (entity, entity_id, rev, row_json) VALUES (?, ?, ?, ?)'
    );
    inserted.run(entity, String(id), rev, payload);
}

function dropBaseline(handle, entity, id) {
    handle.db.prepare('DELETE FROM sync_base WHERE entity = ? AND entity_id = ?')
        .run(entity, String(id));
}

function getBaseline(handle, entity, id) {
    var found = handle.db.prepare('SELECT * FROM sync_base WHERE entity = ? AND entity_id = ?')
        .get(entity, String(id));
    if (!found) return null;

    try {
        return JSON.parse(found.row_json);
    } catch (err) {
        return null;
    }
}

/** 某个实体的全部基线（拉取时用来判断「本机有没有这个项目」） */
function baselineIds(handle, entity) {
    return handle.db.prepare('SELECT entity_id, rev FROM sync_base WHERE entity = ?')
        .all(entity).map(function (row) { return row.entity_id; });
}

/* ------------------------------------------------------------------ 排序 */

/**
 * 应用顺序：**插入、更新父级在前；删除子级在前**。
 *
 * 实体之间直接按 `rows.ORDER` 正序/倒序；目录还要在内部再排一次 ——
 * `folders.parent_id` 指向自己这张表，子目录排在父目录前面会直接违反外键。
 */
function sortItems(handle, items, deleting) {
    var buckets = {};
    ORDER.forEach(function (entity) { buckets[entity] = []; });
    items.forEach(function (item) {
        if (buckets[item.entity]) buckets[item.entity].push(item);
    });

    var order = deleting ? ORDER.slice().reverse() : ORDER;
    var out = [];

    order.forEach(function (entity) {
        if (entity === 'folder') {
            out = out.concat(sortFolders(handle, buckets[entity], deleting));
            return;
        }
        out = out.concat(buckets[entity]);
    });

    return out;
}

/** 目录按「父目录在前」排（删除时反过来）。不在这一批里的父目录当作已经就位 */
function sortFolders(handle, items, deleting) {
    var byId = {};
    items.forEach(function (item) { byId[item.id] = item; });

    var depthCache = {};
    function depth(id, guard) {
        if (depthCache[id] !== undefined) return depthCache[id];
        var item = byId[id];
        if (!item) return 0;
        if (guard[id]) return 0;      // 数据坏了（成环）也不能死循环

        guard[id] = true;
        var parentId = item.row ? item.row.parent_id : null;
        var known = parentId
            ? handle.db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(String(parentId))
            : null;
        var value = 0;
        if (parentId && byId[parentId]) value = depth(parentId, guard) + 1;
        else if (known) value = 1;

        depthCache[id] = value;
        return value;
    }

    return items.slice().sort(function (a, b) {
        var diff = depth(a.id, {}) - depth(b.id, {});
        if (diff !== 0) return deleting ? -diff : diff;
        return String(a.id) < String(b.id) ? -1 : 1;
    });
}

/* ------------------------------------------------------------------ 应用 */

/**
 * 把一个批次的行落到本机。
 *
 * **每一行单独包一个 `SAVEPOINT`**：整批一个事务的话，任何一行出错（外键、唯一约束、
 * 两边的表结构不一样……）都会把整页回滚、游标也不前进，下一轮再撞同一行 ——
 * 拉取就**永远卡在那里**，云端后来做的所有修改都下不来。
 * 单行失败只回滚这一行、记一条 `skipped` 跳过，这一页照常应用完、游标照常往前走。
 * 被跳过的行不会丢：本机这边相关的那一条改动推上去之后，云端会把它一起处理掉。
 *
 * @param {object} handle
 * @param {Array<{entity: string, id: string, row: object|null}>} items row 为 null 表示删除
 * @param {{ordered?: boolean}} [options]
 *   `ordered` 表示**按传进来的顺序依次应用，不再自己排序**。变更流水必须这样：
 *   云端那边是「先更新子目录的 parent_id、再删父目录」这样一个顺序，重排成
 *   「先删父目录」的话，本机的 `ON DELETE CASCADE` 会把还活着的子目录一起干掉。
 *   快照没有这个顺序（它就是一个按实体分组的映射），所以那边照旧排序。
 * @returns {{applied: number, deleted: number, clearedChanges: number,
 *            skipped: Array<{entity: string, id: string, reason: string}>}}
 */
function applyRemote(handle, items, options) {
    var list = (items || []).filter(function (item) {
        return item && item.entity && item.id !== undefined && item.id !== null;
    });
    if (!list.length) return { applied: 0, deleted: 0, clearedChanges: 0, skipped: [] };

    var ordered = !!(options && options.ordered);
    var applied = 0;
    var deleted = 0;
    var skipped = [];

    return handle.transaction(function () {
        // 记下「应用之前本机的最大 seq」。应用过程中本机的触发器会照常写 changes，
        // 这些记录**不是**本机的改动（是云端的样子），最后要一起删掉，
        // 否则同步方会把自己刚拉下来的行又推回云端，两边来回推同一行。
        var marker = handle.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes').get().seq;

        var steps;
        if (ordered) {
            steps = list.map(function (item) { return { item: item, deleting: !item.row }; });
        } else {
            var toDelete = list.filter(function (item) { return !item.row; });
            var toWrite = list.filter(function (item) { return !!item.row; });
            steps = sortItems(handle, toDelete, true).map(function (item) {
                return { item: item, deleting: true };
            }).concat(sortItems(handle, toWrite, false).map(function (item) {
                return { item: item, deleting: false };
            }));
        }

        steps.forEach(function (step, index) {
            var table = tableOf(step.item.entity);
            if (!table) return;

            var name = 'apiloop_row_' + index;
            handle.db.exec('SAVEPOINT ' + name);
            try {
                if (step.deleting) {
                    handle.db.prepare('DELETE FROM ' + table + ' WHERE id = ?').run(String(step.item.id));
                    dropBaseline(handle, step.item.entity, step.item.id);
                    deleted++;
                } else {
                    writeRow(handle, table, step.item.entity, step.item.id, step.item.row);
                    setBaseline(handle, step.item.entity, step.item.id, step.item.row);
                    applied++;
                }
                handle.db.exec('RELEASE ' + name);
            } catch (err) {
                handle.db.exec('ROLLBACK TO ' + name);
                handle.db.exec('RELEASE ' + name);
                skipped.push({
                    entity: step.item.entity,
                    id: String(step.item.id),
                    reason: (err && err.message) || i18n.m('未知错误')
                });
            }
        });

        var removed = handle.db.prepare('DELETE FROM changes WHERE seq > ?').run(Number(marker));
        return { applied: applied, deleted: deleted, clearedChanges: removed.changes, skipped: skipped };
    }, { projectId: null });
}

/**
 * 写一行：**已存在就 UPDATE、不存在才 INSERT**。
 *
 * 列清单从 `PRAGMA table_info` 读，不从 `rows.js` 的可写列读 —— 那边列的是「推送上来
 * 允许写哪些列」，这里是「云端那一行原样落下来」，两者的口径本来就不同。
 *
 * **`rev` 必须单独写第二条语句**：v7 的更新触发器是 `AFTER UPDATE OF <数据列>`，
 * 清单里没有 `rev`；而触发器里那句 `SET rev = OLD.rev + 1` 带一个
 * `AND NEW.rev = OLD.rev` 的守卫。如果把 rev 混在第一条 UPDATE 里、值又刚好和本机
 * 原来的相同，守卫就成立，rev 会被加一 —— 本机就永远比云端多 1，下次推送全是冲突。
 * 单独写一条 `SET rev = ?` 不触发触发器，才能精确对齐。
 */
function writeRow(handle, table, entity, id, row) {
    var columns = columnsOf(handle, table);
    var source = alignRow(handle, entity, id, row, columns);
    var exists = handle.db.prepare('SELECT 1 FROM ' + table + ' WHERE id = ?').get(String(id));

    if (!exists) {
        var names = ['id'];
        var values = [String(id)];
        columns.forEach(function (column) {
            if (column === 'id') return;
            var value = source[column];
            // 远端那一行里**没有**这一列时不要写 null：让表自己的默认值生效。
            // 两边版本不一样时（云端多一列 NOT NULL DEFAULT）才插得进去（B6 那条小问题）
            if (value === undefined) return;
            names.push(column);
            values.push(value);
        });

        // 插入不经过更新触发器，rev 直接就是云端的值
        var insert = handle.db.prepare(
            'INSERT INTO ' + table + ' (' + names.join(', ') + ') ' +
            'VALUES (' + names.map(function () { return '?'; }).join(', ') + ')'
        );
        insert.run.apply(insert, values);
        return;
    }

    var sets = [];
    var updates = [];
    columns.forEach(function (column) {
        if (column === 'id' || column === 'rev') return;
        // 更新时缺列同样是「不动它」：推上来的、拉下来的都只改自己带了的列
        if (source[column] === undefined) return;
        sets.push(column + ' = ?');
        updates.push(source[column]);
    });

    if (sets.length) {
        updates.push(String(id));
        var update = handle.db.prepare('UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE id = ?');
        update.run.apply(update, updates);
    }

    // 上一条可能把 rev 加了 1（守卫成立时），这一条把它写回云端的真实值
    if (row.rev !== undefined && row.rev !== null) {
        handle.db.prepare('UPDATE ' + table + ' SET rev = ? WHERE id = ?')
            .run(Number(row.rev), String(id));
    }
}

/**
 * 把云端那一行收拾成「本机能落下去的样子」。两个本机特有的约束会让拉取**永远卡住**，
 * 因为每一轮都会撞同一行：
 *
 *   - **`slug` 是 UNIQUE**。本机在登录之前自建过一个同名项目时，两边 slug 会撞；
 *     换成 `uniqueSlug`（`demo-2`）即可 —— slug 从 L1 起就不参与 mock 路由了。
 *   - **`created_by` 指向本机没有的用户**。这里只镜像「可见项目的成员」加自己，
 *     项目的创建人后来被移出成员时本机就没有那一行，外键直接报错。找不到就写 null。
 *
 * `slug` 只在**插入**时算一次（N4）：本机已经有这一行就原样保留本机的 slug。
 * 每次更新都重算的话，云端那边只要动一下项目（rev 变了、slug 没变），本机的 slug
 * 就会在 `demo-2` / `demo-3` 之间来回换一次，而它其实从 L1 起就不参与 mock 路由了
 * （mock 地址用的是项目 id），换来换去没有任何好处。
 */
function alignRow(handle, entity, id, row, columns) {
    if (entity !== 'project') return row;

    var next = row;

    if (columns.indexOf('slug') > -1 && row.slug !== undefined && row.slug !== null) {
        var local = handle.db.prepare('SELECT slug FROM projects WHERE id = ?').get(String(id));

        if (local) {
            // 本机已经有这一行：保留本机的 slug（写回同一个值，等于没改）
            next = Object.assign({}, next, { slug: local.slug });
        } else {
            var taken = handle.db.prepare('SELECT id FROM projects WHERE slug = ?').get(String(row.slug));
            if (taken && String(taken.id) !== String(id)) {
                next = Object.assign({}, next, { slug: projectsRepo.uniqueSlug(handle, String(row.slug)) });
            }
        }
    }

    if (columns.indexOf('created_by') > -1 && row.created_by !== undefined && row.created_by !== null) {
        var owner = handle.db.prepare('SELECT 1 FROM users WHERE id = ?').get(String(row.created_by));
        if (!owner) next = Object.assign({}, next, { created_by: null });
    }

    return next;
}

/* ------------------------------------------------------------------ 待同步 */

/**
 * 「本机有、云端还没有（或者不知道有没有）」的那些行，键是 `entity:id`。
 *
 * 两个来源，**缺一不可**：
 *
 *   1. 本机 `changes` 里出现过的 —— v7 之后，本机的每一次改动都会记一条；
 *   2. **6 张同步表里没有 `sync_base` 的行** —— 从没和云端对齐过的行，一律当本机新建。
 *      这一条是 B1：用户在第一期（迁移 v6）里离线建的接口，是在触发器装上去**之前**
 *      写进库的，`changes` 里一条记录都没有。只看 `changes` 的话，这些行永远不会被推
 *      上去，登录之后在云端根本看不到 —— 而这正是「第一次登录时，没登录时建的项目
 *      自动上传」要的效果。
 *
 * @returns {Set<string>} `entity:id`
 */
function pendingKeys(handle) {
    var keys = new Set();

    handle.db.prepare('SELECT DISTINCT entity, entity_id FROM changes').all().forEach(function (change) {
        if (ORDER.indexOf(change.entity) === -1) return;
        keys.add(change.entity + ':' + String(change.entity_id));
    });

    ORDER.forEach(function (entity) {
        var table = tableOf(entity);
        if (!table) return;

        handle.db.prepare(
            'SELECT t.id AS id FROM ' + table + ' t ' +
            'LEFT JOIN sync_base b ON b.entity = ? AND b.entity_id = t.id ' +
            'WHERE b.entity_id IS NULL'
        ).all(entity).forEach(function (row) {
            keys.add(entity + ':' + String(row.id));
        });
    });

    return keys;
}

/** 待同步的行数（状态栏用）。和 `pendingKeys` 同一个口径 */
function pendingCount(handle) {
    return pendingKeys(handle).size;
}

/**
 * 删掉这一行在 `changes` 里的记录。
 *
 * - 给了 `marker`：只删 `seq <= marker` 的。那是**推送之前**读到的最大 seq，
 *   之后本机再改这一行会写下更大的 seq，那些记录要留着（下一轮还要推）。
 * - 不给 `marker`：这一行的改动我们**已经处理掉了**（例如用户选「用云端的」，
 *   本机已经和云端一样），整条流水都该丢掉，否则下一轮会把同一行原样再推一遍、
 *   白涨一次 `rev`（N2）。
 */
function clearChanges(handle, entity, id, marker) {
    if (marker === undefined || marker === null) {
        handle.db.prepare('DELETE FROM changes WHERE entity = ? AND entity_id = ?')
            .run(entity, String(id));
        return;
    }

    handle.db.prepare('DELETE FROM changes WHERE entity = ? AND entity_id = ? AND seq <= ?')
        .run(entity, String(id), Number(marker));
}

/* ------------------------------------------------------------------ 游标 */

function readCursor(handle) {
    var found = handle.db.prepare('SELECT value FROM meta WHERE key = ?').get('sync_seq');
    var value = found ? Number(found.value) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function writeCursor(handle, seq) {
    handle.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('sync_seq', String(seq));
}

/* ------------------------------------------------------------------ 冲突表 */

function conflictCount(handle) {
    return handle.db.prepare('SELECT COUNT(*) AS n FROM sync_conflicts').get().n;
}

module.exports = {
    ensureTables: ensureTables,
    applyRemote: applyRemote,
    sortItems: sortItems,
    pendingKeys: pendingKeys,
    pendingCount: pendingCount,
    clearChanges: clearChanges,
    setBaseline: setBaseline,
    getBaseline: getBaseline,
    dropBaseline: dropBaseline,
    baselineIds: baselineIds,
    readCursor: readCursor,
    writeCursor: writeCursor,
    conflictCount: conflictCount
};
