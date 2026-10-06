import { folderChain } from '@/utils/tree';
import { t } from '@/i18n';

/**
 * 公共请求头（第五轮第 1 节）——**服务端那一份的前端镜像**。
 *
 * 规则一个字都不能和 `lib/common-headers.js` 差：同名不分大小写、越靠近接口越优先
 * （接口 > 内层目录 > 外层目录 > 项目），停用的行照样算「这一层表过态」（内层关掉一个头
 * 就是把外层那个覆盖成「不发」）。
 *
 * 前端要它是因为「继承来的请求头」得在**没保存、没发送**的时候就能显示出来 ——
 * 而服务端的 `/send` 回来的结果里只有合并之后的一整份，看不出哪些是继承的。
 */

/** 归一化成请求头行的形状（和服务端 `dto.toRows` 一致）；没有名字的行丢掉 */
export function normalizeRows(list) {
  if (!Array.isArray(list)) return [];

  const rows = [];
  list.forEach(function (item) {
    if (!item || typeof item !== 'object') return;
    const key = item.key === undefined || item.key === null ? '' : String(item.key);
    if (!key) return;

    rows.push({
      key: key,
      value: item.value === undefined || item.value === null ? '' : String(item.value),
      type: item.type ? String(item.type) : 'string',
      required: item.required === true,
      desc: item.desc ? String(item.desc) : '',
      enabled: item.enabled !== false
    });
  });
  return rows;
}

/** 某个项目 / 目录上配的公共请求头（接口给的就是顶层 `headers`） */
export function headersOf(entity) {
  return normalizeRows(entity ? entity.headers : null);
}

/**
 * 继承链上的各层，**从外到内**（项目 → 外层目录 → … → 接口自己所在的目录）。
 * `folderChain` 给的是从内到外，所以这里翻过来。
 */
export function headerLayers(project, folders, folderId) {
  const inner = folderChain(folders, folderId).slice().reverse();
  const layers = [{ label: t('utils.layerProject'), rows: headersOf(project) }];

  inner.forEach(function (folder) {
    layers.push({ label: t('utils.layerFolder', { name: folder.name }), rows: headersOf(folder) });
  });

  return layers;
}

function lowerKey(row) {
  return String(row.key).toLowerCase();
}

/**
 * 把继承来的公共请求头合进接口自己那份。
 *
 * @param {Array} own 接口自己的请求头行
 * @param {Array<{label: string, rows: Array}>} layers 继承来的各层（外 → 内）
 * @returns {{rows: Array, inherited: Array}} 含义同 `lib/common-headers.js` 的 `resolve`
 */
export function resolveHeaders(own, layers) {
  const ownRows = normalizeRows(own);
  const taken = new Set(ownRows.map(lowerKey));

  const byKey = new Map();
  const order = [];

  (layers || []).forEach(function (layer) {
    normalizeRows(layer.rows).forEach(function (row) {
      const key = lowerKey(row);
      if (!byKey.has(key)) order.push(key);
      // 后面的层覆盖前面的
      // 停用的行不参与覆盖：外层启用了、内层停着一行同名的，照样用外层的（和服务端 lib/common-headers.js 一致）
      if (row.enabled === false && byKey.has(key) && byKey.get(key).row.enabled !== false) return;
      byKey.set(key, { row: row, from: layer.label });
    });
  });

  const inherited = order.map(function (key) {
    return Object.assign({}, byKey.get(key).row, {
      from: byKey.get(key).from,
      shadowed: taken.has(key)
    });
  });

  const rows = ownRows.concat(inherited.filter(function (row) {
    return !row.shadowed && row.enabled !== false;
  }).map(function (row) {
    return {
      key: row.key,
      value: row.value,
      type: row.type,
      required: row.required,
      desc: row.desc,
      enabled: row.enabled
    };
  }));

  return { rows: rows, inherited: inherited };
}
