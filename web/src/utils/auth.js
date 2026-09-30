/**
 * 鉴权继承的解析（契约第 5 节第 2 步）。
 *
 * 规则：`auth` 为 null 或 `inherit` 时逐级向上找 —— 先看接口所在的目录，
 * 再看它的父目录，依此类推，最后看项目。**第一个既不是 null 也不是 inherit 的
 * auth 就用它**；找到 `noauth` 也算找到，意思是不加鉴权。
 *
 * 这里只负责「算出来是哪一级 + 拼一句人话给用户看」。真正决定发什么的是服务端，
 * 前端算错也只是提示不准，不会改变请求内容。
 */

const TYPE_NAMES = {
  noauth: '无鉴权',
  bearer: 'Bearer Token',
  basic: 'Basic Auth',
  apikey: 'API Key'
};

/** 这一级是不是「真正配置过」的鉴权（null 和 inherit 都不算） */
export function isConfiguredAuth(auth) {
  return Boolean(auth && auth.type && auth.type !== 'inherit');
}

/** 鉴权类型的中文名；没配置时返回空串 */
export function authTypeName(auth) {
  if (!isConfiguredAuth(auth)) return '';
  return TYPE_NAMES[auth.type] || auth.type;
}

/**
 * 沿上级链找第一个真正配置过的鉴权。
 *
 * @param {Array<{auth: object|null, label: string}>} levels **从内到外**：
 *        第一个是最靠近自己的那一级（目录链由内向外，最后一个是项目）
 * @returns {{ auth: object, label: string } | null} 找不到就返回 null
 */
export function findInheritedAuth(levels) {
  const list = levels || [];
  for (let i = 0; i < list.length; i++) {
    if (isConfiguredAuth(list[i].auth)) return list[i];
  }
  return null;
}

/**
 * 「继承父级」时显示在下方的那句提示。
 * 例：`继承自 目录「人员信息」：Bearer Token。` / `继承自 项目：Basic Auth。`
 */
export function inheritHint(levels) {
  const found = findInheritedAuth(levels);
  if (!found) return '上级都没有配置鉴权，这次请求不带鉴权。';
  return '继承自 ' + found.label + '：' + authTypeName(found.auth) + '。';
}
