/**
 * 在浏览器里生成文件下载。
 * 导出接口返回的是 `{ filename, text }`（JSON / YAML 都是文本），这里只负责落盘。
 *
 * @param {string} filename
 * @param {string} text
 * @param {string} [mime]
 */
export function downloadText(filename, text, mime) {
  const blob = new Blob([text === undefined || text === null ? '' : String(text)], {
    type: (mime || 'text/plain') + ';charset=utf-8'
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'export.txt';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * 导出接口返回的是 { filename, json }，json 可能是对象也可能是字符串，两种都兜住。
 */
export function downloadJson(filename, json) {
  const text = typeof json === 'string' ? json : JSON.stringify(json, null, 2);
  downloadText(filename, text, 'application/json');
}

/** 读一个用户选中的文件为文本 */
export function readFileAsText(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () {
      resolve(String(reader.result || ''));
    };
    reader.onerror = function () {
      reject(new Error('读取文件失败'));
    };
    reader.readAsText(file);
  });
}
