/**
 * JSON 美化，**带 `{{变量}}` 也能美化**。
 *
 * 分两步走，这个顺序很关键：
 *
 * 1. **只做校验。** 难点在于 `{"id": {{id}}}` 本身不是合法 JSON —— 变量的位置可能是个值、
 *    可能是个数组元素，直接 `JSON.parse` 必然报错。所以先把**字符串外面**的每个 `{{xxx}}`
 *    换成一个占位字符串 `"__APILOOP_VAR_<序号>__"`（带引号，放在任何位置都合法），
 *    再 parse 一次拿错误位置。占位符**只用于校验**，不参与输出。
 * 2. **重新排版。** 按词法把原文切成词（字符串、数字、`true`/`false`/`null`、`{{变量}}`、标点），
 *    **每个词原样输出**，只在 `{ [ , :` 前后加换行和缩进。
 *
 * 为什么不用 `JSON.stringify` 输出（2026-10-01 审阅 B5）：
 * `JSON.parse` 会把数字转成双精度浮点，`12345678901234567890` 会被悄悄改成
 * `12345678901234567000` —— 后端常用的 19 位雪花 ID 一美化就变了，发出去的请求是错的，
 * 而且很难察觉。走词法输出的话，数字、字符串里的 `\uXXXX` 转义、变量都一字不改。
 *
 * 顺带解决了 N1：占位符不再参与输出，正文里本来就有 `__APILOOP_VAR_0__` 这种字符串
 * 也不会被误替换。
 *
 * 字符串**里面**的 `{{xxx}}` 不用特殊处理 —— 它本来就是合法的字符串内容（`"{{name}}"`）。
 */

const PLACEHOLDER = '__APILOOP_VAR_';

const LITERALS = ['true', 'false', 'null'];

const PUNCTUATION = '{}[],:';

/**
 * 把字符串外面的 `{{...}}` 换成占位符。**只用于校验**，不参与输出。
 * 顺便记下每一处替换前后的位置和长度，报错的行列号要据此从「替换后的文本」映射回原文。
 */
function extractVariables(text) {
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
        const replacement = '"' + PLACEHOLDER + edits.length + '__"';

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

  return { text: out, edits: edits };
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
 * 按词法切词。每个词的 `text` 都是**原文的切片**，一个字符都不改。
 * @returns {Array<{type: string, text: string}>}
 */
function tokenizeJson(text) {
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // {{变量}}：要排在 `{` 标点前面判断
    if (ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2);
      if (end !== -1) {
        tokens.push({ type: 'var', text: text.slice(i, end + 2) });
        i = end + 2;
        continue;
      }
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '"') break;
        j += 1;
      }
      const stop = Math.min(j + 1, text.length);
      tokens.push({ type: 'string', text: text.slice(i, stop) });
      i = stop;
      continue;
    }

    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const matched = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (matched) {
        tokens.push({ type: 'number', text: matched[0] });
        i += matched[0].length;
        continue;
      }
    }

    let literal = null;
    for (let k = 0; k < LITERALS.length; k++) {
      if (text.startsWith(LITERALS[k], i)) {
        literal = LITERALS[k];
        break;
      }
    }
    if (literal) {
      tokens.push({ type: 'literal', text: literal });
      i += literal.length;
      continue;
    }

    if (PUNCTUATION.indexOf(ch) !== -1) {
      tokens.push({ type: ch, text: ch });
      i += 1;
      continue;
    }

    // 认不出来的字符原样吐出去。走到这里说明校验那一步已经拦下了，正常不会发生
    tokens.push({ type: 'raw', text: ch });
    i += 1;
  }

  return tokens;
}

/** 某个左括号后面紧跟着它的右括号（空对象 / 空数组，排版时保持一行） */
function isEmptyPair(open, close) {
  return (open.type === '{' && close.type === '}') || (open.type === '[' && close.type === ']');
}

/** 重新排版：词本身不动，只在结构符号前后加换行和缩进 */
function renderTokens(tokens, indent) {
  const unit = ' '.repeat(indent);
  let out = '';
  let depth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const prev = tokens[i - 1];

    if (token.type === '{' || token.type === '[') {
      out += token.text;
      const next = tokens[i + 1];
      if (!(next && isEmptyPair(token, next))) {
        depth += 1;
        out += '\n' + unit.repeat(depth);
      }
      continue;
    }

    if (token.type === '}' || token.type === ']') {
      if (!(prev && isEmptyPair(prev, token))) {
        depth -= 1;
        out += '\n' + unit.repeat(Math.max(depth, 0));
      }
      out += token.text;
      continue;
    }

    if (token.type === ',') {
      out += token.text + '\n' + unit.repeat(depth);
      continue;
    }

    if (token.type === ':') {
      out += token.text + ' ';
      continue;
    }

    out += token.text;
  }

  return out;
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

  // 第一步：只校验（占位符不参与输出）
  const extracted = extractVariables(source);
  try {
    JSON.parse(extracted.text);
  } catch (err) {
    const reason = cleanReason(err.message) || '不是合法的 JSON';
    const spot = locate(err.message, extracted.text, extracted.edits);
    return {
      ok: false,
      error: spot ? '第 ' + spot.line + ' 行第 ' + spot.column + ' 列：' + reason : reason
    };
  }

  // 第二步：按词法重新排版，每个词原样输出
  return { ok: true, text: renderTokens(tokenizeJson(source), size) };
}
