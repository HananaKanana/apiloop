/**
 * GraphQL schema 的缓存与几个纯函数（第七轮第 3 节）。
 *
 * **按地址缓存在内存里**：同一个 GraphQL 地址的不同标签页共用一份，关掉标签页就没了
 * （不落库、不进 localStorage —— 一份 schema 可能几百 KB，而且换个后端就作废）。
 *
 * 文档面板要的东西也从这里出：把 introspection 的 `__schema` 整理成「类型 → 字段 → 参数」
 * 的形状。**说明一律当纯文本**（`description` 是对方服务写的内容，不渲染 HTML）。
 */

/** url → `{ schema, loadedAt }`；schema 是 introspection 的 `data`（含 `__schema`） */
const cache = new Map();

export function cachedSchema(url) {
  return (url && cache.get(url)) || null;
}

export function putSchema(url, schema) {
  if (!url || !schema) return;
  cache.set(url, { schema: schema, loadedAt: Date.now() });
}

export function clearSchema(url) {
  if (url) cache.delete(url);
}

/** 类型个数：去掉 `__` 开头的内省类型（`__Schema`、`__Type` 那些不是用户的类型） */
export function typeCount(schema) {
  const types = (schema && schema.__schema && schema.__schema.types) || [];
  return types.filter(function (type) {
    return type && type.name && type.name.indexOf('__') !== 0;
  }).length;
}

/** 「刚刚」「3 分钟前」——schema 是几分钟前拉的，用户要能看出来 */
export function formatLoadedAt(ts, now) {
  const at = Number(ts);
  if (!Number.isFinite(at) || at <= 0) return '';

  const diff = (now || Date.now()) - at;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
  return Math.floor(diff / 86400000) + ' 天前';
}

/** 类型引用 → `[User!]!` 这种好读的写法 */
export function typeText(ref) {
  if (!ref) return '';
  if (ref.kind === 'NON_NULL') return typeText(ref.ofType) + '!';
  if (ref.kind === 'LIST') return '[' + typeText(ref.ofType) + ']';
  return ref.name || '';
}

/** 按名字索引类型（文档面板点字段的类型要跳过去） */
export function typeIndex(schema) {
  const types = (schema && schema.__schema && schema.__schema.types) || [];
  const index = {};

  types.forEach(function (type) {
    if (!type || !type.name) return;
    if (type.name.indexOf('__') === 0) return;   // 内省类型不给用户看
    index[type.name] = type;
  });

  return index;
}

/** 一个类型 → 文档面板要的形状 */
export function typeDoc(type) {
  if (!type) return null;

  return {
    kind: type.kind,
    name: type.name,
    description: type.description || '',
    fields: (type.fields || []).map(fieldDoc),
    inputFields: (type.inputFields || []).map(fieldDoc),
    enumValues: (type.enumValues || []).map(function (value) {
      return {
        name: value.name,
        description: value.description || '',
        deprecated: value.isDeprecated === true ? (value.deprecationReason || '已废弃') : ''
      };
    })
  };
}

function fieldDoc(field) {
  return {
    name: field.name,
    description: field.description || '',
    type: typeText(field.type),
    typeName: bareTypeName(field.type),
    deprecated: field.isDeprecated === true ? (field.deprecationReason || '已废弃') : '',
    args: (field.args || []).map(function (arg) {
      return {
        name: arg.name,
        description: arg.description || '',
        type: typeText(arg.type),
        typeName: bareTypeName(arg.type),
        defaultValue: arg.defaultValue === undefined || arg.defaultValue === null
          ? ''
          : String(arg.defaultValue)
      };
    })
  };
}

/** 拆掉 `!` / `[]`，拿到里面那个类型名（用来跳转） */
export function bareTypeName(ref) {
  if (!ref) return '';
  if (ref.name) return ref.name;
  return bareTypeName(ref.ofType);
}

/** 文档面板的根：Query / Mutation / Subscription（没有的就不列） */
export function rootTypes(schema) {
  const index = typeIndex(schema);
  const meta = (schema && schema.__schema) || {};

  return [
    { key: 'query', label: 'Query', name: meta.queryType && meta.queryType.name },
    { key: 'mutation', label: 'Mutation', name: meta.mutationType && meta.mutationType.name },
    { key: 'subscription', label: 'Subscription', name: meta.subscriptionType && meta.subscriptionType.name }
  ].filter(function (item) {
    return Boolean(item.name && index[item.name]);
  }).map(function (item) {
    return { key: item.key, label: item.label, type: index[item.name] };
  });
}
