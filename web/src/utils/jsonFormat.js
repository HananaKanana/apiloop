/**
 * JSON 美化，**带 `{{变量}}` 和注释也能美化**。
 *
 * 分两步走，这个顺序很关键：
 *
 * 1. **只做校验。** 难点在于 `{"id": {{id}}}` 本身不是合法 JSON —— 变量的位置可能是个值、
 *    可能是个数组元素，直接 `JSON.parse` 必然报错。所以先把**字符串外面**的每个 `{{xxx}}`
 *    换成一个占位字符串 `"__APILOOP_VAR_<序号>__"`（带引号，放在任何位置都合法），
 *    再 parse 一次拿错误位置。占位符**只用于校验**，不参与输出。
 *
 *    注释和多余的逗号也在这一步抹平（请求体里可以写注释，发送时由服务端去掉，
 *    见 `lib/json-comments.js`）：注释换成**等长的空格**、换行保留，
 *    `}` / `]` 前多余的逗号也换成空格。**两步都是等长的**，所以报错的行列号
 *    仍然对着用户看到的那个字。
 *
 * 2. **重新排版。** 按词法把原文切成词（字符串、数字、`true`/`false`/`null`、`{{变量}}`、
 *    注释、标点），**每个词原样输出**，只在 `{ [ , :` 前后加换行和缩进。
 *
 * 为什么不用 `JSON.stringify` 输出（2026-10-01 审阅 B5）：
 * `JSON.parse` 会把数字转成双精度浮点，`12345678901234567890` 会被悄悄改成
 * `12345678901234567000` —— 后端常用的 19 位雪花 ID 一美化就变了，发出去的请求是错的，
 * 而且很难察觉。走词法输出的话，数字、字符串里的 `\uXXXX` 转义、变量、注释都一字不改。
 *
 * 顺带解决了 N1：占位符不再参与输出，正文里本来就有 `__APILOOP_VAR_0__` 这种字符串
 * 也不会被误替换。
 *
 * 字符串**里面**的 `{{xxx}}`、`//`、`/*` 都不用特殊处理 —— 它们本来就是字符串内容。
 */

const PLACEHOLDER = '__APILOOP_VAR_';

const LITERALS = ['true', 'false', 'null'];

const PUNCTUATION = '{}[],:';

/* ==================== 第一步：校验用的抹平 ==================== */

/**
 * 把注释抹成**等长的空格**（换行保留）。只用于校验，不参与输出。
 *
 * 等长是刻意的：报错的行列号要能直接对着原文，长度一变就对不上了（用户要求）。
 * 规则和服务端 `stripJsonComments` 一致：只看字符串外面。
 */
function blankComments(text) {
  let out = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (ch === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    // 行注释：吃到行尾，换行本身留着
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    // 块注释：吃到 */，里面的换行留着
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < text.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * 把 `}` / `]` 前多余的逗号抹成空格（同样等长）。
 * 把最后一个字段注释掉时很常见，留着它 JSON 就不合法。
 * 只看字符串外面 —— 而且要在 `blankComments` **之后**跑，这样注释挡在逗号和括号中间也算数。
 */
function blankTrailingCommas(text) {
  const chars = text.split('');
  let inString = false;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];

    if (inString) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch !== ',') continue;

    let j = i + 1;
    while (j < chars.length && /\s/.test(chars[j])) j += 1;
    if (chars[j] === '}' || chars[j] === ']') chars[i] = ' ';
  }

  return chars.join('');
}

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

/* ==================== 报错位置换算 ==================== */

/** V8 的报错尾巴（` at position 8 (line 1 column 9)`）要去掉，只留原因 */
function cleanReason(message) {
  return String(message)
    .replace(/\s*in JSON at position \d+[\s\S]*$/, '')
    .replace(/\s*at position \d+[\s\S]*$/, '')
    .replace(/^JSON\.parse:\s*/, '')
    .trim();
}

/** 行列号 → 偏移 */
function offsetOf(text, line, column) {
  let index = 0;
  let currentLine = 1;

  while (index < text.length && currentLine < line) {
    if (text[index] === '\n') currentLine += 1;
    index += 1;
  }
  return Math.min(index + Math.max(column - 1, 0), text.length);
}

/** 偏移 → 行列号 */
function lineColumnOf(text, position) {
  let line = 1;
  let column = 1;

  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line: line, column: column };
}

/**
 * 把 `JSON.parse` 报的位置换算成**原文**的行列号。
 *
 * `transformed` 是「抹平注释 + 抹平多余逗号 + 变量换占位符」之后的文本。前两步等长，
 * 只有占位符会改变长度，所以先按 edits 把偏移减回去，再在**原文**上数行列 ——
 * 这样报错位置永远对着用户看到的那个字。
 */
function locate(message, transformed, edits, source) {
  let position = null;

  const positionMatch = message.match(/position (\d+)/);
  if (positionMatch) {
    position = Number(positionMatch[1]);
  } else {
    const lineColumn = message.match(/line (\d+) column (\d+)/);
    if (lineColumn) {
      position = offsetOf(transformed, Number(lineColumn[1]), Number(lineColumn[2]));
    }
  }
  if (position === null) return null;

  edits.forEach(function (edit) {
    if (edit.replacedEnd <= position) {
      position += edit.originalLength - edit.replacedLength;
    }
  });

  return lineColumnOf(source, position);
}

/* ==================== 第二步：按词法重新排版 ==================== */

/**
 * 按词法切词。每个词的 `text` 都是**原文的切片**，一个字符都不改。
 *
 * 注释也切成词，并且记下它是不是「独占一行」：上一个词之后出现过换行就是独占一行
 * （缩进跟着所在层级走），否则是写在值后面的行尾注释（留在同一行）。
 *
 * @returns {Array<{type: string, text: string, ownLine?: boolean}>}
 */
function tokenizeJson(text) {
  const tokens = [];
  let i = 0;
  let sawNewline = false;

  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      if (ch === '\n') sawNewline = true;
      i += 1;
      continue;
    }

    // 行注释：到行尾（换行不属于注释）
    if (ch === '/' && text[i + 1] === '/') {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      tokens.push({ type: 'comment', text: text.slice(i, end), ownLine: sawNewline || tokens.length === 0 });
      sawNewline = false;
      i = end;
      continue;
    }

    // 块注释：到 */
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? text.length : close + 2;
      const raw = text.slice(i, stop);
      // 跨行的块注释也当独占一行：里面那个换行会把后面的排版带歪
      tokens.push({
        type: 'comment',
        text: raw,
        ownLine: sawNewline || tokens.length === 0 || raw.indexOf('\n') !== -1
      });
      sawNewline = false;
      i = stop;
      continue;
    }

    // {{变量}}：要排在 `{` 标点前面判断
    if (ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2);
      if (end !== -1) {
        tokens.push({ type: 'var', text: text.slice(i, end + 2) });
        sawNewline = false;
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
      sawNewline = false;
      i = stop;
      continue;
    }

    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const matched = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (matched) {
        tokens.push({ type: 'number', text: matched[0] });
        sawNewline = false;
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
      sawNewline = false;
      i += literal.length;
      continue;
    }

    if (PUNCTUATION.indexOf(ch) !== -1) {
      tokens.push({ type: ch, text: ch });
      sawNewline = false;
      i += 1;
      continue;
    }

    // 认不出来的字符原样吐出去。走到这里说明校验那一步已经拦下了，正常不会发生
    tokens.push({ type: 'raw', text: ch });
    sawNewline = false;
    i += 1;
  }

  return tokens;
}

/** 某个左括号后面紧跟着它的右括号（空对象 / 空数组，排版时保持一行） */
function isEmptyPair(open, close) {
  return (open.type === '{' && close.type === '}') || (open.type === '[' && close.type === ']');
}

/**
 * 重新排版：词本身不动，只在结构符号前后加换行和缩进。
 *
 * 注释按 `ownLine` 决定位置：独占一行的换行 + 缩进到当前层级；行尾注释前面补一个空格、
 * 留在同一行。
 *
 * 实现上不直接「算前一个词是什么」，而是记着**欠了下一个词什么**（换行还是空格）：
 * 行尾注释只是「借住」在当前这一行，它把欠的换行留给下一个词 ——
 * 否则 `1, // 注` 后面的字段会被拼到注释尾巴上去。
 */
function renderTokens(tokens, indent) {
  const unit = ' '.repeat(indent);
  let out = '';
  let depth = 0;
  let pendingBreak = false;
  let pendingSpace = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : null;
    const next = tokens[i + 1];

    const isOpen = token.type === '{' || token.type === '[';
    const isClose = token.type === '}' || token.type === ']';
    const emptyPair = Boolean(prev) && isEmptyPair(prev, token);

    // 收尾括号先缩回一级，后面算它自己的缩进用这个值
    if (isClose && !emptyPair) depth -= 1;

    let need = 'none';
    if (prev) {
      if (isClose && !emptyPair) need = 'break';
      else if (token.type === 'comment') need = token.ownLine ? 'break' : 'space';
      else if (pendingBreak) need = 'break';
      else if (pendingSpace) need = 'space';
    }

    if (need === 'break') out += '\n' + unit.repeat(Math.max(depth, 0));
    else if (need === 'space') out += ' ';

    out += token.text;

    if (isOpen) {
      const empty = Boolean(next) && isEmptyPair(token, next);
      if (!empty) depth += 1;
      pendingBreak = !empty;
      pendingSpace = false;
      continue;
    }

    if (isClose) {
      pendingBreak = false;
      pendingSpace = false;
      continue;
    }

    if (token.type === ',') {
      pendingBreak = true;
      pendingSpace = false;
      continue;
    }

    if (token.type === ':') {
      pendingBreak = false;
      pendingSpace = true;
      continue;
    }

    if (token.type === 'comment') {
      if (token.ownLine) {
        pendingBreak = true;
        pendingSpace = false;
      } else {
        // 行尾注释：本来欠的换行不动，留给下一个词
        pendingSpace = true;
      }
      continue;
    }

    pendingBreak = false;
    pendingSpace = false;
  }

  return out;
}

/* ==================== 对外 ==================== */

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

  // 第一步：只校验。抹平注释和多余的逗号（都等长），再把变量换成占位符
  const blanked = blankTrailingCommas(blankComments(source));

  // 整段只有注释（或者注释加空白）：没有结构可排，原样还回去
  if (!blanked.trim()) return { ok: true, text: source.trim() };

  const extracted = extractVariables(blanked);
  try {
    JSON.parse(extracted.text);
  } catch (err) {
    const reason = cleanReason(err.message) || '不是合法的 JSON';
    const spot = locate(err.message, extracted.text, extracted.edits, source);
    return {
      ok: false,
      error: spot ? '第 ' + spot.line + ' 行第 ' + spot.column + ' 列：' + reason : reason
    };
  }

  // 第二步：按词法重新排版，每个词原样输出（注释保留，多余逗号也保留）
  return { ok: true, text: renderTokens(tokenizeJson(source), size) };
}
