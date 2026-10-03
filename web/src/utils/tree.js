/**
 * 把 /tree 接口返回的扁平列表组装成树。
 *
 * 排序规则（契约第 1 节）：同一个父目录下，先按 position 列出子目录，再按 position 列出接口。
 * 每个节点都带上 parentId 和 position，拖拽时算新的位置要用。
 */

export function buildTree(folders, apis) {
  const folderNodes = new Map();
  const roots = [];

  (folders || []).forEach(function (folder) {
    folderNodes.set(folder.id, {
      key: 'f:' + folder.id,
      kind: 'folder',
      id: folder.id,
      name: folder.name,
      label: folder.name,
      parentId: folder.parentId || null,
      position: folder.position || 0,
      folder: folder,
      children: []
    });
  });

  (folders || []).forEach(function (folder) {
    const node = folderNodes.get(folder.id);
    const parent = folder.parentId ? folderNodes.get(folder.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });

  (apis || []).forEach(function (api) {
    const node = {
      key: 'a:' + api.id,
      kind: 'api',
      id: api.id,
      name: api.name,
      label: api.name,
      parentId: api.folderId || null,
      position: api.position || 0,
      isLeaf: true,
      api: api
    };
    const parent = api.folderId ? folderNodes.get(api.folderId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });

  sortLevel(roots);
  return roots;
}

function sortLevel(list) {
  list.sort(function (a, b) {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return (a.position || 0) - (b.position || 0);
  });
  list.forEach(function (node) {
    if (node.children && node.children.length) sortLevel(node.children);
  });
}

/** 深度优先遍历，回调返回 false 就不再往下走 */
export function walkTree(nodes, visit, parent) {
  (nodes || []).forEach(function (node) {
    if (visit(node, parent) === false) return;
    if (node.children) walkTree(node.children, visit, node);
  });
}

export function findNode(nodes, key) {
  let found = null;
  walkTree(nodes, function (node) {
    if (node.key === key) {
      found = node;
      return false;
    }
  });
  return found;
}

/** 收集所有目录节点的 key，用来「全部展开」 */
export function collectFolderKeys(nodes) {
  const keys = [];
  walkTree(nodes, function (node) {
    if (node.kind === 'folder') keys.push(node.key);
  });
  return keys;
}

/**
 * 收集一个目录（含所有子目录）里的接口节点，**按目录树显示的顺序**。
 *
 * 批量运行要用：跑的次序就是用户在左边看到的次序，两边各排一次迟早会不一致。
 * WebSocket 接口不列出来（它不是 HTTP 请求，`/send` 也不收，见第 2 节）。
 *
 * @param {Array<object>} nodes 目录树的根节点
 * @param {string|null} folderId 传 null 表示整个项目（目录树最外层）
 * @returns {Array<object>} 接口节点（buildTree 造出来的那种，带 `api` / `parentId`）
 */
export function collectApiNodes(nodes, folderId) {
  const root = folderId ? findNode(nodes, 'f:' + folderId) : null;
  // 目录已经不在了（刚被删掉）就当它底下没有接口，而不是把整个项目跑一遍
  const list = folderId ? (root ? root.children || [] : []) : (nodes || []);

  const out = [];
  walkTree(list, function (node) {
    if (node.kind !== 'api') return;
    if (String((node.api && node.api.method) || '').toUpperCase() === 'WS') return;
    out.push(node);
  });
  return out;
}

/**
 * 从一个目录往上走，返回 `[自己, 父目录, 祖父目录, ...]` —— **从内到外**。
 *
 * 鉴权继承（契约第 5 节第 2 步）和变量替换都要这个链，别在调用处各写一遍。
 * 传 `folderId = null` 得到空数组，正好对应「接口没放在任何目录里」。
 */
export function folderChain(folders, folderId) {
  const byId = new Map();
  (folders || []).forEach(function (folder) { byId.set(folder.id, folder); });

  const chain = [];
  let id = folderId || null;
  // 兜底：数据万一成环（正常情况服务端会拦），也不能把界面转死
  while (id && chain.length < 64) {
    const folder = byId.get(id);
    if (!folder) break;
    chain.push(folder);
    id = folder.parentId || null;
  }
  return chain;
}

/**
 * 按关键词过滤（匹配接口名、url 或目录名）。
 * 命中的节点连同它的所有祖先目录一起保留，其余剪掉。
 */
export function filterTree(nodes, keyword) {
  const q = String(keyword || '').trim().toLowerCase();
  if (!q) return nodes;

  function visit(list) {
    const kept = [];
    list.forEach(function (node) {
      if (node.kind === 'folder') {
        const children = visit(node.children || []);
        const selfMatch = node.name.toLowerCase().indexOf(q) !== -1;
        if (children.length || selfMatch) {
          kept.push(Object.assign({}, node, { children: children }));
        }
        return;
      }
      const name = String(node.name || '').toLowerCase();
      const url = String((node.api && node.api.url) || '').toLowerCase();
      if (name.indexOf(q) !== -1 || url.indexOf(q) !== -1) kept.push(node);
    });
    return kept;
  }

  return visit(nodes);
}
