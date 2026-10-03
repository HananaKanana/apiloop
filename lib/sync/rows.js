/**
 * 同步用的「原始行」读写（L2）。
 *
 * 同步的行格式是**和数据库列一一对应的原始行**：列名用下划线写法（`project_id`、
 * `folder_id`），JSON 列保持字符串。刻意不用管理台那套 DTO —— DTO 会收拢、改名、
 * 丢掉界面上用不到的列（`extra` 就是典型），同步走一趟就丢数据。
 *
 * 所以这里不经过各表的 repo（它们的入参是 camelCase 的 DTO 形状），直接用列清单拼 SQL。
 *
 * 哪些列**可以**被推上来的行写进去是写死的，列在下面的 writable 里：
 *   - 所有表的 `rev`：只读，由 v7 的触发器维护，永远不从外面写；
 *   - `projects` 的 `slug` / `source_dir` / `is_default` / `created_by`：服务端决定；
 *   - `projects`、`apis` 的 `updated_at`：服务端写当前时间；
 *   - `created_at`：新建时用推上来的值，更新时不动。
 */

var projectsRepo = require('../db/repos/projects');

var ENTITIES = {
    project: {
        table: 'projects',
        label: '项目',
        // 从一行里取「属于哪个项目」：项目自己就是 id
        projectColumn: 'id',
        writable: ['name', 'description', 'variables', 'auth', 'scripts', 'extra', 'created_at'],
        touchUpdatedAt: true,
        // 项目自己还有两个服务端列：slug 由名字推出来，created_by 记成操作者
        serverColumns: ['slug', 'created_by']
    },
    environment: {
        table: 'environments',
        label: '环境',
        projectColumn: 'project_id',
        writable: ['project_id', 'name', 'variables', 'position'],
        touchUpdatedAt: false,
        serverColumns: []
    },
    folder: {
        table: 'folders',
        label: '目录',
        projectColumn: 'project_id',
        writable: ['project_id', 'parent_id', 'name', 'description', 'position', 'auth',
            'variables', 'scripts', 'extra'],
        touchUpdatedAt: false,
        serverColumns: []
    },
    api: {
        table: 'apis',
        label: '接口',
        projectColumn: 'project_id',
        writable: ['project_id', 'folder_id', 'name', 'description', 'position', 'method',
            'url', 'params', 'body', 'auth', 'scripts', 'mock_enabled', 'mock_path',
            'mock_delay', 'mock_cors', 'mock_example_id', 'extra', 'created_at'],
        touchUpdatedAt: true,
        serverColumns: []
    },
    example: {
        table: 'examples',
        label: '示例',
        projectColumn: 'api_id',
        writable: ['api_id', 'name', 'position', 'status', 'headers', 'body',
            'response_type', 'is_template', 'source', 'extra', 'created_at'],
        touchUpdatedAt: false,
        serverColumns: []
    },
    expectation: {
        table: 'mock_expectations',
        label: '期望',
        projectColumn: 'api_id',
        writable: ['api_id', 'position', 'name', 'enabled', 'conditions', 'example_id'],
        touchUpdatedAt: false,
        serverColumns: []
    },
    // 回收站（迁移 v9）。payload 是 JSON 字符串，整块当一个字段同步 —— 它只增删、不改，
    // 所以不会有「两边各改了一半」的合并问题。
    trash: {
        table: 'trash',
        label: '回收站条目',
        projectColumn: 'project_id',
        writable: ['project_id', 'kind', 'name', 'location', 'payload', 'deleted_by', 'deleted_at'],
        touchUpdatedAt: false,
        serverColumns: []
    }
};

/**
 * 同步的实体顺序（快照按这个顺序给，界面上也稳定）。
 *
 * `trash` 排在最后：它引用的是项目，和别的实体没有外键关系，插在最后最省事；
 * 而且旧客户端拉到它的变更会因为 `rows.has('trash')` 为假直接忽略（pull.js），
 * 不影响别的实体。
 */
var ORDER = ['project', 'environment', 'folder', 'api', 'example', 'expectation', 'trash'];

function spec(entity) {
    return ENTITIES[entity] || null;
}

function has(entity) {
    return !!ENTITIES[entity];
}

function label(entity) {
    var found = ENTITIES[entity];
    return found ? found.label : '资源';
}

/**
 * 实体对应的表名。网关那边把云端的行落到本机时要按表名拼 SQL
 * （`lib/gateway/sync/apply.js`），别在那边再抄一份映射。
 */
function table(entity) {
    var found = ENTITIES[entity];
    return found ? found.table : null;
}

/** 可同步的列（推上来的行里这些列会被写进去），顺序固定 */
function columns(entity) {
    var found = ENTITIES[entity];
    return found ? found.writable.slice() : [];
}

/** 某个实体在某个项目里的全部原始行 */
function list(handle, entity, projectId) {
    var found = ENTITIES[entity];
    if (!found) return [];

    if (found.projectColumn === 'id') {
        return handle.db.prepare('SELECT * FROM ' + found.table + ' WHERE id = ?').all(projectId);
    }
    if (found.projectColumn === 'project_id') {
        return handle.db.prepare('SELECT * FROM ' + found.table + ' WHERE project_id = ? ORDER BY rowid')
            .all(projectId);
    }
    // 示例和期望自己不存项目 id，经过所属接口绕一次
    return handle.db.prepare(
        'SELECT t.* FROM ' + found.table + ' t JOIN apis a ON a.id = t.api_id ' +
        'WHERE a.project_id = ? ORDER BY t.rowid'
    ).all(projectId);
}

function get(handle, entity, id) {
    var found = ENTITIES[entity];
    if (!found) return null;
    return handle.db.prepare('SELECT * FROM ' + found.table + ' WHERE id = ?').get(String(id)) || null;
}

/**
 * 从一行里反查它属于哪个项目，查不到返回 null。
 * 示例、期望要先经过 `api_id` 找到接口 —— 和 lib/access.js 的 projectIdOf 同一个口径。
 */
function projectIdOf(handle, entity, row) {
    var found = ENTITIES[entity];
    if (!found || !row) return null;

    if (found.projectColumn === 'id') return row.id || null;
    if (found.projectColumn === 'project_id') return row.project_id || null;

    var apiId = row.api_id;
    if (!apiId) return null;
    var api = handle.db.prepare('SELECT project_id FROM apis WHERE id = ?').get(String(apiId));
    return api ? api.project_id : null;
}

/**
 * 新建一行。只写 writable 里出现的列，以及服务端自己决定的几个。
 *
 * 行里缺的列**不进 INSERT 列表**（让表的默认值生效），只有非空且没有默认值的几个
 * （name、created_at）才补一个兜底值 —— 否则一个字段没带就整条推送失败。
 *
 * @param {{actorId?: string}} [options]
 */
function insert(handle, entity, row, options) {
    var found = ENTITIES[entity];
    if (!found) throw new Error('未知的实体类型：' + entity);

    var names = ['id'];
    var values = [String(row.id)];

    found.writable.forEach(function (col) {
        var value = row[col] === undefined ? fallback(col) : row[col];
        if (value === undefined) return;
        names.push(col);
        values.push(value);
    });

    if (found.touchUpdatedAt) {
        names.push('updated_at');
        values.push(Date.now());
    }

    if (entity === 'project') {
        names.push('slug');
        values.push(projectsRepo.uniqueSlug(handle, String(row.name || '')));
        names.push('created_by');
        values.push((options && options.actorId) || null);
    }

    // node:sqlite 的 run 是展开参数签名，而且需要正确的 this，所以用 apply(statement, …)
    var statement = handle.db.prepare(
        'INSERT INTO ' + found.table + ' (' + names.join(', ') + ') ' +
        'VALUES (' + names.map(function () { return '?'; }).join(', ') + ')'
    );
    statement.run.apply(statement, values);

    return get(handle, entity, row.id);
}

/** 新建时行里缺了这一列用什么。返回 undefined 表示交给表自己的默认值 */
function fallback(col) {
    if (col === 'created_at') return Date.now();
    if (col === 'name') return '';
    return undefined;
}

/**
 * 更新一行。`created_at` 不动，`rev` 由触发器加（这里永远不写 rev）。
 *
 * 行里缺的列同样不写 —— 推送方只改了一个字段时，其余列保持库里现在的样子。
 */
function update(handle, entity, id, row) {
    var found = ENTITIES[entity];
    if (!found) throw new Error('未知的实体类型：' + entity);

    var sets = [];
    var values = [];

    found.writable.forEach(function (col) {
        if (col === 'created_at') return;
        if (row[col] === undefined) return;
        sets.push(col + ' = ?');
        values.push(row[col]);
    });

    if (found.touchUpdatedAt) {
        sets.push('updated_at = ?');
        values.push(Date.now());
    }
    if (!sets.length) return get(handle, entity, id);

    values.push(String(id));
    var statement = handle.db.prepare(
        'UPDATE ' + found.table + ' SET ' + sets.join(', ') + ' WHERE id = ?'
    );
    statement.run.apply(statement, values);

    return get(handle, entity, id);
}

function remove(handle, entity, id) {
    var found = ENTITIES[entity];
    if (!found) return;
    handle.db.prepare('DELETE FROM ' + found.table + ' WHERE id = ?').run(String(id));
}

module.exports = {
    ORDER: ORDER,
    columns: columns,
    has: has,
    label: label,
    table: table,
    list: list,
    get: get,
    projectIdOf: projectIdOf,
    insert: insert,
    update: update,
    remove: remove
};
