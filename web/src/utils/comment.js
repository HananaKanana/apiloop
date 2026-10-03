/**
 * 评论用到的几个纯函数（第五轮第 4 节）。
 *
 * 最要紧的一条：**正文一律当纯文本**。评论是用户随便写的，里面可能有 `<script>`；
 * 用 `v-html` 渲染就等于让别人的评论在别人的浏览器里执行脚本。
 * 所以这里只做「把网址拆出来」这一件事，交给组件拼节点（`<span>` + `<a>`）。
 */

/** 「3 分钟前」这种相对时间；超过 7 天直接给日期 */
export function formatRelativeTime(ts, now) {
  const at = Number(ts);
  if (!Number.isFinite(at) || at <= 0) return '';

  const base = now || Date.now();
  const diff = base - at;
  if (diff < 0) return '刚刚';

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return '刚刚';
  if (diff < hour) return Math.floor(diff / minute) + ' 分钟前';
  if (diff < day) return Math.floor(diff / hour) + ' 小时前';
  if (diff < 7 * day) return Math.floor(diff / day) + ' 天前';
  return formatFullTime(at);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** 完整时间，悬停时显示 */
export function formatFullTime(ts) {
  const at = Number(ts);
  if (!Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/** 头像里那个字：显示名的第一个字 */
export function avatarText(name) {
  const text = String(name || '').trim();
  return text ? text.charAt(0).toUpperCase() : '?';
}

const URL_PATTERN = /(https?:\/\/[^\s<>"'）】]+)/g;

/**
 * 正文 → 片段数组，给组件拼节点用。
 *
 * 只认 `http(s)://` 开头的网址（不去猜 `www.` 和裸域名 —— 猜错会把普通文字变成链接）；
 * 换行不做处理，交给 `white-space: pre-wrap` 原样显示。
 *
 * @returns {Array<{type: 'text'|'link', text: string}>}
 */
export function splitBody(body) {
  const text = String(body === undefined || body === null ? '' : body);
  if (!text) return [];

  const parts = text.split(URL_PATTERN);
  const out = [];
  parts.forEach(function (part, index) {
    if (!part) return;
    // split 带捕获组时，命中的那一组会出现在奇数位
    out.push({ type: index % 2 === 1 ? 'link' : 'text', text: part });
  });
  return out;
}

/**
 * 从正文里认出现在还 @ 着的成员（提交时要带上 `mentions`）。
 *
 * 逐个 `@` 位置试**最长的**名字：有「张三」和「张三丰」两个成员时，
 * `@张三丰` 只该算「张三丰」一个人。
 *
 * @param {Array<{userId: string, displayName?: string, username?: string}>} members
 * @returns {Array<string>} 用户 id
 */
export function extractMentions(body, members) {
  const text = String(body === undefined || body === null ? '' : body);
  const candidates = (members || [])
    .map(function (member) {
      return { id: member.userId, name: String(member.displayName || member.username || '') };
    })
    .filter(function (item) { return item.id && item.name; })
    .sort(function (a, b) { return b.name.length - a.name.length; });

  const ids = [];
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) !== '@') {
      index += 1;
      continue;
    }

    const rest = text.slice(index + 1);
    const hit = candidates.find(function (item) { return rest.indexOf(item.name) === 0; });
    if (!hit) {
      index += 1;
      continue;
    }

    if (ids.indexOf(hit.id) === -1) ids.push(hit.id);
    index += 1 + hit.name.length;
  }
  return ids;
}
