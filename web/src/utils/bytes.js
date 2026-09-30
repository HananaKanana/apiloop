/**
 * 体积相关的小工具。
 *
 * 一律按 UTF-8 字节算，不按 `String.length` —— 中文一个字符 3 个字节，
 * 按字符数算出来的进度会明显偏小。
 */

export function byteLength(text) {
  if (!text) return 0;
  return new TextEncoder().encode(text).length;
}

/** 人类可读的体积。null / undefined（还没有数据）显示成「—」 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}
