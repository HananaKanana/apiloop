/**
 * 拉取（L3 Task 2，设计稿 5.2 的第 1、2 步）。
 *
 * 第 1 步 `sync/state`：
 *   - 把 `users`、`project_members` 改成和云端一致；
 *   - 云端有、本机没有的项目：下载 snapshot 全部应用，记下基线；
 *   - 本机有基线、云端不再列出的项目（被删了，或者自己被移出了成员）：从本机删掉，
 *     里面有没同步的改动就提示一句。
 *
 * 第 2 步 `sync/changes`，一直拉到 `hasMore = false`：
 *   - 本机没改过的行直接应用、更新基线；
 *   - **本机也改过的行这一轮先跳过**（记数、放进 warnings），留给 Task 3 的三方合并。
 *     跳过的行在本机仍然是「待同步」，推送时会带着旧基线上去，云端会回 conflict。
 *
 * 游标是 `meta.sync_seq`：拉到云端的哪一条了。
 */

var rows = require('../../sync/rows');
var projectsRepo = require('../../db/repos/projects');
var usersRepo = require('../../db/repos/users');
var membersRepo = require('../../db/repos/members');

var apply = require('./apply');

var ORDER = rows.ORDER;

/** 一次拉多少条变更。太大一个请求里要写很多行，太小又要来回很多趟 */
var CHANGES_LIMIT = 500;

/** 防呆：万一下游一直回 hasMore，别把这一轮跑成死循环 */
var MAX_ROUNDS = 500;

var LOCAL_USER_ID = 'u_local';

/**
 * @param {{handle: object, cloud: {get: Function, post: Function}, userId?: string,
 *          isCurrent?: Function}} options
 *   `isCurrent` 用来判断「这一轮开始时那个空间现在还是当前空间吗」—— 登录切空间是
 *   同步动作，而一轮同步是异步的，中途切走的话手里这个 handle 已经被关掉了。
 * @returns {Promise<{applied: number, deleted: number, removedProjects: Array,
 *                    warnings: string[], skippedLocalEdits: number}>}
 */
function runPull(options) {
    var handle = options.handle;
    var cloud = options.cloud;
    var userId = options.userId || null;
    var isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : function () { return true; };

    /**
     * 每一步真正碰库之前问一次。**必须在同步代码块的开头问** —— 切换空间只可能发生在
     * `await` 期间，所以「问完就一口气做完」是安全的。
     */
    function ensureCurrent() {
        if (isCurrent()) return;
        var err = new Error('空间已经切换，这一轮作废');
        err.stale = true;
        throw err;
    }

    var summary = {
        applied: 0,
        deleted: 0,
        removedProjects: [],
        warnings: [],
        skippedLocalEdits: 0
    };

    return cloud.get('/sync/state').then(function (state) {
        ensureCurrent();
        var plan = syncState(handle, state, userId, summary);

        // 顺序按设计稿：先 state（含 snapshot），再拉变更。
        // 成员表**必须等 snapshot 落完再镜像**：`project_members.project_id` 指着
        // `projects(id)`，云端刚建的项目的行还没进本机时插成员会直接违反外键。
        return snapshots(handle, cloud, plan.missing, summary, ensureCurrent, state).then(function () {
            ensureCurrent();
            handle.transaction(function () {
                mirrorMembers(handle, state.members, state.projects);
            }, { projectId: null });

            return changes(handle, cloud, summary, ensureCurrent);
        });
    }).then(function () {
        if (summary.skippedLocalEdits > 0) {
            summary.warnings.push('有 ' + summary.skippedLocalEdits + ' 行本机也改过，这一轮先不动，等推送时合并');
        }
        return summary;
    });
}

/* ------------------------------------------------------------------ 1. state */

/**
 * 第 1 步里「不依赖新项目」的部分：镜像用户、把云端不再列出的项目从本机删掉、
 * 算出哪些项目要去下载 snapshot。
 *
 * 成员表不在这里 —— 见 runPull 里的说明（新项目的行还没落下来，插成员会违反外键）。
 *
 * @returns {{missing: Array}} 云端有、本机没有的项目
 */
function syncState(handle, state, userId, summary) {
    var users = state.users || [];
    var projects = state.projects || [];

    handle.transaction(function () {
        mirrorUsers(handle, users, userId);
    }, { projectId: null });

    var visible = {};
    projects.forEach(function (project) { visible[project.id] = true; });

    /* 云端不再列出的项目：本机删掉 */
    apply.baselineIds(handle, 'project').forEach(function (projectId) {
        if (visible[projectId]) return;

        var project = projectsRepo.getById(handle, projectId);
        var name = project ? project.name : projectId;
        var unsynced = pendingInProject(handle, projectId);

        // 先把这一行行的基线记下来再删 —— 删完之后就查不到它们属于哪个项目了
        var entityIds = {};
        ORDER.forEach(function (entity) {
            entityIds[entity] = entity === 'project'
                ? [projectId]
                : rows.list(handle, entity, projectId).map(function (row) { return row.id; });
        });

        handle.transaction(function () {
            // 项目行删掉，目录、接口、示例、期望顺着外键级联一起走
            projectsRepo.remove(handle, projectId);
        }, { projectId: null });

        ORDER.forEach(function (entity) {
            entityIds[entity].forEach(function (id) { apply.dropBaseline(handle, entity, id); });
        });

        summary.removedProjects.push({ id: projectId, name: name, unsynced: unsynced });
        summary.warnings.push(unsynced > 0
            ? '项目「' + name + '」已不能访问，' + unsynced + ' 项本机修改没能同步'
            : '项目「' + name + '」已不能访问，已从本机删除');
    });

    return {
        missing: projects.filter(function (project) {
            return !projectsRepo.getById(handle, project.id);
        })
    };
}

/**
 * 用户表镜像成云端的样子。
 *
 * 镜像来的用户**没有密码**（空串）—— 本机身份由网关自己发会话，不走账号密码那条路。
 * 云端不再列出来的用户本机也删掉（`sessions`/`project_members` 是级联，`history.user_id`
 * 是 SET NULL，所以删得掉），**只有两个例外**：当前登录的这个（他可能不属于任何可见项目），
 * 以及本机用户 `u_local`。
 */
function mirrorUsers(handle, users, userId) {
    var seen = {};

    users.forEach(function (user) {
        if (!user || !user.id) return;
        seen[user.id] = true;

        var existing = usersRepo.getById(handle, user.id);
        if (!existing) {
            var username = String(user.username || user.id);
            // 用户名在库里是 UNIQUE，撞上了就加个后缀（云端账号叫 local 会和本机用户撞）
            var taken = usersRepo.getByUsername(handle, username);
            if (taken && taken.id !== user.id) username = username + '~' + String(user.id).slice(-6);

            usersRepo.create(handle, {
                id: user.id,
                username: username,
                display_name: user.displayName || '',
                role: user.role === 'admin' ? 'admin' : 'member',
                password_hash: '',
                must_change_password: 0
            });
            return;
        }

        usersRepo.update(handle, user.id, {
            displayName: user.displayName || '',
            role: user.role === 'admin' ? 'admin' : 'member',
            disabled: !!user.disabled
        });
    });

    usersRepo.list(handle).forEach(function (local) {
        if (seen[local.id]) return;
        if (local.id === userId || local.id === LOCAL_USER_ID) return;
        usersRepo.remove(handle, local.id);
    });
}

/**
 * 成员表向云端看齐。
 *
 * **只替换 state 里列出来的那些项目的成员**，不是清空整表：本机刚建、还没推上去的项目
 * 不在 state 里，整表替换会把当前用户在自己项目里的 owner 一起抹掉，之后就再也打不开它了。
 */
function mirrorMembers(handle, members, projects) {
    var byProject = {};
    (projects || []).forEach(function (project) { byProject[project.id] = []; });
    (members || []).forEach(function (member) {
        if (!member || !member.projectId) return;
        if (!byProject[member.projectId]) return;
        byProject[member.projectId].push(member);
    });

    Object.keys(byProject).forEach(function (projectId) {
        var keep = {};
        byProject[projectId].forEach(function (member) {
            keep[member.userId] = true;
            // 角色不认识就当 viewer —— 宁可少给权限，也不要让一个陌生字符串进 CHECK 约束
            var role = membersRepo.ROLES.indexOf(member.role) > -1 ? member.role : 'viewer';
            membersRepo.upsert(handle, projectId, member.userId, role);
        });

        membersRepo.list(handle, projectId).forEach(function (local) {
            if (keep[local.userId]) return;
            membersRepo.remove(handle, projectId, local.userId);
        });
    });
}

/* ------------------------------------------------------------------ 2. snapshot */

/** 逐个下载（不并发）：一次 round 里同时打好几个云端请求没必要，还要处理乱序 */
function snapshots(handle, cloud, missing, summary, ensureCurrent) {
    var list = missing || [];
    var index = 0;

    function next() {
        if (index >= list.length) return Promise.resolve();

        var project = list[index];
        index++;

        return cloud.get('/sync/projects/' + encodeURIComponent(project.id) + '/snapshot')
            .then(function (snapshot) {
                ensureCurrent();

                var items = [];
                ORDER.forEach(function (entity) {
                    var found = (snapshot.rows || {})[entity] || [];
                    found.forEach(function (row) {
                        items.push({ entity: entity, id: row.id, row: row });
                    });
                });

                var out = apply.applyRemote(handle, items);
                summary.applied += out.applied;
                return next();
            });
    }

    return next();
}

/* ------------------------------------------------------------------ 3. changes */

function changes(handle, cloud, summary, ensureCurrent) {
    var since = apply.readCursor(handle);
    var round = 0;

    function one() {
        round++;
        if (round > MAX_ROUNDS) {
            summary.warnings.push('云端一直说还有更多变更，这一轮先停在第 ' + since + ' 条');
            return Promise.resolve();
        }

        return cloud.get('/sync/changes?since=' + since + '&limit=' + CHANGES_LIMIT)
            .then(function (page) {
                ensureCurrent();

                var items = page.items || [];

                // 每一轮重新算一次：刚写进去的行已经有基线了，不再算待同步
                var pending = apply.pendingKeys(handle);
                var use = [];

                items.forEach(function (item) {
                    if (!item || !rows.has(item.entity)) return;
                    if (pending.has(item.entity + ':' + String(item.id))) {
                        summary.skippedLocalEdits++;
                        return;
                    }
                    use.push({
                        entity: item.entity,
                        id: item.id,
                        row: item.deleted === true ? null : item.row
                    });
                });

                if (use.length) {
                    // **按云端给的顺序依次应用**：那是「先更新子目录、再删父目录」这样的
                    // 日志顺序，重排会让本机的外键级联删掉云端还留着的行
                    var out = apply.applyRemote(handle, use, { ordered: true });
                    summary.applied += out.applied;
                    summary.deleted += out.deleted;
                }

                since = page.nextSeq === undefined ? since : page.nextSeq;
                apply.writeCursor(handle, since);

                if (page.hasMore) return one();
            });
    }

    return one();
}

/* ------------------------------------------------------------------ 辅助 */

/** 这个项目里有多少行还没同步上去（删项目时用来提示） */
function pendingInProject(handle, projectId) {
    var pending = apply.pendingKeys(handle);
    var counted = {};
    var total = 0;

    pending.forEach(function (key) {
        var index = key.indexOf(':');
        var entity = key.slice(0, index);
        var id = key.slice(index + 1);
        var row = rows.get(handle, entity, id);
        if (!row) return;      // 已经不在本机了，下面按 changes 的记录补数
        if (rows.projectIdOf(handle, entity, row) !== projectId) return;
        counted[key] = true;
        total++;
    });

    handle.db.prepare('SELECT DISTINCT entity, entity_id FROM changes WHERE project_id = ?')
        .all(projectId).forEach(function (change) {
            var key = change.entity + ':' + change.entity_id;
            if (counted[key]) return;
            if (rows.get(handle, change.entity, change.entity_id)) return;
            counted[key] = true;
            total++;
        });

    return total;
}

module.exports = {
    runPull: runPull,
    CHANGES_LIMIT: CHANGES_LIMIT
};
