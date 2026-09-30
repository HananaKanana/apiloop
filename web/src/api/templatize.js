import { post } from './client';

/**
 * 智能模板化（契约第 8 节）。纯计算、不写库：
 * 把 JSON 文本里可以随机化的值换成 {{@...}} 占位符，并返回替换清单。
 *
 * @param {string} body JSON 文本
 * @returns {Promise<{body: string, replacements: Array, skipped: string|null}>}
 */
export function templatize(body) {
  return post('/templatize', { body: body });
}
