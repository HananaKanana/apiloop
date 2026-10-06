import { t } from '@/i18n';
/** 期望条件的可选值与文案。读写两边共用，免得「等于」在这里写成「等于」，在别处写成「相等」 */

export const CONDITION_SOURCES = [
  { label: 'query', value: 'query' },
  { label: 'header', value: 'header' },
  { label: 'body', value: 'body' },
  { label: 'path', value: 'path' }
];

export const CONDITION_OPS = [
  { value: 'eq', get label() { return t('utils.opEq'); } },
  { value: 'ne', get label() { return t('utils.opNe'); } },
  { value: 'contains', get label() { return t('utils.opContains'); } },
  { value: 'regex', get label() { return t('utils.opRegex'); } },
  { value: 'exists', get label() { return t('utils.opExists'); } },
  { value: 'notExists', get label() { return t('utils.opNotExists'); } },
  { value: 'gt', get label() { return t('utils.opGt'); } },
  { value: 'lt', get label() { return t('utils.opLt'); } }
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
  if (!list.length) return t('utils.condNoCondition');

  return list.map(function (item) {
    const head = sourceLabel(item.in) + '.' + (item.key || '');
    const op = opLabel(item.op);
    if (!opNeedsValue(item.op)) return head + ' ' + op;
    return head + ' ' + op + ' ' + (item.value === undefined ? '' : item.value);
  }).join(t('utils.condAnd'));
}
