/**
 * 临时标签页的本地持久化（T35「快速请求」）。
 *
 * 「临时标签页」= **还没保存进目录树**的那些：空白请求（`draft`）和没有绑定接口的
 * WebSocket / Socket.IO / gRPC / MQTT / TCP / UDP 标签页。它们的内容只活在内存里，
 * 刷新一下就没了 —— 这个模块把「标题 + 请求内容」按项目存进 localStorage，重启后恢复。
 *
 * 几条刻意的取舍：
 * - **按项目分开存**（键里带项目 id）：临时标签页属于某个项目的目录结构，混在一起没意义；
 * - **不存**响应结果、连接状态、正在进行的会话：那些刷新后本来就不该还在
 *   （存了会出现「显示已连接但其实没连」这种假状态）；
 * - **最多 20 个**，超出的丢最早的；
 * - localStorage 读写**全部包 try/catch**：隐私模式 / 配额满 / 被禁用时当没有存过，
 *   功能照常用，只是重启后不恢复。
 *
 * 只负责读写，不碰 store —— 什么时候存（防抖）、什么时候恢复，都在 `stores/tabs.js` 里。
 */

const KEY_PREFIX = 'apiloop.tempTabs.';

/** 最多保留几个，超出的丢掉最早的 */
const MAX_TABS = 20;

/** 要保留的 kind：都是「还没进目录树」的临时标签页 */
const TEMP_KINDS = ['draft', 'ws', 'sio', 'grpc', 'mqtt', 'socket'];

/** 这个标签页要不要保留。绑定接口的不留 —— 它的内容在库里，下次打开是它自己 */
export function isTempTab(tab) {
  if (!tab || tab.apiId) return false;
  return TEMP_KINDS.indexOf(tab.kind) > -1;
}

function storage() {
  try {
    // 隐私模式下 `window.localStorage` 这个取值本身就可能抛
    return window.localStorage;
  } catch (err) {
    return null;
  }
}

/** 只留「标题 + 请求内容」这几项，响应 / 连接状态一律丢掉 */
export function snapshot(tabs) {
  return (tabs || []).filter(isTempTab).slice(-MAX_TABS).map(function (tab) {
    return {
      kind: tab.kind,
      title: String(tab.title === undefined || tab.title === null ? '' : tab.title),
      customTitle: tab.customTitle === true,
      folderId: tab.folderId || null,
      spec: tab.spec
    };
  });
}

/**
 * 把当前这一份临时标签页写进存储（覆盖式：关掉的、存进目录树的自然就不在里面了）。
 * 写不进去（配额满、隐私模式）就算了，不影响使用。
 */
export function write(projectId, tabs) {
  if (!projectId) return;
  const box = storage();
  if (!box) return;

  try {
    const list = snapshot(tabs);
    if (!list.length) {
      box.removeItem(KEY_PREFIX + projectId);
      return;
    }
    box.setItem(KEY_PREFIX + projectId, JSON.stringify(list));
  } catch (err) {
    // 存不下就算了：下次打开少几个临时标签页，比报错强
  }
}

/** 读回一个项目存下来的临时标签页。读不出来（没存过 / 坏了 / 被禁用）就是空数组 */
export function read(projectId) {
  if (!projectId) return [];
  const box = storage();
  if (!box) return [];

  let raw = null;
  try {
    raw = box.getItem(KEY_PREFIX + projectId);
  } catch (err) {
    return [];
  }
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 只认认识得出来的 kind：老版本存过别的形状时不要炸，直接跳过那几条
    return parsed.filter(function (item) {
      return item && TEMP_KINDS.indexOf(item.kind) > -1 && item.spec && typeof item.spec === 'object';
    }).slice(-MAX_TABS);
  } catch (err) {
    return [];
  }
}

/** 清掉一个项目的记录（暂时没用到，留着自己调试和以后「恢复默认」用） */
export function remove(projectId) {
  const box = storage();
  if (!box || !projectId) return;
  try {
    box.removeItem(KEY_PREFIX + projectId);
  } catch (err) {
    // 同上
  }
}

/** 存储里最多留几个（给界面上的提示文案用） */
export const MAX_TEMP_TABS = MAX_TABS;
