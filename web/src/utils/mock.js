import { useGatewayStore } from '@/stores/gateway';

/**
 * 内置「Mock」环境的保留 id。
 *
 * 它**不存库**：mock 地址要跟着云端地址走（以后上外网地址会变），存成普通环境就会过期，
 * 也不该被人改掉、删掉，更不该参与同步。所以页面选中它时传这个保留 id，
 * 外加算好的 `mockBase`，服务端临时拼一个只有 `host` 一个变量的环境
 * （见 `lib/api/mock-env.js`）。
 */
export const MOCK_ENV_ID = 'mock';

/**
 * 内置「Mock（本机）」环境的保留 id（2026-10-08）。只在客户端里有：mock 打到本机网关
 * （`127.0.0.1:<网关端口>/mock-<项目ID>`，和页面同一个端口），用的是本机库里的示例。
 * `MOCK_ENV_ID` 那个是云端的。两个都不存库，服务端认这两个 id 都是「内置 Mock」。
 */
export const MOCK_LOCAL_ENV_ID = 'mock-local';

/** 是不是两个内置 Mock 环境之一 */
export function isMockEnvId(id) {
  return id === MOCK_ENV_ID || id === MOCK_LOCAL_ENV_ID;
}

/** 内置 Mock 环境里那个变量的名字，和服务端 mock-env.js 的 MOCK_VARIABLE 一致 */
export const MOCK_VARIABLE = 'host';

/**
 * 存库时代表「这个项目的 mock 地址」的占位符，和服务端 mock-env.js 的 MOCK_BASE_TOKEN 一致。
 * 页面上永远显示展开后的地址；保存时再把地址收回成占位符，云端地址变了改过的变量也不过期。
 */
export const MOCK_BASE_TOKEN = '$MOCK_BASE';

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

/**
 * 这个项目的 mock 地址（不含具体路径），用作内置 Mock 环境里 `host` 变量的值。
 *
 * 在**网关上要用云端地址** —— mock 服务跑在云端，页面上如果给本机地址，请求会打回自己。
 * 直接打开云端时就是当前 origin。末尾的 `/` 去掉（服务端也会再去一次）。
 *
 * @param {{isRoot?: boolean, id?: string}|null} project
 * @returns {string} 例如 `https://cloud.example.com/mock-p_xxx`；根项目就是云端地址本身
 */
export function mockBaseUrl(project, where) {
  return (where === 'local' ? localMockOrigin() : mockOrigin()) + mockPrefix(project);
}

/** 本机 Mock 的地址前半段：就是页面自己（网关），`http://127.0.0.1:<端口>` */
export function localMockOrigin() {
  return String(window.location.origin).replace(/\/+$/, '');
}

/** 环境 id → 它是哪一套 Mock（'local' / 'cloud'），不是 Mock 环境时是空串 */
export function mockWhere(environmentId) {
  if (environmentId === MOCK_LOCAL_ENV_ID) return 'local';
  if (environmentId === MOCK_ENV_ID) return 'cloud';
  return '';
}

/**
 * Mock 地址的前半段（云端地址）：客户端里是网关记着的云端地址，网页版就是当前页面。
 * 「创建样例项目」也要用它 —— 样例项目的环境里 `host` 要写成这个项目的 Mock 地址。
 */
export function mockOrigin() {
  const gateway = useGatewayStore();
  const base = gateway.isGateway && gateway.cloudUrl ? gateway.cloudUrl : window.location.origin;
  return String(base).replace(/\/+$/, '');
}

/** 默认的 Mock 变量表（展开后的）：只有 host = mock 地址 */
export function defaultMockVariables(project, where) {
  return [{ key: MOCK_VARIABLE, value: mockBaseUrl(project, where), enabled: true }];
}

/**
 * 内置 Mock 环境实际用的变量表（展开后的）。项目上改过就用改过的（`project.mockVariables`），
 * 否则是默认值。
 */
export function mockVariables(project, where) {
  const stored = project && Array.isArray(project.mockVariables) ? project.mockVariables : null;
  if (!stored) return defaultMockVariables(project, where);
  // 两套 Mock 共用项目上存的那一份变量（里面的地址是占位符），只是展开成各自的地址
  const base = mockBaseUrl(project, where);
  return stored.map(function (row) {
    return { ...row, value: String(row.value || '').split(MOCK_BASE_TOKEN).join(base) };
  });
}

/** 保存前把值里的 mock 地址收回成占位符（只认开头那一段，和用户手写的别的地址无关） */
export function collapseMockVariables(project, rows, where) {
  const base = mockBaseUrl(project, where);
  return (rows || []).map(function (row) {
    const value = String((row && row.value) || '');
    return { ...row, value: value.indexOf(base) === 0 ? MOCK_BASE_TOKEN + value.slice(base.length) : value };
  });
}

/**
 * 发送请求时要额外带上的 mock 地址：**选中内置 Mock 环境才带**。
 *
 * 服务端不存这个环境，地址得由页面给它（只有页面知道云端对外的地址）。
 * `/send` 和 WebSocket 建会话都要用，放这里免得两处各写一遍、写岔。
 *
 * @param {string} environmentId 这次请求选的环境
 * @param {{isRoot?: boolean, id?: string}|null} project
 * @returns {string|undefined}
 */
export function mockBaseFor(environmentId, project) {
  const where = mockWhere(environmentId);
  return where ? mockBaseUrl(project, where) : undefined;
}
