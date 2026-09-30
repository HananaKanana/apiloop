/**
 * 把一次 WebSocket 调试会话的消息日志整理成 mock 回放场景（契约第 17 节）。
 *
 * 规则：
 * - 第一次发出消息**之前**收到的消息，放进 `onOpen`；
 * - 之后每一条**发出**的消息生成一条规则，`reply` 是它之后、下一条发出的消息之前收到的全部消息；
 * - 二进制消息跳过，并告诉调用方跳过了几条；
 * - `delay` 是「和上一条之间的间隔」：`onOpen` 的第一条相对 `open` 事件，
 *   每条 `reply` 的第一条相对触发它的那条发出消息，之后都相对上一条。
 *
 * 纯函数，不碰网络也不碰 store，方便单独核对。
 */

/** 收到的消息按 `any` 规则处理时，回放侧只认文本；这里只挑文本消息 */
function textMessages(events) {
  const list = [];
  let skipped = 0;

  (events || []).forEach(function (event) {
    if (!event || event.type !== 'message') return;
    if (event.base64) {
      skipped += 1;
      return;
    }
    list.push({
      direction: event.direction,
      text: String(event.text === undefined || event.text === null ? '' : event.text),
      time: event.time
    });
  });

  return { list: list, skipped: skipped };
}

export function buildWsScenario(events) {
  const openEvent = (events || []).find(function (event) {
    return event && event.type === 'open';
  });

  const parsed = textMessages(events);
  const messages = parsed.list;

  const onOpen = [];
  const rules = [];
  let currentRule = null;

  // 第一条 onOpen 相对 open 事件；没有 open 事件（比如日志被清过）就相对第一条消息
  let previousTime = openEvent ? openEvent.time : (messages[0] ? messages[0].time : Date.now());

  messages.forEach(function (message) {
    const delay = Math.max(0, Math.round(message.time - previousTime));
    previousTime = message.time;

    if (message.direction === 'out') {
      currentRule = { match: { type: 'equals', value: message.text }, reply: [] };
      rules.push(currentRule);
      return;
    }

    const step = { delay: delay, send: message.text };
    if (currentRule) currentRule.reply.push(step);
    else onOpen.push(step);
  });

  return {
    // 录到的都是「发什么回什么」的确定对应，所以没有匹配上的消息一律不回。
    // echo 会把客户端自己发的内容打回去，那不是录下来的行为。
    scenario: { onOpen: onOpen, rules: rules, fallback: 'none' },
    pushed: onOpen.length,
    ruleCount: rules.length,
    skipped: parsed.skipped
  };
}
