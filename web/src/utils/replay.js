/**
 * 回放场景的几个硬上限（契约第 17 节）。SSE 和 WebSocket 都用同一套数字，
 * 所以抽出来放在这里，别在两处各写一遍 60000。
 */

/** 单段 `delay` 的上下限，毫秒。写入时超出会被服务端拒绝（400） */
export const MAX_REPLAY_DELAY = 60000;

/** WebSocket 场景的步骤总数上限（`onOpen` 条数 + 各条规则的 `reply` 条数） */
export const MAX_REPLAY_STEPS = 1000;

/**
 * 把一段间隔截到允许的范围里。
 *
 * 录制时「用户隔几分钟才发下一条消息」是很正常的，心跳间隔也可能好几分钟，
 * 不截断的话整个场景会因为一个 delay 存不下去。
 *
 * @param {number} value 毫秒
 * @returns {{ delay: number, capped: boolean }} `capped` 为 true 表示被截断过
 */
export function clampReplayDelay(value) {
  const rounded = Math.round(Number(value) || 0);
  if (rounded < 0) return { delay: 0, capped: false };
  if (rounded > MAX_REPLAY_DELAY) return { delay: MAX_REPLAY_DELAY, capped: true };
  return { delay: rounded, capped: false };
}
