import { TABLE_MAX_COLS, TABLE_MAX_ROWS } from '@/utils/responseFile';

/**
 * xlsx 解析（T39）。
 *
 * **不加新依赖**：用 `fflate`（按需 `import()`，不进首屏包）解开 zip，再自己扫
 * `xl/workbook.xml`、`xl/_rels/workbook.xml.rels`、`xl/sharedStrings.xml`、
 * `xl/worksheets/sheetN.xml`。
 *
 * 不引 DOM 解析器（`DOMParser` 在 SSR / Node 里没有），用一个够用的标签扫描：
 * xlsx 里的 XML 是 Excel 自己生成的，格式很规整，没有注释、没有 CDATA、没有自定义实体。
 *
 * 支持的单元格类型（需求里点名的那几种）：共享字符串（`t="s"`）、内联字符串
 * （`t="inlineStr"`）、数字（不写 `t`）、布尔值（`t="b"`）。日期只显示原始数字，
 * 公式单元格显示缓存值（`<v>` 里的那个，`t="str"` 时是字符串）。
 */

const SHARED_STRINGS = 'xl/sharedStrings.xml';
const WORKBOOK = 'xl/workbook.xml';
const WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels';

/** XML 里那几个实体。`&#xNN;` / `&#NN;` 也认 */
function unescapeXml(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, function (whole, hex) { return String.fromCodePoint(parseInt(hex, 16)); })
    .replace(/&#(\d+);/g, function (whole, dec) { return String.fromCodePoint(Number(dec)); })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 从一个开标签里取属性值（单双引号都认） */
function attr(tag, name) {
  const match = new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"').exec(tag) ||
    new RegExp("\\s" + name + "\\s*=\\s*'([^']*)'").exec(tag);
  return match ? unescapeXml(match[1]) : '';
}

/** 把一段 XML 里所有 `<t ...>文字</t>` 拼起来（共享字符串的 `<si>` 里可能有多个 `<r>`） */
function textOfRuns(xml) {
  let out = '';
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let match = re.exec(xml);
  while (match) {
    out += unescapeXml(match[1]);
    match = re.exec(xml);
  }
  return out;
}

/** `A1` / `AB12` → 列下标（从 0 开始） */
export function columnIndex(ref) {
  const letters = /^([A-Za-z]+)/.exec(String(ref || ''));
  if (!letters) return 0;
  let index = 0;
  const text = letters[1].toUpperCase();
  for (let i = 0; i < text.length; i++) {
    index = index * 26 + (text.charCodeAt(i) - 64);
  }
  return index - 1;
}

/** `xl/worksheets/sheet1.xml` 这种相对路径拼到 `xl/` 下（`../` 也处理一下） */
function resolvePath(base, target) {
  if (!target) return '';
  if (target.charAt(0) === '/') return target.slice(1);
  const parts = (base + '/' + target).split('/');
  const out = [];
  parts.forEach(function (part) {
    if (!part || part === '.') return;
    if (part === '..') out.pop();
    else out.push(part);
  });
  return out.join('/');
}

/** 工作簿里每个工作表的名字和它对应的 xml 路径（按 workbook.xml 里的顺序） */
function readSheetList(workbookXml, relsXml) {
  const rels = {};
  const relRe = /<Relationship\b[^>]*\/?>/g;
  let rel = relRe.exec(relsXml);
  while (rel) {
    const id = attr(rel[0], 'Id');
    const target = attr(rel[0], 'Target');
    if (id) rels[id] = resolvePath('xl', target);
    rel = relRe.exec(relsXml);
  }

  const list = [];
  const sheetRe = /<sheet\b[^>]*\/?>/g;
  let sheet = sheetRe.exec(workbookXml);
  while (sheet) {
    const name = attr(sheet[0], 'name');
    // `r:id` 的命名空间前缀各家不一样（r / rel），所以按「以 :id 结尾」找
    const idMatch = /\s[\w-]*:id\s*=\s*"([^"]*)"/.exec(sheet[0]);
    const id = idMatch ? idMatch[1] : '';
    if (name) list.push({ name: name, path: rels[id] || '' });
    sheet = sheetRe.exec(workbookXml);
  }
  return list;
}

/** 把一张工作表扫成二维字符串数组 */
function readSheet(xml, shared, options) {
  const maxRows = (options && options.maxRows) || TABLE_MAX_ROWS;
  const maxCols = (options && options.maxCols) || TABLE_MAX_COLS;

  const rows = [];
  let totalRows = 0;
  let totalCols = 0;

  const rowRe = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
  let rowMatch = rowRe.exec(xml);
  while (rowMatch) {
    const inner = rowMatch[3] || '';
    const cells = [];
    let rowWidth = 0;

    const cellRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch = cellRe.exec(inner);
    while (cellMatch) {
      const tag = '<c' + cellMatch[1] + '>';
      const body = cellMatch[3] || '';
      const ref = attr(tag, 'r');
      const type = attr(tag, 't');
      const at = ref ? columnIndex(ref) : rowWidth;
      if (at >= maxCols) {
        if (at + 1 > totalCols) totalCols = at + 1;
        rowWidth = at + 1;
        cellMatch = cellRe.exec(inner);
        continue;
      }

      let value = '';
      if (type === 'inlineStr') {
        value = textOfRuns(body);
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        const raw = v ? unescapeXml(v[1]) : '';
        if (type === 's') {
          const index = Number(raw);
          value = shared[index] === undefined ? '' : shared[index];
        } else if (type === 'b') {
          value = raw === '1' ? 'TRUE' : 'FALSE';
        } else {
          // 数字、公式的缓存值（t="str" 时 raw 就是字符串）、日期（需求里说显示原始数字）
          value = raw;
        }
      }

      while (cells.length < at) cells.push('');
      cells[at] = value;
      rowWidth = cells.length;
      cellMatch = cellRe.exec(inner);
    }

    totalRows += 1;
    if (rowWidth > totalCols) totalCols = rowWidth;
    if (rows.length < maxRows) rows.push(cells);

    rowMatch = rowRe.exec(xml);
  }

  return {
    rows: rows,
    totalRows: totalRows,
    totalCols: totalCols,
    truncated: totalRows > maxRows || totalCols > maxCols
  };
}

/**
 * 解析一个 xlsx。
 *
 * @param {Uint8Array} bytes
 * @param {{maxRows?: number, maxCols?: number}} [options]
 * @returns {Promise<{sheets: Array<{name: string, rows: string[][], totalRows: number,
 *           totalCols: number, truncated: boolean}>}>}
 * @throws 不是 xlsx（解不开、没有 workbook.xml）时抛错，调用方显示「解析失败」
 */
export async function parseXlsx(bytes, options) {
  const fflate = await import('fflate');

  let files;
  try {
    files = fflate.unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch (err) {
    throw new Error('unzip failed');
  }

  const workbookXml = files[WORKBOOK] ? fflate.strFromU8(files[WORKBOOK]) : '';
  if (!workbookXml) throw new Error('not a workbook');

  const relsXml = files[WORKBOOK_RELS] ? fflate.strFromU8(files[WORKBOOK_RELS]) : '';
  const shared = [];
  if (files[SHARED_STRINGS]) {
    const xml = fflate.strFromU8(files[SHARED_STRINGS]);
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let match = re.exec(xml);
    while (match) {
      shared.push(textOfRuns(match[1]));
      match = re.exec(xml);
    }
  }

  const sheets = [];
  readSheetList(workbookXml, relsXml).forEach(function (item, index) {
    // 关系表里没有的话按约定俗成的路径兜一下
    const path = item.path || 'xl/worksheets/sheet' + (index + 1) + '.xml';
    const xml = files[path] ? fflate.strFromU8(files[path]) : '';
    const parsed = xml
      ? readSheet(xml, shared, options)
      : { rows: [], totalRows: 0, totalCols: 0, truncated: false };
    sheets.push(Object.assign({ name: item.name }, parsed));
  });

  if (!sheets.length) throw new Error('no sheets');
  return { sheets: sheets };
}
