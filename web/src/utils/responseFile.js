/**
 * 响应「文件」的类型识别（T39）。
 *
 * 后端在发送结果里给了 `response.fileName`（从 `Content-Disposition` 取出来的）和
 * `response.fileId`（非文本、或者被截断的响应才有，能下到**完整**的文件）。
 * 这里决定「这份响应该用哪种预览」，以及「保存到本地」时用什么文件名。
 *
 * 识别顺序（需求里写死的）：**先看 Content-Type** → 它说不清（`application/octet-stream`
 * 或者干脆没有）时看 `fileName` 的扩展名 → 还不行就看文件头的魔数。
 */

/** 超过这个大小就不**自动**预览（还是可以点「仍然预览」） */
export const AUTO_PREVIEW_LIMIT = 20 * 1024 * 1024;

/** 表格类预览最多显示多少行 / 列 */
export const TABLE_MAX_ROWS = 500;
export const TABLE_MAX_COLS = 50;

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tif', 'tiff'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'weba', 'opus'];
const VIDEO_EXT = ['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'avi'];

/** 扩展名 → 类型。图片 / 音视频之外的都列在这里 */
const EXT_KIND = {
  pdf: 'pdf',
  xlsx: 'xlsx',
  xls: 'xls',
  csv: 'csv',
  zip: 'zip'
};

/** 文件名里的扩展名（小写，没有就空串）。`.tar.gz` 这种只取最后一段 */
export function extensionOf(fileName) {
  const name = String(fileName === undefined || fileName === null ? '' : fileName);
  const at = name.lastIndexOf('.');
  if (at < 0 || at === name.length - 1) return '';
  return name.slice(at + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Content-Type → 类型。认不出来返回 '' */
export function kindFromContentType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!type) return '';
  if (type.indexOf('image/') === 0) return type.indexOf('svg') > -1 ? 'image' : 'image';
  if (type.indexOf('audio/') === 0) return 'audio';
  if (type.indexOf('video/') === 0) return 'video';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/csv') return 'csv';
  if (type.indexOf('spreadsheetml') > -1) return 'xlsx';
  if (type === 'application/vnd.ms-excel') return 'xls';
  if (type === 'application/zip' || type === 'application/x-zip-compressed') return 'zip';
  return '';
}

/** 扩展名 → 类型。认不出来返回 '' */
export function kindFromExtension(fileName) {
  const ext = extensionOf(fileName);
  if (!ext) return '';
  if (IMAGE_EXT.indexOf(ext) > -1) return 'image';
  if (AUDIO_EXT.indexOf(ext) > -1) return 'audio';
  if (VIDEO_EXT.indexOf(ext) > -1) return 'video';
  return EXT_KIND[ext] || '';
}

function startsWith(bytes, signature, offset) {
  const at = offset || 0;
  if (!bytes || bytes.length < at + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[at + i] !== signature[i]) return false;
  }
  return true;
}

/**
 * 文件头魔数 → 类型。只看前面几个字节，认不出来返回 ''。
 *
 * 这里只认需求里点名的那几种：`%PDF`、`PK\x03\x04`（zip，xlsx 也是它）、
 * PNG / JPEG / GIF 的文件头。
 */
export function kindFromMagic(bytes) {
  if (!bytes || !bytes.length) return '';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf';                    // %PDF
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return 'zip';                    // PK..
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image';                  // PNG
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image';                        // JPEG
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image';                  // GIF8
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46])) return 'audio';                  // RIFF（wav / webm 都在这）
  return '';
}

/**
 * 最终类型：Content-Type → 扩展名 → 魔数。
 *
 * **zip 要再看一眼扩展名**：xlsx 的文件头也是 `PK\x03\x04`，只按魔数会把 xlsx 认成 zip。
 * 所以魔数认出 zip 时，如果扩展名说是 xlsx / xls，以扩展名为准。
 *
 * @param {string} contentType
 * @param {string} fileName
 * @param {Uint8Array} [bytes] 文件头的几个字节（有就给）
 * @returns {'image'|'audio'|'video'|'pdf'|'xlsx'|'xls'|'csv'|'zip'|'other'}
 */
export function detectFileKind(contentType, fileName, bytes) {
  const fromType = kindFromContentType(contentType);
  if (fromType) return fromType;

  const fromExt = kindFromExtension(fileName);
  if (fromExt) return fromExt;

  const fromMagic = kindFromMagic(bytes);
  if (fromMagic === 'zip') {
    const ext = extensionOf(fileName);
    if (ext === 'xlsx') return 'xlsx';
    if (ext === 'xls') return 'xls';
  }
  return fromMagic || 'other';
}

/** 这个类型是「直接能在页面里画出来」的（图片 / PDF / 音视频） */
export function isInlineKind(kind) {
  return kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video';
}

/** 「保存到本地」时用的文件名：优先用后端给的那个，没有才按 Content-Type 拼一个 */
export function suggestedName(fileName, contentType, fallback) {
  const name = String(fileName || '').trim();
  if (name) return name;
  return fallback || 'response.bin';
}
