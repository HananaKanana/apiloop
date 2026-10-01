/**
 * JSON 美化，**带 `{{变量}}` 也能美化**。
 *
 * 难点在于 `{"id": {{id}}}` 本身不是合法 JSON —— 变量的位置可能是个值、可能是个数组元素，
 * 直接 `JSON.parse` 必然报错。做法是：
 *
 * 1. 把**字符串外面**的每个 `{{xxx}}` 换成一个占位字符串 `"__APILOOP_VAR_<序号>__"`
 *    （带引号，这样它在任何位置都是合法的 JSON 值）；
 * 2. 正常 parse + stringify 排版；
 * 3. 再把带引号的占位换回 `{{xxx}}`。
 *
 * 字符串**里面**的 `{{xxx}}` 不用管 —— 它本来就是合法的字符串内容（`"{{name}}"`）。
 */

const PLACEHOLDER = '__APILOOP_VAR_';

/**
 * 把字符串外面的 `{{...}}` 换成占位符。
 * 顺便记下每一处替换前后的位置和长度，报错的行列号要据此从「替换后的文本」映射回原文。
 */
function extractVariables(text) {
  const variables = [];
  const edits = [];
  let out = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const ch = text[i];

    if (inString) {
      if (ch === '\\') {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2);
      if (end !== -1) {
        const original = text.slice(i, end + 2);
        const index = variables.length;
        const replacement = '"' + PLACEHOLDER + index + '__"';

        variables.push(original);
        edits.push({
          originalStart: i,
          originalLength: original.length,
          replacedEnd: out.length + replacement.length,
          replacedLength: replacement.length
        });

        out += replacement;
        i = end + 2;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return { text: out, variables: variables, edits: edits };
}

/** 把占位符换回变量。注意只认带引号的形态，字符串里面原本就有同名文本时不会误伤 */
function restoreVariables(text, variables) {
  return text.replace(/"__APILOOP_VAR_(\d+)__"/g, function (match, index) {
    const value = variables[Number(index)];
    return value === undefined ? match : value;
  });
}

/** V8 的报错尾巴（` at position 8 (line 1 column 9)`）要去掉，只留原因 */
function cleanReason(message) {
  return String(message)
    .replace(/\s*in JSON at position \d+[\s\S]*$/, '')
    .replace(/\s*at position \d+[\s\S]*$/, '')
    .replace(/^JSON\.parse:\s*/, '')
    .trim();
}

/**
 * 报错位置 → 行列号。
 *
 * 位置是**替换后**的文本里的偏移，要减掉前面那些替换带来的长度差，才对应回用户看到的原文。
 * （占位符里没有换行，所以行号本来就是对的，只有列号会漂。）
 */
function locate(message, replacedText, edits) {
  const lineColumn = message.match(/line (\d+) column (\d+)/);
  if (lineColumn) {
    return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  }

  const positionMatch = message.match(/position (\d+)/);
  if (!positionMatch) return null;

  let position = Number(positionMatch[1]);
  edits.forEach(function (edit) {
    if (edit.replacedEnd <= position) {
      position += edit.originalLength - edit.replacedLength;
    }
  });

  let line = 1;
  let column = 1;
  for (let i = 0; i < position && i < replacedText.length; i++) {
    if (replacedText[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line: line, column: column };
}

/**
 * @param {string} text
 * @param {number} [indent] 缩进空格数，默认 2
 * @returns {{ok: true, text: string} | {ok: false, error: string}}
 *          失败时 error 形如「第 3 行第 5 列：Expected ...」
 */
export function formatJson(text, indent) {
  const source = String(text === undefined || text === null ? '' : text);
  if (!source.trim()) return { ok: true, text: '' };

  const size = typeof indent === 'number' && indent >= 0 ? indent : 2;
  const extracted = extractVariables(source);

  let parsed;
  try {
    parsed = JSON.parse(extracted.text);
  } catch (err) {
    const reason = cleanReason(err.message) || '不是合法的 JSON';
    const spot = locate(err.message, extracted.text, extracted.edits);
    return {
      ok: false,
      error: spot ? '第 ' + spot.line + ' 行第 ' + spot.column + ' 列：' + reason : reason
    };
  }

  const pretty = JSON.stringify(parsed, null, size);
  return { ok: true, text: restoreVariables(pretty, extracted.variables) };
}
