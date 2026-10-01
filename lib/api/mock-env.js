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
 */

var respond = require('./respond');

var MOCK_ENV_ID = 'mock';

/** 变量名固定为 host（用户的项目基本都叫这个；真有别的叫法时再做成项目设置） */
var MOCK_VARIABLE = 'host';

function isMockEnvironment(environmentId) {
    return environmentId === MOCK_ENV_ID;
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
        throw respond.apiError(400, 'Mock 环境缺少有效的 mock 地址（mockBase）');
    }
    if (options && options.websocket) base = base.replace(/^http/i, 'ws');
    return {
        id: MOCK_ENV_ID,
        projectId: project.id,
        name: 'Mock',
        variables: [{ key: MOCK_VARIABLE, value: base, enabled: true }]
    };
}

module.exports = {
    MOCK_ENV_ID: MOCK_ENV_ID,
    MOCK_VARIABLE: MOCK_VARIABLE,
    isMockEnvironment: isMockEnvironment,
    createMockEnvironment: createMockEnvironment
};
