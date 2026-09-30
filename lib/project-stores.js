/**
 * 每个项目只建一个 store 实例，缓存起来复用。
 *
 * 管理台和 mock-host 必须拿到同一个实例：store 里的 routes 是读缓存，
 * 两边各自持有一份的话，一边改完另一边看不到，mock 接口就不会跟着变。
 */

var routesStore = require('./routes-store');

/** handle → Map(projectId → store)。用 WeakMap 是为了 handle 被回收时缓存自然消失 */
var cache = new WeakMap();

/**
 * @param {object} handle lib/db 的 handle
 * @param {string} projectId
 * @returns {object} store（已 load）
 */
function get(handle, projectId) {
    var map = cache.get(handle);
    if (!map) {
        map = new Map();
        cache.set(handle, map);
    }

    var store = map.get(projectId);
    if (!store) {
        store = routesStore.createStore({ handle: handle, projectId: projectId });
        store.load();
        map.set(projectId, store);
    }
    return store;
}

/** 启动流程收尾时调；只摘订阅，不关 handle */
function closeAll(handle) {
    var map = cache.get(handle);
    if (!map) return;
    map.forEach(function (store) { store.close(); });
    cache.delete(handle);
}

module.exports = {
    get: get,
    closeAll: closeAll
};
