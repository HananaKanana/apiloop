/**
 * cURL 命令解析器（前端自己实现，产出的是**请求**而不是 mock 路由）。
 *
 * 为什么不复用服务端的 `lib/importers.js`：那个 `curlToRoute` 是给「造 mock 路由」写的，
 * 会丢请求头、丢主机端口、把 JSON 拆成零散字段、把 `/users/42` 改成 `/users/:id`。
 * 这里要的是「把浏览器复制出来的 cURL 原样变成一次能发的请求」，所以另写一份。
 *
 * 支持两种复制格式：
 * - bash / zsh（Chrome「复制为 cURL」在 Mac 上给的）：单引号、双引号、`$'...'`、行尾 `\` 续行；
 * - Windows cmd（Chrome「复制为 cURL (cmd)」）：`^` 转义（`^"` 就是引号）、行尾 `^` 续行。
 */

/** 带值的参数：认得出，而且要用它的值 */
const VALUE_FLAGS = [
  '-X', '--request',
  '-H', '--header',
  '-A', '--user-agent',
  '-e', '--referer',
  '-b', '--cookie',
  '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode',
  '--json',
  '-F', '--form',
  '-u', '--user',
  '--url'
];

/** 带值但这里用不上：连值一起跳过，不要留下一个孤零零的值被当成地址 */
const SKIP_VALUE_FLAGS = [
  '-o', '--output',
  '-m', '--max-time', '--connect-timeout',
  '-w', '--write-out',
  '-x', '--proxy',
  '--retry', '--retry-delay',
  '--cacert', '--cert', '--key', '--cert-type', '--key-type',
  '-T', '--upload-file',
  '-c', '--cookie-jar',
  '-K', '--config',
  '-E', '--engine',
  '--interface', '--resolve', '--limit-rate', '--max-filesize'
];

/** 不带值的开关：直接忽略 */
const IGNORED_FLAGS = [
  '--compressed', '-k', '--insecure', '-L', '--location', '-s', '--silent',
  '-S', '--show-error', '-v', '--verbose', '-i', '--include', '-f', '--fail',
  '-g', '--globoff', '-n', '--netrc', '--netrc-optional', '-4', '-6',
  '--http1.0', '--http1.1', '--http2', '--http2-prior-knowledge', '--http3',
  '-#', '--progress-bar', '-N', '--no-buffer', '--raw', '--tlsv1.2', '--tlsv1.3',
  '-q', '--disable', '--no-keepalive', '-O', '--remote-name', '-J', '--remote-header-name'
];

const ANSI_ESCAPES = {
  n: '\n',
  t: '\t',
  r: '\r',
  '\\': '\\',
  "'": "'",
  '"': '"',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  0: '\0'
};

/** Windows cmd 的格式：出现 `^"`，或者行尾有个 `^` */
function isCmdStyle(text) {
  if (text.indexOf('^"') !== -1) return true;
  return /\^[ \t]*\r?\n/.test(text);
}

/**
 * `$'...'` 的 ANSI-C 转义。支持 `\n` `\t` `\r` `\\` `\'` `\"` `\xHH` `\uXXXX`，
 * 另外把八进制 `\0nnn` 也认了 —— 浏览器偶尔会用它。
 * @returns {{value: string, next: number}} next 指向收尾单引号之后
 */
function readAnsiC(text, start) {
  let out = '';
  let i = start;

  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") return { value: out, next: i + 1 };
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }

    const next = text[i + 1];
    if (next === undefined) {
      out += '\\';
      i += 1;
      continue;
    }

    if (next === 'x') {
      const hex = text.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        continue;
      }
    }

    if (next === 'u') {
      const hex = text.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
    }

    if (next === 'U') {
      const hex = text.slice(i + 2, i + 10);
      if (/^[0-9a-fA-F]{8}$/.test(hex)) {
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 10;
        continue;
      }
    }

    if (ANSI_ESCAPES[next] !== undefined) {
      out += ANSI_ESCAPES[next];
      i += 2;
      continue;
    }

    const octal = text.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
    if (octal) {
      out += String.fromCharCode(parseInt(octal[0], 8));
      i += 1 + octal[0].length;
      continue;
    }

    out += next;
    i += 2;
  }

  return { value: out, next: i };
}

// bash / zsh 的切词。引号可以贴在词中间，比如 -H 后面直接跟单引号，整个仍是一个词
function scanPosix(text) {
  const words = [];
  let current = null;

  function endWord() {
    if (current !== null) {
      words.push(current);
      current = null;
    }
  }

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      endWord();
      i += 1;
      continue;
    }

    if (current === null) current = '';

    // 行尾 \ 续行。放在引号判断之前，但只在引号外面才走这一支 ——
    // 单引号里的反斜杠是普通字符，不能吃掉
    if (ch === '\\' && text[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (ch === '\\' && text[i + 1] === '\r' && text[i + 2] === '\n') {
      i += 3;
      continue;
    }

    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end;
      current += text.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }

    if (ch === '$' && text[i + 1] === "'") {
      const result = readAnsiC(text, i + 2);
      current += result.value;
      i = result.next;
      continue;
    }

    if (ch === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && text[i + 1] === '\n') {
          i += 2;
          continue;
        }
        if (text[i] === '\\' && text[i + 1] !== undefined) {
          const next = text[i + 1];
          // 双引号里只有这四个转义有特殊含义，其余的反斜杠要原样留着
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            current += next;
          } else {
            current += '\\' + next;
          }
          i += 2;
          continue;
        }
        current += text[i];
        i += 1;
      }
      i += 1;
      continue;
    }

    if (ch === '\\' && text[i + 1] !== undefined) {
      current += text[i + 1];
      i += 2;
      continue;
    }

    current += ch;
    i += 1;
  }

  endWord();
  return words;
}

/**
 * cmd 格式是**两层**，必须分开处理：
 *
 * 1. cmd 自己先处理 `^` 转义（`^"` → `"`、`^&` → `&`、`^{` → `{`）和行尾 `^` 续行；
 * 2. 程序再按 Windows 的规则拆参数：`"` 是字符串的开始和结束，`\"` 是字面上的引号。
 *
 * 合成一层做的话，`^"` 会被当成字面上的引号字符，引号就永远起不到「包字符串」的作用，
 * 地址会变成 `http://"https//example.com/...` 这样（2026-10-01 审阅 B3）。
 */

/** 第一层：整段去掉 cmd 的 `^` 转义和行尾续行 */
function unescapeCmd(text) {
  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch !== '^') {
      out += ch;
      i += 1;
      continue;
    }

    const next = text[i + 1];
    if (next === undefined) {
      // 结尾孤零零一个 ^，丢掉
      i += 1;
      continue;
    }
    if (next === '\n') {
      i += 2;
      continue;
    }
    if (next === '\r' && text[i + 2] === '\n') {
      i += 3;
      continue;
    }

    out += next;
    i += 2;
  }

  return out;
}

/**
 * 第二层：Windows 的拆参数规则（和 CommandLineToArgvW 一致）。
 *
 * 反斜杠只对**紧跟其后的引号**有意义：
 * - 2n 个反斜杠 + `"` → n 个反斜杠，引号起作用（开关字符串）；
 * - 2n+1 个反斜杠 + `"` → n 个反斜杠 + 一个字面上的引号。
 * 后面不是引号时，反斜杠原样保留（Windows 上路径里的 `\` 不能吃掉）。
 */
function scanWindows(text) {
  const words = [];
  let current = null;
  let quoted = false;

  function endWord() {
    if (current !== null) {
      words.push(current);
      current = null;
    }
  }

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (!quoted && /\s/.test(ch)) {
      endWord();
      i += 1;
      continue;
    }

    if (current === null) current = '';

    if (ch === '\\') {
      let count = 0;
      while (text[i + count] === '\\') count += 1;

      if (text[i + count] === '"') {
        current += '\\'.repeat(Math.floor(count / 2));
        if (count % 2 === 1) current += '"';
        else quoted = !quoted;
        i += count + 1;
      } else {
        current += '\\'.repeat(count);
        i += count;
      }
      continue;
    }

    if (ch === '"') {
      quoted = !quoted;
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  endWord();
  return words;
}

/** curl 的 `--data-urlencode` 规则：有 `=` 就只编码值，没有就整段编码 */
function encodeDataUrlencoded(raw) {
  const eq = raw.indexOf('=');
  if (eq === -1) return encodeURIComponent(raw);
  return raw.slice(0, eq) + '=' + encodeURIComponent(raw.slice(eq + 1));
}

function decodePart(text) {
  try {
    return decodeURIComponent(String(text).replace(/\+/g, ' '));
  } catch (err) {
    return String(text);
  }
}

/** 按 lib/api/dto.js 的 toRows 造一行 */
function makeRow(key, value) {
  return {
    key: key,
    value: value === undefined || value === null ? '' : String(value),
    type: 'string',
    required: false,
    desc: '',
    enabled: true
  };
}

/** 按 lib/api/dto.js 的 toFormRows 造一行 */
function makeFormRow(key, value, kind, src) {
  return {
    key: key,
    value: value === undefined || value === null ? '' : String(value),
    type: 'string',
    required: false,
    desc: '',
    enabled: true,
    kind: kind || 'text',
    src: kind === 'file' ? (src || null) : null
  };
}

function headerValue(headers, name) {
  const target = String(name).toLowerCase();
  let found = '';
  headers.forEach(function (row) {
    if (String(row.key).toLowerCase() === target) found = String(row.value);
  });
  return found;
}

function setHeaderIfAbsent(headers, key, value) {
  if (headerValue(headers, key)) return;
  headers.push(makeRow(key, value));
}

/**
 * 解析一段 cURL 命令。
 *
 * @param {string} text
 * @returns {{name: string, method: string, url: string,
 *            params: {path: Array, query: Array, headers: Array},
 *            body: object, auth: object|null, warnings: string[]}}
 * @throws {Error} 解析失败时抛出可以直接给用户看的原因
 */
export function parseCurl(text) {
  const source = String(text === undefined || text === null ? '' : text).trim();
  if (!source) throw new Error('请粘贴 cURL 命令');

  if (!/^curl\b/.test(source)) {
    throw new Error('这段内容不是 cURL 命令（应该以 curl 开头）');
  }

  const words = isCmdStyle(source)
    ? scanWindows(unescapeCmd(source))
    : scanPosix(source);
  if (words.length < 2) throw new Error('这段 cURL 里没有地址');

  const warnings = [];
  const headers = [];
  const dataParts = [];
  const formRows = [];
  const urlCandidates = [];

  let method = '';
  let headOnly = false;
  let asQuery = false;
  let auth = null;
  let jsonFlag = false;

  let i = 1;
  while (i < words.length) {
    let arg = words[i];
    let inlineValue = null;

    if (arg.charAt(0) !== '-') {
      urlCandidates.push(arg);
      i += 1;
      continue;
    }

    // --flag=value
    const eq = arg.indexOf('=');
    if (arg.indexOf('--') === 0 && eq !== -1) {
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    } else if (arg.indexOf('--') !== 0 && arg.length > 2 && VALUE_FLAGS.indexOf(arg.slice(0, 2)) !== -1) {
      // 短参数连写：-XPOST、-H'Accept: */*'（引号已经被切词吃掉了）
      inlineValue = arg.slice(2);
      arg = arg.slice(0, 2);
    }

    /** 取这个参数的值：连写的就用连写的，否则吃下一个词 */
    function takeValue() {
      if (inlineValue !== null) return inlineValue;
      i += 1;
      return i < words.length ? words[i] : '';
    }

    if (IGNORED_FLAGS.indexOf(arg) !== -1) {
      i += 1;
      continue;
    }

    if (SKIP_VALUE_FLAGS.indexOf(arg) !== -1) {
      takeValue();
      i += 1;
      continue;
    }

    if (arg === '-X' || arg === '--request') {
      method = String(takeValue()).toUpperCase();
      i += 1;
      continue;
    }

    if (arg === '-I' || arg === '--head') {
      headOnly = true;
      i += 1;
      continue;
    }

    if (arg === '-G' || arg === '--get') {
      asQuery = true;
      i += 1;
      continue;
    }

    if (arg === '-H' || arg === '--header') {
      const raw = String(takeValue());
      i += 1;
      // 值是 `Name: value`；冒号后面的空格是分隔用的，要去掉。
      // HTTP/2 的伪头长这样：`:authority: a.com` —— 名字本身以冒号开头，
      // 所以第一个冒号不能当分隔符，得从第二个开始找。
      const colon = raw.indexOf(':', raw.charAt(0) === ':' ? 1 : 0);
      if (colon === -1) {
        warnings.push('请求头「' + raw + '」没有冒号，已跳过');
        continue;
      }
      headers.push(makeRow(raw.slice(0, colon).trim(), raw.slice(colon + 1).replace(/^ /, '')));
      continue;
    }

    if (arg === '-A' || arg === '--user-agent') {
      headers.push(makeRow('User-Agent', String(takeValue())));
      i += 1;
      continue;
    }

    if (arg === '-e' || arg === '--referer') {
      headers.push(makeRow('Referer', String(takeValue())));
      i += 1;
      continue;
    }

    if (arg === '-b' || arg === '--cookie') {
      headers.push(makeRow('Cookie', String(takeValue())));
      i += 1;
      continue;
    }

    if (arg === '-u' || arg === '--user') {
      const raw = String(takeValue());
      i += 1;
      const colon = raw.indexOf(':');
      auth = colon === -1
        ? { type: 'basic', username: raw, password: '' }
        : { type: 'basic', username: raw.slice(0, colon), password: raw.slice(colon + 1) };
      continue;
    }

    if (arg === '--url') {
      urlCandidates.push(String(takeValue()));
      i += 1;
      continue;
    }

    if (arg === '-F' || arg === '--form') {
      const raw = String(takeValue());
      i += 1;
      const eq2 = raw.indexOf('=');
      if (eq2 === -1) {
        warnings.push('表单字段「' + raw + '」没有等号，已跳过');
        continue;
      }
      const key = raw.slice(0, eq2);
      const value = raw.slice(eq2 + 1);
      if (value.charAt(0) === '@' || value.charAt(0) === '<') {
        // 文件行：路径交给用户自己选（src 留空）
        const path = value.slice(1).split(';')[0];
        formRows.push(makeFormRow(key, '', 'file', null));
        warnings.push('表单字段「' + key + '」来自本地文件 ' + path + '，请在请求体里选一次文件');
      } else {
        formRows.push(makeFormRow(key, value, 'text', null));
      }
      continue;
    }

    if (arg === '--json') {
      const raw = String(takeValue());
      i += 1;
      jsonFlag = true;
      dataParts.push(raw);
      continue;
    }

    if (arg === '--data-urlencode') {
      dataParts.push(encodeDataUrlencoded(String(takeValue())));
      i += 1;
      continue;
    }

    if (arg === '-d' || arg === '--data' || arg === '--data-raw' ||
        arg === '--data-binary' || arg === '--data-ascii') {
      const raw = String(takeValue());
      i += 1;
      if (raw.charAt(0) === '@') {
        throw new Error('请求体来自本地文件 ' + raw.slice(1) + '，请导入后手动粘贴内容');
      }
      dataParts.push(raw);
      continue;
    }

    // 认不出的参数：后面跟一个不像参数的词时，当成「带值的参数」一起跳过
    const nextWord = inlineValue === null ? words[i + 1] : undefined;
    if (inlineValue === null && nextWord !== undefined &&
        nextWord.charAt(0) !== '-' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(nextWord)) {
      warnings.push('跳过了不认识的参数 ' + arg + ' ' + nextWord);
      i += 2;
      continue;
    }

    warnings.push('跳过了不认识的参数 ' + arg);
    i += 1;
  }

  if (!urlCandidates.length) throw new Error('这段 cURL 里没有地址');

  /* ---------------- 地址 ---------------- */

  let rawUrl = urlCandidates[0];
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)) rawUrl = 'http://' + rawUrl;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new Error('地址不合法：' + urlCandidates[0]);
  }

  // 协议、主机、端口都要留着；路径原样，**不把数字段改成 :id**。
  // 查询串也要带上（审阅 B4）：这个页面的地址栏和查询参数表是双向同步的，
  // 地址里不带 ?a=1 的话，用户在地址栏改一个字就会把所有查询行清掉。
  const url = parsed.origin + parsed.pathname + parsed.search;

  const query = [];
  parsed.searchParams.forEach(function (value, key) {
    query.push(makeRow(key, value));
  });

  /* ---------------- 方法 ---------------- */

  const hasForm = formRows.length > 0;
  const hasData = dataParts.length > 0;

  let finalMethod = method;
  if (!finalMethod) {
    // -G 把数据变成查询参数，请求本身是 GET（有 -I 时是 HEAD）—— 审阅 B2
    if (headOnly) finalMethod = 'HEAD';
    else if (asQuery) finalMethod = 'GET';
    else if (hasForm || hasData) finalMethod = 'POST';
    else finalMethod = 'GET';
  }

  /* ---------------- 请求体 ---------------- */

  const dataText = dataParts.join('&');
  let body = { mode: 'none' };

  if (jsonFlag) {
    setHeaderIfAbsent(headers, 'Content-Type', 'application/json');
    setHeaderIfAbsent(headers, 'Accept', 'application/json');
  }

  const contentType = headerValue(headers, 'Content-Type').toLowerCase();

  if (asQuery && (hasData || hasForm)) {
    // -G：数据变成查询参数
    dataParts.join('&').split('&').forEach(function (pair) {
      if (!pair) return;
      const eq3 = pair.indexOf('=');
      const key = eq3 === -1 ? pair : pair.slice(0, eq3);
      const value = eq3 === -1 ? '' : pair.slice(eq3 + 1);
      if (key) query.push(makeRow(decodePart(key), decodePart(value)));
    });
    body = { mode: 'none' };
  } else if (hasForm) {
    body = { mode: 'formdata', form: formRows };
  } else if (hasData) {
    const looksJson = contentType.indexOf('json') !== -1;
    let parsesJson = false;
    try {
      JSON.parse(dataText);
      parsesJson = true;
    } catch (err) {
      parsesJson = false;
    }

    if (looksJson || parsesJson) {
      // **原文一字不改** —— 之前那版把 JSON 拆成一个个字段，嵌套结构全丢了
      body = { mode: 'raw', language: 'json', raw: dataText };
    } else if (contentType.indexOf('x-www-form-urlencoded') !== -1 ||
               /^[^=&]+=[^=&]*(&[^=&]+=[^=&]*)*$/.test(dataText)) {
      body = {
        mode: 'urlencoded',
        form: dataText.split('&').filter(Boolean).map(function (pair) {
          const eq4 = pair.indexOf('=');
          const key = eq4 === -1 ? pair : pair.slice(0, eq4);
          const value = eq4 === -1 ? '' : pair.slice(eq4 + 1);
          return makeRow(decodePart(key), decodePart(value));
        })
      };
    } else {
      body = {
        mode: 'raw',
        language: contentType.indexOf('xml') !== -1 ? 'xml' : 'text',
        raw: dataText
      };
    }
  }

  /* ---------------- 请求头收尾 ---------------- */

  const cleanHeaders = headers.filter(function (row) {
    const key = String(row.key).toLowerCase();
    // 名字为空的不是请求头（`-H ': x'` 这种写坏了的）
    if (!key) return false;
    if (key === 'content-length') return false;
    // HTTP/2 的伪头（`:authority` 这种）不能手写
    if (key.charAt(0) === ':') return false;
    return true;
  });

  /* ---------------- 名字 ---------------- */

  const segments = parsed.pathname.split('/').filter(Boolean);
  const last = segments.length ? segments[segments.length - 1] : '';
  const name = finalMethod + ' ' + (last || parsed.hostname);

  return {
    name: name,
    method: finalMethod,
    url: url,
    params: { path: [], query: query, headers: cleanHeaders },
    body: body,
    auth: auth,
    warnings: warnings
  };
}
