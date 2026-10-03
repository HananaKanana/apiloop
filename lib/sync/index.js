/**
 * 同步接口（L2）。
 *
 * 只在「云端」的管理台上挂载（`createAdmin` 的 `sync` 选项），网关里的本机管理台**不挂**：
 * 本机是同步的一端，不是另一端。挂载点在 `lib/admin.js` 的 `requireLogin` 之后，
 * 所以这里自己不做登录校验，但要自己判项目权限（每条都能落在某个项目上）。
 *
 * 四个接口：
 *
 *   GET  /sync/state                    序、以及「我是谁、我看得到哪些项目」
 *   GET  /sync/projects/:pid/snapshot   一个项目的全量行
 *   GET  /sync/changes?since=&limit=    增量拉取
 *   POST /sync/push                     把本机改过的行推上来
 *
 * 行的格式见 lib/sync/rows.js。
 */

var express = require('express');

var respond = require('../api/respond');
var guardModule = require('../api/guard');
var secretsApi = require('../api/secrets');
var prefsApi = require('../api/prefs');
var access = require('../access');
var rows = require('./rows');
var purge = require('./purge');
var membersRepo = require('../db/repos/members');
var usersRepo = require('../db/repos/users');

/** 一次推送最多多少条。太多的话一个请求里的写入会拖很久，而且失败面太大 */
var PUSH_MAX_ITEMS = 200;

var CHANGES_DEFAULT_LIMIT = 500;
var CHANGES_MAX_LIMIT = 1000;

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();
    var g = guardModule.createGuard(ctx);

    /* ---------------------------------------------------------- state */

    /**
     * 同步的起点：本机第一次连上来要先知道「云端现在到哪一条了」和「我能同步哪些项目」。
     *
     * `projects[].role` 用的是 access.roleOf 的原值 —— 管理员会拿到 `'admin'`（它不在成员
     * 表里，但对所有项目都有 owner 的能力）。调用方按 rank 比，不要枚举三个角色名。
     */
    router.get('/sync/state', respond.wrap(function (req, res) {
        var visible = access.visibleProjects(handle, req.user);

        var members = [];
        var seenUsers = {};
        visible.forEach(function (project) {
            membersRepo.list(handle, project.id).forEach(function (member) {
                members.push({ projectId: member.projectId, userId: member.userId, role: member.role });
                seenUsers[member.userId] = true;
            });
        });
        // 自己一定在名单里 —— 管理员可能不是任何一个项目的成员
        if (req.user) seenUsers[req.user.id] = true;

        var users = Object.keys(seenUsers).map(function (id) {
            return usersRepo.getById(handle, id);
        }).filter(Boolean).map(function (user) {
            return {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                role: user.role,
                disabled: user.disabled
            };
        }).sort(function (a, b) {
            return a.username < b.username ? -1 : (a.username > b.username ? 1 : 0);
        });

        respond.ok(res, {
            seq: purge.latestSeq(handle),
            minSeq: purge.readMinSeq(handle),
            projects: visible.map(function (project) {
                return { id: project.id, role: access.roleOf(handle, req.user, project.id) };
            }),
            members: members,
            users: users
        });
    }));

    /* ---------------------------------------------------------- snapshot */

    /**
     * 一个项目的全量行。`seq` 和所有行**在同一个事务里**读 —— 分开读的话，夹在中间的那次
     * 写入会既不在快照里、也不在「seq 之后的变更」里，同步方永远看不到它。
     */
    router.get('/sync/projects/:pid/snapshot', g.guard('viewer', g.byPid), respond.wrap(function (req, res) {
        var projectId = req.project.id;

        var snapshot = handle.transaction(function () {
            var payload = { seq: purge.latestSeq(handle), rows: {} };
            rows.ORDER.forEach(function (entity) {
                payload.rows[entity] = rows.list(handle, entity, projectId);
            });
            return payload;
        });

        respond.ok(res, snapshot);
    }));

    /* ---------------------------------------------------------- changes */

    router.get('/sync/changes', respond.wrap(function (req, res) {
        var query = req.query || {};

        var since = Number(query.since);
        if (!Number.isFinite(since) || since < 0) since = 0;

        var limit = Number(query.limit);
        if (!Number.isFinite(limit) || limit < 1) limit = CHANGES_DEFAULT_LIMIT;
        limit = Math.min(Math.floor(limit), CHANGES_MAX_LIMIT);

        var minSeq = purge.readMinSeq(handle);
        // 早于「还在的最小 seq」的同步方已经追不上了（中间那些记录被清理掉了），
        // 只能重新下载一份快照。`minSeq - 1` 是刚好还能接上的那个位置。
        if (since < minSeq - 1) {
            return respond.fail(res, 410, '太久没有同步，需要重新下载', 'SYNC_RESET');
        }

        var visibleIds = access.visibleProjects(handle, req.user).map(function (project) {
            return project.id;
        });
        if (!visibleIds.length) {
            return respond.ok(res, { items: [], nextSeq: since, hasMore: false });
        }

        // 可见项目直接写在 SQL 的 IN 里，而不是查出来再过滤：先 LIMIT 再过滤会让
        // 「这一页全是别人的记录」变成一个空页 + hasMore，同步方会原地打转。
        var sql = 'SELECT * FROM changes WHERE seq > ? AND project_id IN (' +
            visibleIds.map(function () { return '?'; }).join(', ') + ') ORDER BY seq LIMIT ?';
        var statement = handle.db.prepare(sql);
        var found = statement.all.apply(statement, [since].concat(visibleIds).concat([limit + 1]));

        var page = found.slice(0, limit);
        var items = page.map(function (change) {
            return {
                seq: change.seq,
                entity: change.entity,
                id: change.entity_id,
                projectId: change.project_id,
                rev: change.rev,
                deleted: !!change.deleted,
                // 这一行**现在**的样子。已经被删掉的就是 null —— 与 deleted 不矛盾：
                // 「删掉的记录」的 row 是 null，而「改过的记录」的 row 一定在
                row: rows.has(change.entity) ? rows.get(handle, change.entity, change.entity_id) : null
            };
        });

        respond.ok(res, {
            items: items,
            nextSeq: items.length ? items[items.length - 1].seq : since,
            hasMore: found.length > limit
        });
    }));

    /* ---------------------------------------------------------- push */

    router.post('/sync/push', respond.wrap(function (req, res) {
        var items = (req.body || {}).items;
        if (!Array.isArray(items)) throw respond.apiError(400, 'items 必须是数组');
        if (items.length > PUSH_MAX_ITEMS) {
            throw respond.apiError(400, '一次最多推送 ' + PUSH_MAX_ITEMS + ' 条，收到 ' + items.length + ' 条');
        }

        // 按顺序、一条一个事务。某一条失败不牵连其余的 —— 同步是断点续传的，
        // 一条坏数据不该让整批都推不上去。
        var results = items.map(function (item) {
            try {
                return pushOne(handle, req, item);
            } catch (err) {
                return {
                    entity: item && item.entity ? String(item.entity) : null,
                    id: item && item.id ? String(item.id) : null,
                    status: 'invalid',
                    error: (err && err.message) || '处理失败'
                };
            }
        });

        respond.ok(res, { results: results });
    }));

    /**
     * 保密值的同步（第三轮第 7 节）。**挂在同一个 router 上**是有意的：它和上面那四条一样
     * 只在云端用（`createAdmin` 的 `sync: true` 才挂这个 router），而且页面不调它、只有
     * 客户端（网关）的同步引擎调 —— 所以不用进 `account.cloudOnlyPath`，也省得去动
     * 两个会话共用的 `lib/admin.js`。
     */
    router.use(secretsApi.createRouter(ctx));

    /**
     * 个人偏好的同步（第七轮第 2 节）：和保密值同一个道理，也是「客户端才调、只在云端用」，
     * 所以同样挂在这里。**页面调的那两个（`/me/prefs`）不在这儿**，它们在 `lib/admin.js` ——
     * 网关上要落到本机库，不能走这个 router。
     */
    router.use(prefsApi.createSyncRouter(ctx));

    return router;
}

/* ------------------------------------------------------------ push 的单条 */

function pushOne(handle, req, item) {
    if (!item || typeof item !== 'object') {
        return { entity: null, id: null, status: 'invalid', error: '每条必须是一个对象' };
    }

    var entity = item.entity === undefined || item.entity === null ? '' : String(item.entity);
    var id = item.id === undefined || item.id === null ? '' : String(item.id);
    var base = { entity: entity, id: id };

    if (!rows.has(entity)) {
        base.status = 'invalid';
        base.error = '未知的实体类型：' + (entity || '空');
        return base;
    }

    if (!id) {
        base.status = 'invalid';
        base.error = '缺少 id';
        return base;
    }

    var deleted = item.deleted === true;
    var row = (!deleted && item.row && typeof item.row === 'object' && !Array.isArray(item.row))
        ? item.row : null;
    if (!deleted && !row) {
        base.status = 'invalid';
        base.error = '缺少 row';
        return base;
    }

    var baseRev = Number(item.baseRev);
    if (!Number.isFinite(baseRev) || baseRev < 0) baseRev = 0;

    var cur = rows.get(handle, entity, id);

    // 已经删掉了：重复推送删除是正常的（本机重试），直接当成功
    if (deleted && !cur) {
        base.status = 'ok';
        return base;
    }

    // ---- 这一条到底属于哪个项目 ----
    // 新建时以推上来的为准，更新时以库里现有的为准；两者不一致说明在往别人的项目里塞行
    var pushedPid = row ? rows.projectIdOf(handle, entity, row) : null;
    var curPid = cur ? rows.projectIdOf(handle, entity, cur) : null;
    var targetPid = cur ? curPid : pushedPid;

    if (cur && curPid && pushedPid && pushedPid !== curPid) {
        base.status = 'forbidden';
        base.error = '这个' + rows.label(entity) + '不属于它声称的项目';
        return base;
    }
    if (!targetPid) {
        // 示例、期望自己不存项目 id，projectIdOf 要经过 api_id 绕一次；接口不存在时
        // 只能拿到 null。这时把具体的父级问题说出来，比一句「找不到项目」有用得多。
        var orphan = (entity === 'example' || entity === 'expectation')
            ? parentProblem(handle, entity, row, null)
            : null;
        base.status = 'invalid';
        base.error = orphan || '找不到它属于哪个项目';
        return base;
    }

    // ---- 权限 ----
    // 新建项目：登录就行（谁建谁当 owner）；改项目名、删项目：owner；其余：editor
    var role = access.roleOf(handle, req.user, targetPid);
    var needOwner = false;
    if (entity === 'project' && cur) {
        needOwner = deleted ||
            (row && row.name !== undefined && String(row.name) !== String(cur.name));
    }

    if (needOwner) {
        if (!access.atLeast(role, 'owner')) {
            base.status = 'forbidden';
            base.error = '需要 owner 权限';
            return base;
        }
    } else if (cur || entity !== 'project') {
        if (!access.atLeast(role, 'editor')) {
            base.status = 'forbidden';
            base.error = '需要 editor 权限';
            return base;
        }
    }

    // 项目自己新建/删除会影响 slug 映射（和管理台那边一样传 null 才刷新 mock 缓存）
    var changeTarget = entity === 'project' ? ((cur && !deleted) ? targetPid : null) : targetPid;

    function write(fn) {
        return handle.transaction(fn, { projectId: changeTarget });
    }

    // ---- 删除 ----
    if (deleted) {
        if (cur.rev !== baseRev) {
            base.status = 'conflict';
            base.row = cur;
            return base;
        }
        write(function () { rows.remove(handle, entity, id); });
        base.status = 'ok';
        return base;
    }

    // ---- 新建（baseRev 为 0；或云端删了、本机改过 —— 用推上来的行重新建出来）----
    if (!cur) {
        var problem = parentProblem(handle, entity, row, targetPid);
        if (problem) {
            base.status = 'invalid';
            base.error = problem;
            return base;
        }

        var created = write(function () {
            var result = rows.insert(handle, entity, row, { actorId: req.user ? req.user.id : null });
            if (entity === 'project') access.addOwner(handle, result.id, req.user ? req.user.id : null);
            return result;
        });

        base.status = 'ok';
        base.rev = created.rev;
        if (baseRev > 0) base.recreated = true;
        return base;
    }

    // ---- 库里已经有这一行 ----

    // baseRev 为 0：上传重试。可同步的列全都一样就说明上次其实成功了，当成功返回
    if (baseRev === 0) {
        if (sameWritable(entity, cur, row)) {
            base.status = 'ok';
            base.rev = cur.rev;
            return base;
        }
        base.status = 'conflict';
        base.row = cur;
        return base;
    }

    if (cur.rev !== baseRev) {
        base.status = 'conflict';
        base.row = cur;
        return base;
    }

    var conflict = parentProblem(handle, entity, row, targetPid);
    if (conflict) {
        base.status = 'invalid';
        base.error = conflict;
        return base;
    }

    var updated = write(function () { return rows.update(handle, entity, id, row); });
    base.status = 'ok';
    base.rev = updated ? updated.rev : cur.rev;
    return base;
}

/**
 * 父级校验。返回一句给人看的错误，或 null。
 *
 * 只校验推上来的行里**给了**的那个父级：行里没带这一列就不动它，库里原来是什么就还是什么。
 */
function parentProblem(handle, entity, row, projectId) {
    if (entity === 'folder' && row.parent_id) {
        var parent = handle.db.prepare('SELECT project_id FROM folders WHERE id = ?').get(String(row.parent_id));
        if (!parent) return '父目录不存在：' + row.parent_id;
        if (parent.project_id !== projectId) return '父目录不属于这个项目';
    }

    if (entity === 'api' && row.folder_id) {
        var folder = handle.db.prepare('SELECT project_id FROM folders WHERE id = ?').get(String(row.folder_id));
        if (!folder) return '目录不存在：' + row.folder_id;
        if (folder.project_id !== projectId) return '目录不属于这个项目';
    }

    if (entity === 'example' || entity === 'expectation') {
        var api = row.api_id
            ? handle.db.prepare('SELECT project_id FROM apis WHERE id = ?').get(String(row.api_id))
            : null;
        if (!api) return '接口不存在：' + (row.api_id === undefined ? '空' : row.api_id);

        if (entity === 'expectation' && row.example_id) {
            var example = handle.db.prepare('SELECT api_id FROM examples WHERE id = ?')
                .get(String(row.example_id));
            if (!example) return '示例不存在：' + row.example_id;
            if (String(example.api_id) !== String(row.api_id)) return '这个示例不属于该接口';
        }
    }

    return null;
}

/** 推上来的行里给了的列，是不是和库里的一模一样（用于识别「上传重试」） */
function sameWritable(entity, cur, row) {
    return rows.columns(entity).every(function (col) {
        if (row[col] === undefined) return true;
        return sameValue(cur[col], row[col]);
    });
}

function sameValue(left, right) {
    if (left === null || left === undefined) return right === null || right === undefined;
    if (right === null || right === undefined) return false;
    return String(left) === String(right);
}

module.exports = {
    createRouter: createRouter,
    PUSH_MAX_ITEMS: PUSH_MAX_ITEMS
};
