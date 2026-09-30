/**
 * SSE（text/event-stream）的增量解析。
 *
 * 只做「把陆续到达的文本片段切成一个个事件」这件事，不管网络：片段来自 fetch 的
 * ReadableStream，一行也可能被切在两次 read() 之间，所以这里自己攒 buffer，
 * 遇到换行才处理（和 stream.js 里解析 NDJSON 是同一个套路）。
 *
 * 规则按 SSE 规范（HTML Standard 的 server-sent events 一节）：
 * - 空行分隔事件；
 * - 行是 `字段: 值`，冒号后面最多去掉一个空格；没有冒号时整行是字段名、值是空串；
 * - `data` 可以出现多次，用 `\n` 拼起来；
 * - 以 `:` 开头的是注释行（常见的心跳包），不产生事件。
 *
 * 和规范不一样的两处，都是因为这是给人看的调试视图：
 * - 一个块里只有注释时不产生事件，否则心跳会把表格刷满；
 * - 流结束时没等到空行的半截事件照样抛出来，方便判断「是不是被切断了」。
 */
export function createSseParser(onEvent) {
  let buffer = '';
  let dataLines = [];
  let eventName = '';
  let lastId = '';

  function reset() {
    dataLines = [];
    eventName = '';
  }

  function dispatch() {
    // 空行分隔出来的空块（连着两个空行）不算事件
    if (!dataLines.length && !eventName) return;
    onEvent({
      event: eventName || 'message',
      data: dataLines.join('\n'),
      id: lastId
    });
  }

  function stripCr(line) {
    return line.charAt(line.length - 1) === '\r' ? line.slice(0, -1) : line;
  }

  function handleLine(line) {
    if (line === '') {
      dispatch();
      reset();
      return;
    }
    if (line.charAt(0) === ':') return;

    const colon = line.indexOf(':');
    let field = line;
    let value = '';
    if (colon !== -1) {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charAt(0) === ' ') value = value.slice(1);
    }

    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
    else if (field === 'id') lastId = value;
    // retry 和自定义字段用不上，忽略
  }

  return {
    /** 喂一段新到的文本 */
    push: function (text) {
      if (!text) return;
      buffer += text;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(stripCr(line));
        index = buffer.indexOf('\n');
      }
    },

    /** 流结束：把没等到空行的尾巴也放出来 */
    end: function () {
      if (buffer) {
        const line = buffer;
        buffer = '';
        handleLine(stripCr(line));
      }
      dispatch();
      reset();
    }
  };
}
