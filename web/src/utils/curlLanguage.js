import { StreamLanguage } from '@codemirror/language';

/**
 * cURL 命令的语法高亮（代码片段面板用）。
 *
 * CodeMirror 没有现成的 shell 语法包，也不值得为一个只读面板引一个进来，所以这里用
 * `StreamLanguage` 写一个够用的小分词器，配色沿用响应 Body 那一套（`CodeEditor.vue` 里的 tok-* 类）：
 *
 * - `curl` 和 `--header` / `-H` / `--data-raw` 这些选项：关键字（紫）；
 * - 请求头 `'Authorization: Bearer …'`：头名（橙）+ 值（蓝）；
 * - 请求体是 JSON 时（引号里以 `{` / `[` 开头）：键名、字符串、数字、true / null 分别上色，
 *   和 Body 里看到的一样；不是 JSON 的就整段当字符串；
 * - 行尾的 `\` 续行符：淡一点。
 *
 * 引号里的内容可以跨好几行（请求体），所以「在不在引号里」「引号里是什么」都放在 state 里，
 * StreamLanguage 会把它带到下一行。
 */

const HEADER_OPTIONS = ['-H', '--header'];

function startState() {
  return {
    /** 当前在哪种引号里（`'` / `"`），不在引号里是空串 */
    quote: '',
    /** 引号里是什么：header（请求头）/ auto（还没看出来）/ json / plain */
    mode: '',
    /** 请求头的冒号过了没有（冒号前是头名，后面是值） */
    headerDone: false,
    /** 上一个选项（决定紧跟着的引号里是请求头还是别的） */
    lastOption: ''
  };
}

function tokenOutside(stream, state) {
  if (stream.eatSpace()) return null;

  // 续行符
  if (stream.match(/^\\$/)) return 'meta';

  if (stream.match(/^curl(?=\s|$)/)) return 'keyword';

  const option = stream.match(/^--?[A-Za-z][\w-]*/);
  if (option) {
    state.lastOption = option[0];
    return 'keyword';
  }

  const ch = stream.peek();
  if (ch === "'" || ch === '"') {
    stream.next();
    state.quote = ch;
    state.mode = HEADER_OPTIONS.indexOf(state.lastOption) > -1 ? 'header' : 'auto';
    state.headerDone = false;
    state.lastOption = '';
    return 'string';
  }

  // 没加引号的一段（地址之类）
  stream.match(/^[^\s'"]+/);
  state.lastOption = '';
  return 'string';
}

function tokenJson(stream, state) {
  if (stream.eatSpace()) return null;

  const ch = stream.peek();
  if (ch === state.quote) return null; // 交给外层收尾

  if (ch === '"') {
    stream.next();
    let escaped = false;
    let next;
    while ((next = stream.next()) != null) {
      if (next === '"' && !escaped) break;
      escaped = !escaped && next === '\\';
    }
    // 后面紧跟冒号的是键名
    return stream.match(/^\s*:/, false) ? 'propertyName' : 'string';
  }

  if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return 'number';
  if (stream.match(/^(true|false|null)\b/)) return 'atom';
  if (stream.match(/^[{}[\]]/)) return 'bracket';
  if (stream.match(/^[,:]/)) return 'punctuation';

  stream.next();
  return null;
}

function tokenInside(stream, state) {
  // 引号收尾
  if (stream.peek() === state.quote) {
    stream.next();
    state.quote = '';
    state.mode = '';
    return 'string';
  }

  if (state.mode === 'header') {
    if (!state.headerDone) {
      if (stream.match(new RegExp('^[^:' + state.quote + ']+(?=:)'))) return 'attributeName';
      if (stream.eat(':')) {
        state.headerDone = true;
        return 'punctuation';
      }
      state.headerDone = true;
    }
    stream.match(new RegExp('^[^' + state.quote + ']+'));
    return 'string';
  }

  if (state.mode === 'auto') {
    if (stream.eatSpace()) return null;
    const ch = stream.peek();
    state.mode = ch === '{' || ch === '[' ? 'json' : 'plain';
  }

  if (state.mode === 'json') return tokenJson(stream, state);

  // 普通字符串：吃到引号或行尾
  if (!stream.match(new RegExp('^[^' + state.quote + ']+'))) stream.next();
  return 'string';
}

export const curlLanguage = StreamLanguage.define({
  name: 'curl',
  startState: startState,
  copyState: function (state) { return Object.assign({}, state); },
  token: function (stream, state) {
    return state.quote ? tokenInside(stream, state) : tokenOutside(stream, state);
  }
});
