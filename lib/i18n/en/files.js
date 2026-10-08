/**
 * 英文翻译：响应的临时文件（第十七轮 T38）。
 *
 * 键是中文原文（见 `lib/i18n/index.js`）。这一块很小 —— 只有 `lib/api/send.js` 的
 * `GET /response-files/:id` 那一条 404：文件不存在、不是这个用户的、已经过期，
 * 三种情况共用同一句话（页面拿它提示用户「重新发送」）。
 *
 * 落文件本身的失败（磁盘满）只打服务端日志，不给用户看，所以没有文案。
 */

module.exports = {
  '文件已过期，请重新发送': 'The file has expired. Please send the request again'
};
