/**
 * 查找替换弹窗里的纯逻辑（第五轮第 2 节）。
 *
 * 抽出来有两个原因：一是 `FindReplaceDialog.vue` 里只剩界面，二是这些规则能单独跑断言
 * （`.vue` 里的逻辑没法在不开浏览器的情况下验，见 skill `apiloop-selftest-harness`）。
 *
 * 勾选状态一律用「**取消掉的**」这份表表示：命中默认全勾，一份 500 条的结果里
 * 用户通常只取消几条，记这套比记「勾上的」小得多。
 */

/** 命中在结果里的唯一键 —— 服务端就是按 `apiId + field + location` 认位置的 */
export function matchKey(match) {
  return match.apiId + '|' + match.field + '|' + match.location;
}

/**
 * 按接口分组，**顺序就是服务端给的顺序**（服务端按接口在项目里的顺序给的）。
 * @returns {Array<{apiId, name, method, items: Array}>}
 */
export function groupMatches(matches) {
  const map = new Map();

  (matches || []).forEach(function (match) {
    if (!map.has(match.apiId)) {
      map.set(match.apiId, {
        apiId: match.apiId,
        name: match.apiName || '(未命名接口)',
        method: String(match.method || 'GET').toUpperCase(),
        items: []
      });
    }
    map.get(match.apiId).items.push(match);
  });

  return Array.from(map.values());
}

/** 命中那一段的高亮切分：把 line 按 start / end 切成三段（空的不留） */
export function segmentsOf(match) {
  const text = String((match && match.line) || '');
  const start = Math.max(0, Math.min(text.length, Number(match && match.start) || 0));
  const end = Math.max(start, Math.min(text.length, Number(match && match.end) || 0));

  return [
    { text: text.slice(0, start), hit: false },
    { text: text.slice(start, end), hit: true },
    { text: text.slice(end), hit: false }
  ].filter(function (part) { return part.text; });
}

export function isChecked(unchecked, match) {
  return !unchecked || unchecked[matchKey(match)] !== true;
}

/** 翻一条的勾选，返回**新的** unchecked（不要去改传进来的那个对象） */
export function toggleMatch(unchecked, match) {
  const next = Object.assign({}, unchecked || {});
  if (isChecked(unchecked, match)) next[matchKey(match)] = true;
  else delete next[matchKey(match)];
  return next;
}

export function apiChecked(unchecked, group) {
  return (group.items || []).every(function (match) { return isChecked(unchecked, match); });
}

export function apiIndeterminate(unchecked, group) {
  return !apiChecked(unchecked, group) &&
    (group.items || []).some(function (match) { return isChecked(unchecked, match); });
}

/** 整个接口一起勾上 / 取消（全勾着就全取消，否则全勾上） */
export function toggleApi(unchecked, group) {
  const next = Object.assign({}, unchecked || {});
  const all = apiChecked(unchecked, group);

  (group.items || []).forEach(function (match) {
    if (all) next[matchKey(match)] = true;
    else delete next[matchKey(match)];
  });
  return next;
}

/** 勾上的那些 → 提交给服务端的 targets */
export function selectedTargets(matches, unchecked) {
  return (matches || []).filter(function (match) {
    return isChecked(unchecked, match);
  }).map(function (match) {
    return { apiId: match.apiId, field: match.field, location: match.location };
  });
}

/**
 * 这次会被跳过的接口名：**本来会改到、但那个接口有未保存的修改**。
 * 只说这一种，免得把「压根没勾的接口」也列进去。
 *
 * @param {Array} groups `groupMatches` 的结果
 * @param {object} unchecked
 * @param {Set<string>} dirtyIds 有未保存修改的接口 id
 */
export function skippedNames(groups, unchecked, dirtyIds) {
  const names = [];

  (groups || []).forEach(function (group) {
    if (!dirtyIds || !dirtyIds.has(group.apiId)) return;
    if (!(group.items || []).some(function (match) { return isChecked(unchecked, match); })) return;
    names.push(group.name);
  });

  return names;
}
