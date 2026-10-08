/**
 * 英文翻译：RabbitMQ 调试（第十六轮 T40）。
 *
 * 键是中文原文（见 `lib/i18n/index.js`）。这一块的消息都在「按下连接之后」：
 * 会话事件（connecting / connected / consuming / message / published / returned / …）、
 * 消费与回确认的报错、发布与查队列的报错。
 *
 * 会话类事件是用 `i18n.mIn(session.locale, …)` 取的 —— 语言在**建会话那一刻**记在
 * 会话上（见 `lib/amqp-sessions.js`）。
 */

module.exports = {
  /* ---------------- 建会话 ---------------- */
  'RabbitMQ 会话不存在': 'RabbitMQ session not found',
  '缺少 RabbitMQ 地址': 'Missing the RabbitMQ address',
  'RabbitMQ 地址要以 amqp:// 或 amqps:// 开头': 'The RabbitMQ address must start with amqp:// or amqps://',
  'RabbitMQ 不支持内置的 Mock 环境，请选一个真实环境或不选':
    'RabbitMQ does not support the built-in mock environment; pick a real environment or none',
  '同时最多保持 {n} 个 RabbitMQ 会话': 'At most {n} RabbitMQ sessions can be open at once',
  'RabbitMQ 连接还没有打开，或者已经关闭': 'The RabbitMQ connection is not open, or has already closed',

  /* ---------------- 消费 / 回确认 ---------------- */
  '这个消费者没有填队列或交换机': 'This consumer has neither a queue nor an exchange',
  '这个消费者不在了': 'That consumer is gone',
  '缺少 consumerTag': 'Missing consumerTag',
  '缺少 deliveryTag': 'Missing deliveryTag',
  'action 只能是 ack / nack / reject': 'action can only be ack / nack / reject',
  '回确认失败：{reason}': 'Acknowledging failed: {reason}',
  '恢复消费「{queue}」失败：{reason}': 'Failed to resume consuming "{queue}": {reason}',
  '队列被删掉了': 'The queue was deleted',
  'channel 已关闭': 'The channel was closed',
  '重建 channel 失败：{reason}': 'Failed to rebuild the channel: {reason}',

  /* ---------------- 发布 / 查队列 ---------------- */
  '发布失败：{reason}': 'Publishing failed: {reason}',
  '缺少队列名': 'Missing the queue name',
  '查不到这个队列：{reason}': 'That queue could not be looked up: {reason}',

  /* ---------------- 连接与协议错误 ---------------- */
  '连不上 RabbitMQ，检查地址和端口': 'Cannot reach RabbitMQ; check the address and port',
  '连不上 RabbitMQ，检查地址和端口（连接超时）':
    'Cannot reach RabbitMQ; check the address and port (connection timed out)',
  '找不到这个地址，检查主机名': 'That address cannot be found; check the host name',
  '用户名或密码不对，或者这个账号没有权限':
    'Wrong username or password, or this account is not allowed in',
  'vhost 不存在，或者这个账号没有权限': 'The vhost does not exist, or this account has no access to it',
  '队列或交换机不存在：{reason}': 'The queue or exchange does not exist: {reason}',
  '参数和已存在的队列 / 交换机不一致：{reason}':
    'The arguments do not match the existing queue / exchange: {reason}',
  '连接被 broker 强制断开（心跳超时或管理端关闭）':
    'The broker forced the connection closed (heartbeat timeout, or it was closed from the management UI)',
  'RabbitMQ 出错': 'RabbitMQ error',

  /* ---------------- 集合导出 ---------------- */
  '{n} 个 WebSocket / Socket.IO / gRPC / MQTT / AMQP / TCP / UDP 接口没有导出：集合的 JSON 格式里没有它们':
    '{n} WebSocket / Socket.IO / gRPC / MQTT / AMQP / TCP / UDP APIs were not exported: the collection JSON format has no place for them',
  /* ---------------- 导出文档 ---------------- */
  'RabbitMQ 接口「{name}」：OpenAPI 里没有 AMQP': 'RabbitMQ API "{name}": OpenAPI has no AMQP',
  '消费者': 'Consumers',
  '- 消费者：{text}': '- Consumer: {text}',
  '手动确认': 'manual ack',
  '自动确认': 'auto ack',
  'queue「{queue}」（{ack}）': 'queue "{queue}" ({ack})',
  'exchange「{exchange}」路由键「{routingKey}」（临时队列旁听，{ack}）':
    'exchange "{exchange}" with routing key "{routingKey}" (listening through a temporary queue, {ack})',
  '{name}：exchange「{exchange}」路由键「{routingKey}」':
    '{name}: exchange "{exchange}" with routing key "{routingKey}"',
  '- {name}：exchange「{exchange}」路由键「{routingKey}」':
    '- {name}: exchange "{exchange}" with routing key "{routingKey}"',
  '（默认交换机）': '(default exchange)'
};
