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
var merge = require('./merge');

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
        skippedRows: [],
        /** 自动合并掉的行数 */
        merged: 0,
        /** 进了冲突表、等用户选的行数 */
        conflicts: 0,
        /** 这一轮是不是「云端流水被清了、全量重下」 */
        resynced: false
    };

    return cloud.get('/sync/state').then(function (state) {
        ensureCurrent();
        var plan = syncState(handle, state, userId, summary);

        /**
         * **第一次同步（本机游标还是 0）时，游标要落在 `state.seq` 上**（B7）。
         *
         * 云端的变更流水会定期清理，清完之后 `minSeq > 1`，而 `changes?since=0` 会
         * 直接回 410 —— 新设备于是「整库重下一次 → 游标又被写回 0 → 下一轮还是 410」，
         * 每 30 秒重下一遍，永远停不下来。云端要跑满 30 天才会出现，本地测不出来。
         *
         * 顺序上是安全的：`state` 先读、快照后读，所以快照至少和 `state.seq` 一样新；
         * 中间这几十毫秒里产生的变更会在下面的 changes 里**再应用一遍**，重复应用无害。
         *
         * **在下载快照之前就写**：快照下到一半断网时，已经落下来的那几个项目的基线
         * 停在这个 seq 上。要是等快照全部落完才写，下一轮会拿一个**更新的** `state.seq`
         * 当游标，那几个项目在两次之间被别人改过的内容就再也拉不下来了。
         */
        if (apply.readCursor(handle) === 0) apply.writeCursor(handle, Number(state.seq) || 0);

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
    }).catch(function (err) {
        // 云端的变更流水被清理掉了（30 天没同步）：全量重下，本机的改动先存后放
        if (err && err.status === 410) {
            ensureCurrent();
            return resetFromScratch({
                handle: handle,
                cloud: cloud,
                summary: summary,
                ensureCurrent: ensureCurrent,
                userId: userId
            });
        }
        throw err;
    }).then(function () {
        ensureCurrent();
        dropUnusedAutoProject(handle, summary);

        if (summary.skippedRows.length) {
            var first = summary.skippedRows[0];
            summary.warnings.push('有 ' + summary.skippedRows.length + ' 行没能应用，已跳过（第一条：' +
                rows.label(first.entity) + ' ' + first.id + '，' + first.reason + '）');
        }
        return summary;
    });
}

/**
 * 未绑定时自动建的那个空项目，登录后如果账号里已经有别的项目，就把它删掉，不传上云端。
 *
 * 用户 2026-10-01：「登录一个号进去就是 2 个项目」—— 管理员账号在云端已经有一个「默认项目」，
 * 本机未登录时又自动建过一个，登录后两个都在。只删**完全没用过**的：
 *   - 名字还是自动建的那个（「默认项目」，老版本叫「我的项目」）；
 *   - 从没和云端同步过（没有基线 —— 云端来的、或者已经推上去的都不动）；
 *   - 里面没有目录、接口、环境，也没有发过请求（没有历史记录）；
 *   - 账号里还有别的项目（新账号一个项目都没有时留着它，推上去当默认项目）。
 */
var AUTO_PROJECT_NAMES = ['默认项目', '我的项目'];

function dropUnusedAutoProject(handle, summary) {
    var all = handle.db.prepare('SELECT id, name FROM projects').all();
    if (all.length < 2) return;

    all.forEach(function (project) {
        if (AUTO_PROJECT_NAMES.indexOf(project.name) === -1) return;
        if (apply.getBaseline(handle, 'project', project.id)) return;

        var used = ['folders', 'apis', 'environments', 'history'].some(function (table) {
            return handle.db.prepare('SELECT 1 FROM ' + table + ' WHERE project_id = ? LIMIT 1').get(project.id);
        });
        if (used) return;

        handle.transaction(function () {
            handle.db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
            // 它从没上过云端，删除也不用推：流水里关于它的记录一起清掉
            handle.db.prepare("DELETE FROM changes WHERE entity = 'project' AND entity_id = ?").run(project.id);
        }, { projectId: null });
        summary.warnings.push('本机自动建的空项目「' + project.name + '」没用过，账号里已经有项目了，已经去掉');
    });
}

/** 把 applyRemote 跳过的行收进 summary（B6：单行失败不拖累整页） */
function collectSkipped(out, summary) {
    (out.skipped || []).forEach(function (item) { summary.skippedRows.push(item); });
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

    removeUnlistedProjects(handle, apply.baselineIds(handle, 'project'), visible, summary);

    return {
        missing: projects.filter(function (project) {
            return !projectsRepo.getById(handle, project.id);
        })
    };
}

/**
 * 把「本机认得、云端这次不再列出」的项目从本机删掉。
 *
 * 两种情况都会走到这里：项目被删了，或者自己被移出了成员。本机有没同步的改动时
 * 提示一句 —— 那些改动已经没有能推上去的地方了。
 *
 * `known` 由调用方给：正常拉取时是 `sync_base` 里的项目，410 全量重下时得用
 * **清基线之前记下来的那一份**（B9）。
 */
function removeUnlistedProjects(handle, known, visible, summary) {
    known.forEach(function (projectId) {
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
                collectSkipped(out, summary);
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
                var mergeLater = [];

                items.forEach(function (item) {
                    if (!item || !rows.has(item.entity)) return;
                    var id = String(item.id);
                    var theirs = item.deleted === true ? null : item.row;

                    // 本机也改过的行：这里**不直接写**，等下走三方合并。
                    // 合并必须在这一轮做完 —— 游标马上就前进了，不会再拉一次
                    if (pending.has(item.entity + ':' + id)) {
                        mergeLater.push({ entity: item.entity, id: id, theirs: theirs });
                        return;
                    }
                    use.push({ entity: item.entity, id: item.id, row: theirs });
                });

                if (use.length) {
                    // **按云端给的顺序依次应用**：那是「先更新子目录、再删父目录」这样的
                    // 日志顺序，重排会让本机的外键级联删掉云端还留着的行
                    var out = apply.applyRemote(handle, use, { ordered: true });
                    summary.applied += out.applied;
                    summary.deleted += out.deleted;
                    collectSkipped(out, summary);
                }

                mergeLater.forEach(function (item) { mergePending(handle, item, summary); });

                since = page.nextSeq === undefined ? since : page.nextSeq;
                apply.writeCursor(handle, since);

                if (page.hasMore) return one();
            });
    }

    return one();
}

/**
 * 拉取时遇到「本机也改过」的行（Task 2 是直接跳过的，这里补上）。
 *
 * 三种结果：
 *   - 合出来了 → 写回本机、基线换成云端的，留在待同步里下一轮推上去；
 *   - 两边改到同一列 → 进 `sync_conflicts`，这一行暂停推送，等用户选；
 *   - 本机删了、云端改了 → 取消删除，用云端的行重新建出来。
 *
 * 云端删了、本机改了这一种**什么都不做**：本机这一行留在待同步里，推送时
 * 云端会用推上来的行重新建出来并回一个 `recreated`，那时候再提示用户。
 */
function mergePending(handle, item, summary) {
    var outcome = merge.resolveRow(handle, item.entity, item.id, item.theirs);

    if (outcome.action === 'restore') {
        var restored = apply.applyRemote(handle, [{ entity: item.entity, id: item.id, row: outcome.theirs }]);
        // 恢复也可能失败（外键、唯一约束……）：**必须收下跳过的行**，
        // 不然这里会静默失败、日志却写着「已经恢复了」
        collectSkipped(restored, summary);
        // 本机这一行已经和云端一样了：那条删除的流水要一起删掉，否则下一轮还会推一次
        apply.clearChanges(handle, item.entity, item.id, null);
        summary.warnings.push('你删掉的这个' + rows.label(item.entity) + '云端已经改过，按云端的样子恢复了');
        return;
    }

    if (outcome.action === 'conflict') {
        merge.writeConflict(handle, item.entity, item.id, outcome.fields,
            outcome.baseline, outcome.mine, outcome.theirs);
        summary.conflicts++;
        return;
    }

    if (outcome.row) {
        merge.applyMerged(handle, item.entity, item.id, outcome.row, outcome.theirs);
        summary.merged++;
        summary.warnings.push('「' + (outcome.row.name || item.id) +
            '」两边改的字段不一样，已经自动合并，下一轮推上去');
    }
}

/* ------------------------------------------------------------------ 410：重新下载 */

/**
 * 云端说「太久没有同步，需要重新下载」（设计稿 5.3 最后一条）。
 *
 * 步骤：把本机还没同步出去的行**先原样记下来** → 按新 state 收拾掉本机已经不该有的项目
 * → 清掉所有基线和流水（当成本机第一次连上来）→ 全量重新下载 → 把记下来的那些行写回本机
 * （不给基线，于是它们仍然是「本机新建」，下一轮以 `baseRev = 0` 推上去）→ 提示用户。
 *
 * 「按新建推上去」是有意的：云端那条流水已经没了，我们手里没有可信的 baseRev，
 * 拿老的 baseRev 去推只会得到一堆 conflict。
 *
 * 三处是这一版补上的（审阅第 10 轮）：
 *   - **游标写 `state.seq`，不写 0**（B7）：写 0 的话下一轮还是 410，每 30 秒整库重下一次；
 *   - **先删掉云端不再列出的项目**（B9）：它们的基线马上要被清掉，不清就变成「本机新建」，
 *     会被推回云端建出来，或者（被移出成员的）永远 forbidden 卡住推送；
 *     这一步必须在清基线**之前**做 —— `pendingInProject` 要靠基线才知道哪些是本机改过的；
 *   - **每次 `await` 之后问一次 `ensureCurrent`**：和正常拉取一样，中途切了空间就作废。
 */
function resetFromScratch(options) {
    var handle = options.handle;
    var cloud = options.cloud;
    var summary = options.summary;
    var ensureCurrent = options.ensureCurrent;
    var userId = options.userId || null;

    var knownProjects = apply.baselineIds(handle, 'project');
    var saved = [];
    var lostDeletions = 0;

    apply.pendingKeys(handle).forEach(function (key) {
        var index = key.indexOf(':');
        var entity = key.slice(0, index);
        var id = key.slice(index + 1);
        var row = rows.get(handle, entity, id);

        // 本机删了、还没推上去的行：重下之后云端那一份会回来（N5）。
        // 这里只记个数、下面提示一句 —— 拿 baseRev = 0 去推删除会撞 conflict，
        // 照样会被恢复，与其演一遍不如直接说清楚。
        if (!row) { lostDeletions++; return; }

        saved.push({ entity: entity, id: id, row: row });
    });

    return cloud.get('/sync/state').then(function (state) {
        ensureCurrent();

        var projects = state.projects || [];
        var visible = {};
        projects.forEach(function (project) { visible[project.id] = true; });

        removeUnlistedProjects(handle, knownProjects, visible, summary);

        handle.transaction(function () {
            handle.db.exec('DELETE FROM sync_base');
            handle.db.exec('DELETE FROM changes');
        }, { projectId: null });

        var index = 0;

        function next() {
            if (index >= projects.length) return Promise.resolve();
            var project = projects[index];
            index++;

            return cloud.get('/sync/projects/' + encodeURIComponent(project.id) + '/snapshot')
                .then(function (snapshot) {
                    ensureCurrent();

                    var items = [];
                    ORDER.forEach(function (entity) {
                        ((snapshot.rows || {})[entity] || []).forEach(function (row) {
                            items.push({ entity: entity, id: row.id, row: row });
                        });
                    });
                    var out = apply.applyRemote(handle, items);
                    summary.applied += out.applied;
                    collectSkipped(out, summary);
                    return next();
                });
        }

        return next().then(function () {
            ensureCurrent();

            // 游标落在 state.seq 上（B7）。快照是在 state 之后读的，所以这中间那点
            // 变更在下面的 changes 里会再应用一遍，重复应用无害。
            apply.writeCursor(handle, Number(state.seq) || 0);

            handle.transaction(function () {
                mirrorUsers(handle, state.users || [], userId);
                mirrorMembers(handle, state.members, state.projects);
            }, { projectId: null });
        });
    }).then(function () {
        ensureCurrent();

        // 项目被删掉的话，它下面那些本机改动已经没有能推上去的地方了（上面提示过）
        var alive = saved.filter(function (item) { return projectStillHere(handle, item); });

        if (alive.length) {
            var out = apply.applyRemote(handle, alive);
            collectSkipped(out, summary);
            // 写回本机的改动**不给基线** —— 它们还是「本机新建」，下一轮推上去
            alive.forEach(function (item) { apply.dropBaseline(handle, item.entity, item.id); });
        }

        summary.resynced = true;
        summary.warnings.push('云端已经没有这个账号的同步记录了，已经重新下载了一遍；' +
            (alive.length ? '本机没同步的 ' + alive.length + ' 行也留下来了，下一轮推上去' : '本机没有待同步的修改') +
            (lostDeletions ? '；本机删掉但还没同步的 ' + lostDeletions + ' 项恢复了，需要的话请再删一次' : ''));
        return summary;
    });
}

/** 这一行所属的项目在本机还在吗（410 重下之后判断保存下来的改动还能不能写回去） */
function projectStillHere(handle, item) {
    var projectId = rows.projectIdOf(handle, item.entity, item.row);
    if (!projectId) return true;
    return !!projectsRepo.getById(handle, projectId);
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
