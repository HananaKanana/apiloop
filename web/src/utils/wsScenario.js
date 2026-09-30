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
 * 两处按契约的上限做了截断（不截的话服务端会直接 400，整个场景存不下去）：
 * - `delay` 超过 60 秒的按 60 秒算，并统计截断了几处；
 * - 步骤总数超过 1000 的只保留前 1000 步。
 *
 * 纯函数，不碰网络也不碰 store，方便单独核对。
 */

import { MAX_REPLAY_STEPS, clampReplayDelay } from './replay';

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
  /** 发出的文本 → 第一条规则。用来认出重复的发送消息（N1） */
  const ruleByText = new Map();

  let currentRule = null;
  /** 当前收到的消息属于「被丢掉的重复规则」，一起丢掉，别漏进 onOpen */
  let skipReplies = false;
  let steps = 0;
  let cappedDelays = 0;
  let truncated = 0;
  let duplicates = 0;

  // 第一条 onOpen 相对 open 事件；没有 open 事件（比如日志被清过）就相对第一条消息
  let previousTime = openEvent ? openEvent.time : (messages[0] ? messages[0].time : Date.now());

  messages.forEach(function (message) {
    // 到上限了：后面的消息一律不再产生步骤和规则，只数还有多少步没保留。
    // 放在最前面，这样「截断了多少处 delay」统计的是真的被保留的那些消息。
    if (steps >= MAX_REPLAY_STEPS) {
      if (message.direction !== 'out') truncated += 1;
      return;
    }

    const clamped = clampReplayDelay(message.time - previousTime);
    previousTime = message.time;
    if (clamped.capped) cappedDelays += 1;

    if (message.direction === 'out') {
      // 同一段文本发过两次的话，第二条规则永远匹配不到（「第一条匹配上的生效」），
      // 它的回复也回放不出来，所以整条丢掉，只留第一条，并在预览里说明
      if (ruleByText.has(message.text)) {
        duplicates += 1;
        currentRule = null;
        skipReplies = true;
        return;
      }

      currentRule = { match: { type: 'equals', value: message.text }, reply: [] };
      ruleByText.set(message.text, currentRule);
      rules.push(currentRule);
      skipReplies = false;
      return;
    }

    if (skipReplies) return;

    const step = { delay: clamped.delay, send: message.text };
    if (currentRule) currentRule.reply.push(step);
    else onOpen.push(step);
    steps += 1;
  });

  return {
    // 录到的都是「发什么回什么」的确定对应，所以没有匹配上的消息一律不回。
    // echo 会把客户端自己发的内容打回去，那不是录下来的行为。
    scenario: { onOpen: onOpen, rules: rules, fallback: 'none' },
    pushed: onOpen.length,
    ruleCount: rules.length,
    skipped: parsed.skipped,
    cappedDelays: cappedDelays,
    truncated: truncated,
    duplicates: duplicates
  };
}
