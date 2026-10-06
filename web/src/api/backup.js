import { get, post, put, API_PREFIX, CUSTOM_HEADERS, toError, redirectToLogin } from './client';
import { currentLocale } from '@/i18n';

/**
 * 项目备份与恢复（第十四轮 T18 的后端，接口约定见 lib/api/backup.js）。
 *
 * 两个下载接口（导出整份备份、下载云端某一份自动备份）返回的是**文件本身**
 * （`Content-Disposition: attachment`），文件名在响应头里，所以不能走 `client.js` 的
 * `request` —— 那个会把响应当 JSON 解析、把文件名头丢掉。下面自己 fetch 一次，
 * 把「文本 + 文件名」一起带回来，落盘交给 `utils/download` 的 `downloadText`。
 *
 * 认证/语言那两个头要自己拼：`request()` 里那份没导出，而 api/client.js 不在本任务的
 * 改动范围里。口径和它保持一致（`X-Apiloop: 1` + `Accept-Language`）。
 */

const FALLBACK_NAME = 'apiloop-backup.json';

function headers() {
  return Object.assign({}, CUSTOM_HEADERS, {
    'Accept-Language': currentLocale() === 'en' ? 'en' : 'zh-CN'
  });
}

/**
 * 从 `Content-Disposition` 里取文件名。
 *
 * 服务端两种都给：`filename="apiloop-____-20261005-1256.json"`（非 ASCII 被换成下划线）
 * 和 `filename*=UTF-8''apiloop-%E8%87%AA%E6%B5%8B...json`（真正的中文名）。
 * 优先用后者，解不开才退回前者。
 */
function fileNameFrom(header, fallback) {
  const text = String(header || '');

  const star = /filename\*=UTF-8''([^;]+)/i.exec(text);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch (err) {
      // 编码坏了就用下面那个 ASCII 兜底
    }
  }

  const plain = /filename="([^"]+)"/i.exec(text) || /filename=([^;]+)/i.exec(text);
  if (plain) return plain[1].trim();

  return fallback || FALLBACK_NAME;
}

/** 拿一个「文件型」接口：返回 { filename, text } */
async function fetchFile(path, fallbackName) {
  const res = await fetch(API_PREFIX + path, {
    method: 'GET',
    headers: headers(),
    credentials: 'same-origin'
  });

  // 和 request 一个口径：401 跳登录页，并把这条链路冻住
  if (res.status === 401) {
    redirectToLogin();
    return new Promise(function () {});
  }
  if (!res.ok) throw await toError(res);

  return {
    filename: fileNameFrom(res.headers.get('Content-Disposition'), fallbackName),
    text: await res.text()
  };
}

/* ---------------- 导出 / 恢复 ---------------- */

/** 导出整个项目（editor 及以上）。返回 `{ filename, text }` */
export function exportBackup(pid) {
  return fetchFile('/projects/' + encodeURIComponent(pid) + '/backup', FALLBACK_NAME);
}

/**
 * 恢复。
 *
 * @param {{backup: object, mode: 'new'|'overwrite', name?: string, projectId?: string}} payload
 * @returns {Promise<{project: object, warnings: string[], trashed?: object, deletedSuites?: number}>}
 */
export function restoreBackup(payload) {
  const body = { backup: payload.backup, mode: payload.mode };
  if (payload.name) body.name = payload.name;
  if (payload.projectId) body.projectId = payload.projectId;
  return post('/backup/restore', body);
}

/* ---------------- 云端自动备份 ---------------- */

/** 自动备份开关（读要登录，写要管理员）。`{ backup: { enabled, hour, keepDays } }` */
export function getBackupSetting() {
  return get('/settings/backup');
}

export function updateBackupSetting(backup) {
  return put('/settings/backup', { backup: backup });
}

/** 云端自动备份列表（owner）：`{ items: [{ id, at, size }] }`，新的在前 */
export function listBackups(pid) {
  return get('/projects/' + encodeURIComponent(pid) + '/backups');
}

/** 下载某一份自动备份。返回 `{ filename, text }` */
export function exportAutoBackup(pid, id) {
  return fetchFile(
    '/projects/' + encodeURIComponent(pid) + '/backups/' + encodeURIComponent(id),
    'apiloop-backup-' + id + '.json'
  );
}

/**
 * 拿一份自动备份恢复（等于把那份文件交给 `/backup/restore`）。
 *
 * `mode: 'new'` 时 `name` 可选；`mode: 'overwrite'` 覆盖的就是 `pid` 这个项目。
 */
export function restoreAutoBackup(pid, id, payload) {
  const body = { mode: payload.mode };
  if (payload.name) body.name = payload.name;
  return post('/projects/' + encodeURIComponent(pid) + '/backups/' + encodeURIComponent(id) + '/restore', body);
}
