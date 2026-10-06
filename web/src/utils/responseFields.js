import { t } from '@/i18n';
/**
 * 响应字段说明的纯函数（第六轮第 2 节）。
 *
 * 文档里只有示例响应，前端拿到 `{"code":0,"data":{"st":1}}` 不知道 `st` 是什么意思。
 * 这里做两件事：**从示例的 JSON 结构列出字段**、以及把新生成的字段和已经写过的说明合并。
 *
 * 路径写法：`data.list[].id` —— 数组元素写成 `list[]`，**不按下标展开**
 * （`list[0]`、`list[1]` 会列出一堆一样的行，而且下标本身不该写进文档）。
 */

/** JSON 值的类型名（和界面上那个下拉的选项一致） */
export function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  return 'string';
}

function joinPath(prefix, key) {
  return prefix ? prefix + '.' + key : String(key);
}

/**
 * 从一个 JSON 值递归列出字段。
 *
 * 空数组**什么都不列**：没有元素就不知道里面长什么样，硬写一个 `list[]` 只是噪音，
 * 用户要的话手动加一行就行。
 *
 * @param {*} value 解析后的 JSON 值
 * @returns {Array<{path: string, type: string}>} 按出现顺序（对象的键顺序）
 */
export function fieldsFromJson(value) {
  const out = [];
  walk(value, '', out, 0);
  return out;
}

function walk(value, prefix, out, depth) {
  if (depth > 24) return;   // 数据成环那种不存在的输入，别把栈爆了

  if (Array.isArray(value)) {
    if (!value.length) return;
    walk(value[0], prefix + '[]', out, depth + 1);
    return;
  }

  if (value && typeof value === 'object') {
    Object.keys(value).forEach(function (key) {
      const path = joinPath(prefix, key);
      const child = value[key];

      if (Array.isArray(child)) {
        if (!child.length) return;      // 空数组不列（见上面）
        out.push({ path: path + '[]', type: typeOf(child[0]) });
        walk(child[0], path + '[]', out, depth + 1);
        return;
      }

      out.push({ path: path, type: typeOf(child) });
      if (child && typeof child === 'object') walk(child, path, out, depth + 1);
    });
  }
}

/**
 * 从示例正文生成字段列表。
 *
 * @param {string} text 示例的响应体原文
 * @returns {{ok: true, fields: Array} | {ok: false, error: string}}
 */
export function fieldsFromExample(text) {
  const source = String(text === undefined || text === null ? '' : text).trim();
  if (!source) return { ok: false, error: t('utils.fieldsNoBody') };

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    return { ok: false, error: t('utils.fieldsNotJson') };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: t('utils.fieldsNotObject') };
  }

  return { ok: true, fields: fieldsFromJson(parsed) };
}

/**
 * 把「从示例生成」的结果和已经写过的字段合并。
 *
 * - **已经写过说明的字段保留说明**（还有类型和「必有」）—— 生成只是补齐，不是覆盖；
 * - 示例里新增的字段补上；
 * - 示例里已经没有的字段**留着**，由调用方标出来让用户自己决定要不要清掉
 *   （自动删掉用户写过的说明太狠了）。
 *
 * @returns {{fields: Array, missing: Array<string>}} missing 是「示例里已经没有」的路径
 */
export function mergeGenerated(existing, generated) {
  const byPath = new Map();
  (existing || []).forEach(function (field) {
    if (field && field.path) byPath.set(field.path, field);
  });

  const fields = [];
  const seen = {};

  (generated || []).forEach(function (field) {
    seen[field.path] = true;
    const before = byPath.get(field.path);

    fields.push({
      path: field.path,
      type: before && before.type ? before.type : field.type,
      desc: before ? String(before.desc || '') : '',
      required: before ? before.required === true : false
    });
  });

  const missing = [];
  (existing || []).forEach(function (field) {
    if (!field || !field.path || seen[field.path]) return;
    fields.push({
      path: field.path,
      type: field.type || 'string',
      desc: String(field.desc || ''),
      required: field.required === true
    });
    missing.push(field.path);
  });

  return { fields: fields, missing: missing };
}

/** 路径的层级（用来缩进）：`data.list[].id` → 3 段 */
export function depthOf(path) {
  const text = String(path || '');
  if (!text) return 0;
  return text.split('.').length - 1;
}

/** 路径最后一段的名字（缩进显示时只显示这一段） */
export function leafOf(path) {
  const text = String(path || '');
  const parts = text.split('.');
  return parts[parts.length - 1] || text;
}
