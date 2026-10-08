/**
 * 内置的「Mock」环境（2026-10-01 用户提议，做法参考 Apifox 自动生成的 Mock 环境）。
 *
 * 环境下拉里固定有一项「Mock」：选中后变量 `host` 等于这个项目的 mock 地址
 * （`<云端>/mock-<项目ID>`），请求地址写成 `{{host}}/路径` 就直接打到 mock 上。
 *
 * **它不存库：** mock 地址要跟着云端地址走（以后上外网地址会变），存成普通环境就会过期；
 * 也不该被人改掉、删掉，更不该参与同步。所以页面选中它时传保留的 `environmentId: 'mock'`，
 * 外加算好的 `mockBase`，这里临时拼成一个只有 `host` 一个变量的环境。
 *
 * 地址由页面算，因为只有页面知道云端对外的地址（云端自己在反向代理后面看不到）。
 * 这是用户自己的请求，信任它给的地址没有问题 —— 只校验格式。
 *
 * **变量可以改**（用户 2026-10-02：接口都带 /api、/v1 前缀时要能改 host）：
 * 改过的变量表存在项目的 `extra.mockVariables`（跟着项目同步）；没改过就是默认的
 * `host = <mock 地址>`，页面上可以「还原默认值」。
 * 存的时候 mock 地址写成占位符 MOCK_BASE_TOKEN，用的时候再换成页面给的地址 ——
 * 这样云端地址变了，改过的变量也不会过期（`$MOCK_BASE/api` 永远指向当前的 mock 地址）。
 */

var respond = require('./respond');
var i18n = require('../i18n');

var MOCK_ENV_ID = 'mock';

/** 客户端里「Mock（本机）」的保留 id，和前端 utils/mock.js 的 MOCK_LOCAL_ENV_ID 一致 */
var MOCK_LOCAL_ENV_ID = 'mock-local';

/** 变量名固定为 host（用户的项目基本都叫这个；真有别的叫法时再做成项目设置） */
var MOCK_VARIABLE = 'host';

/** 存库时代表「这个项目的 mock 地址」的占位符，前端 utils/mock.js 里是同一个 */
var MOCK_BASE_TOKEN = '$MOCK_BASE';

/** 项目上存的 Mock 变量表；没改过返回 null */
function storedVariables(project) {
    var list = project && project.extra && project.extra.mockVariables;
    return Array.isArray(list) ? list : null;
}

function defaultVariables() {
    return [{ key: MOCK_VARIABLE, value: MOCK_BASE_TOKEN, enabled: true }];
}

/** 把变量值里的占位符换成实际的 mock 地址 */
function expandVariables(list, base) {
    return list.map(function (row) {
        var value = row && row.value !== undefined && row.value !== null ? String(row.value) : '';
        return Object.assign({}, row, { value: value.split(MOCK_BASE_TOKEN).join(base) });
    });
}

function isMockEnvironment(environmentId) {
    // 'mock-local' 是客户端里的「Mock（本机）」（2026-10-08）：地址打到本机网关，
    // 其余（变量怎么拼、不存库）和云端那个完全一样，所以服务端一视同仁
    return environmentId === MOCK_ENV_ID || environmentId === MOCK_LOCAL_ENV_ID;
}

/**
 * @param {{id: string}} project
 * @param {*} mockBase 页面算好的 mock 地址，例如 `http://host:8080/mock-p_xxx`
 * @param {{websocket?: boolean}} [options] WebSocket 标签页用：协议换成 ws / wss
 * @returns {{id: string, projectId: string, name: string, variables: Array}}
 *   形状和 environmentsRepo.get 返回的一样，调用方可以直接当环境用
 */
function createMockEnvironment(project, mockBase, options) {
    var base = String(mockBase === undefined || mockBase === null ? '' : mockBase).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(base)) {
        throw respond.apiError(400, i18n.m('Mock 环境缺少有效的 mock 地址（mockBase）'));
    }
    if (options && options.websocket) base = base.replace(/^http/i, 'ws');
    return {
        id: MOCK_ENV_ID,
        projectId: project.id,
        name: 'Mock',
        variables: expandVariables(storedVariables(project) || defaultVariables(), base)
    };
}

module.exports = {
    MOCK_ENV_ID: MOCK_ENV_ID,
    MOCK_LOCAL_ENV_ID: MOCK_LOCAL_ENV_ID,
    MOCK_VARIABLE: MOCK_VARIABLE,
    MOCK_BASE_TOKEN: MOCK_BASE_TOKEN,
    storedVariables: storedVariables,
    isMockEnvironment: isMockEnvironment,
    createMockEnvironment: createMockEnvironment
};
