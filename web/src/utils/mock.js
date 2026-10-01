/**
 * 项目的 mock 地址前缀。
 *
 * L1 起 mock 路径是 **`/mock-<项目ID>/`**（原来是 `/mock/<标识>/`）：
 * 项目 ID 全局唯一，不用再靠标识区分，也就没有「标识被占用」「改标识把 mock 地址改坏」
 * 这些麻烦。根项目仍然挂在根路径。
 *
 * **全站只有这一份** —— Mock 页签、Mock 日志抽屉都要拼这个前缀，两处各写一遍迟早走岔。
 *
 * @param {{isRoot?: boolean, id?: string}|null} project
 * @returns {string} 根项目是空串，其余是 `/mock-<项目ID>`
 */
export function mockPrefix(project) {
  if (!project || project.isRoot) return '';
  return '/mock-' + (project.id || '');
}
