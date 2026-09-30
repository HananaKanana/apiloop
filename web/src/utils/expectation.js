/** 期望条件的可选值与文案。读写两边共用，免得「等于」在这里写成「等于」，在别处写成「相等」 */

export const CONDITION_SOURCES = [
  { label: 'query', value: 'query' },
  { label: 'header', value: 'header' },
  { label: 'body', value: 'body' },
  { label: 'path', value: 'path' }
];

export const CONDITION_OPS = [
  { label: '等于', value: 'eq' },
  { label: '不等于', value: 'ne' },
  { label: '包含', value: 'contains' },
  { label: '正则', value: 'regex' },
  { label: '存在', value: 'exists' },
  { label: '不存在', value: 'notExists' },
  { label: '大于', value: 'gt' },
  { label: '小于', value: 'lt' }
];

const OP_LABELS = {};
CONDITION_OPS.forEach(function (item) { OP_LABELS[item.value] = item.label; });

/** 「存在 / 不存在」不看 value，界面上连这一列都不显示 */
export function opNeedsValue(op) {
  return op !== 'exists' && op !== 'notExists';
}

export function opLabel(op) {
  return OP_LABELS[op] || op || '';
}

export function sourceLabel(source) {
  return source || '';
}

/** 列表里那一行「条件摘要」，例如 `query.id 等于 404 且 header.token 存在` */
export function conditionSummary(conditions) {
  const list = conditions || [];
  if (!list.length) return '无条件（总是命中）';

  return list.map(function (item) {
    const head = sourceLabel(item.in) + '.' + (item.key || '');
    const op = opLabel(item.op);
    if (!opNeedsValue(item.op)) return head + ' ' + op;
    return head + ' ' + op + ' ' + (item.value === undefined ? '' : item.value);
  }).join(' 且 ');
}
