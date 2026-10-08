/**
 * zip 的目录列表（T39）。
 *
 * 只列**不解压**：用 fflate 的流式 `Unzip`，在 `onfile` 里拿到文件名和两个大小之后
 * 直接 `terminate()` 跳过这个条目 —— 一个 200 MB 的包要是老老实实全解开，
 * 内存和几秒钟都白花了。
 *
 * 需求里明确说了「不支持解开单个文件预览」，所以这里只返回列表。
 */

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{entries: Array<{name: string, size: number, compressedSize: number}>,
 *           totalSize: number, totalCompressed: number}>}
 * @throws 不是 zip 时抛错
 */
export async function listZip(bytes) {
  const fflate = await import('fflate');

  const entries = [];
  let totalSize = 0;
  let totalCompressed = 0;

  await new Promise(function (resolve, reject) {
    let done = false;

    const unzipper = new fflate.Unzip(function (file) {
      entries.push({
        name: file.name,
        // fflate 的 UnzipFile：`size` 是压缩后的大小，`originalSize` 是解压后的大小
        size: file.originalSize === undefined ? 0 : file.originalSize,
        compressedSize: file.size === undefined ? 0 : file.size
      });
      // 只看目录，不真的解 —— 不 terminate 的话 fflate 会把整个文件读出来
      file.terminate();
    });

    unzipper.register(fflate.UnzipInflate);

    unzipper.onend = function (err) {
      if (done) return;
      done = true;
      if (err && !entries.length) reject(err);
      else resolve();
    };

    try {
      unzipper.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), true);
    } catch (err) {
      if (!done) {
        done = true;
        reject(err);
      }
      return;
    }

    // 空包 / 只有目录项时 onend 可能不触发，兜一下
    if (!done) {
      done = true;
      resolve();
    }
  });

  entries.forEach(function (item) {
    totalSize += item.size;
    totalCompressed += item.compressedSize;
  });

  if (!entries.length) throw new Error('not a zip');

  // 目录项（名字以 / 结尾、大小为 0）排在前面不好看，按路径排一下
  entries.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });

  return { entries: entries, totalSize: totalSize, totalCompressed: totalCompressed };
}
