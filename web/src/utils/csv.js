import { TABLE_MAX_COLS, TABLE_MAX_ROWS } from '@/utils/responseFile';

/**
 * CSV 解析（T39）。
 *
 * 按 RFC 4180 写：字段可以用双引号包起来，包起来的字段里可以有逗号、换行和
 * **两个连续的双引号**（表示一个字面双引号）。分隔符只认逗号（需求里没提分号）。
 *
 * 一次扫完整个文本，不用正则 split —— 带引号的换行用 split('\n') 一定切错。
 */

/**
 * @param {string} text
 * @param {{maxRows?: number, maxCols?: number}} [options]
 * @returns {{rows: string[][], totalRows: number, totalCols: number, truncated: boolean}}
 *          `rows` 已经截到上限；`totalRows` / `totalCols` 是原始数量，用来提示「还有多少没显示」
 */
export function parseCsv(text, options) {
  const maxRows = (options && options.maxRows) || TABLE_MAX_ROWS;
  const maxCols = (options && options.maxCols) || TABLE_MAX_COLS;

  const source = String(text === undefined || text === null ? '' : text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let totalCols = 0;
  let totalRows = 0;
  /** 记录这一行是不是「真有内容」——文件末尾的空行不算一行 */
  let touched = false;

  function endField() {
    row.push(field);
    field = '';
    touched = true;
  }

  function endRow() {
    // 纯空行（文件末尾多一个换行、或者中间夹了空行）不算一行 ——
    // 但「只有逗号」的那种要算（`a,` 是两列），所以用 touched 而不是「row 是不是空的」来判断
    if (!touched && field === '' && row.length === 0) {
      row = [];
      return;
    }
    endField();
    totalRows += 1;
    if (row.length > totalCols) totalCols = row.length;
    // 超了上限就别再往 rows 里塞（但还是要接着扫，好把总数数准）
    if (rows.length < maxRows) rows.push(row.length > maxCols ? row.slice(0, maxCols) : row);
    row = [];
    touched = false;
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      endField();
      continue;
    }
    if (ch === '\r') {
      // CRLF 和单独的 CR 都当换行
      if (source[i + 1] === '\n') i += 1;
      endRow();
      continue;
    }
    if (ch === '\n') {
      endRow();
      continue;
    }
    field += ch;
    touched = true;
  }

  // 最后一段：没有以换行结尾时还要收一下（纯空行就不算）
  if (touched || field !== '' || row.length) endRow();

  return {
    rows: rows,
    totalRows: totalRows,
    totalCols: totalCols,
    truncated: totalRows > maxRows || totalCols > maxCols
  };
}

/**
 * 把 CSV 的一行拼回文本（复制单元格用）。
 * 需要的时候给字段加引号，和 Excel 一个口径。
 */
export function formatCsvField(value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}
