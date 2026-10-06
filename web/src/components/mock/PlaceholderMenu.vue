<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { NDropdown } from 'naive-ui';

/**
 * 「插入 Mock 字段」菜单。数据来自 /meta.placeholders，按 group 分组。
 *
 * 后端给的 example 是插入文本（比如 {{@words(3)}}），但只有带参数的占位符才填了它，
 * 所以没有 example 时按 name / args 自己拼一个。
 */
const props = defineProps({
  placeholders: { type: Array, default: function () { return []; } }
});

const emit = defineEmits(['insert']);

const { t } = useI18n();

function insertText(item) {
  if (item.example) return item.example;
  return '{{@' + item.name + (item.args ? '(' + item.args + ')' : '') + '}}';
}

const options = computed(function () {
  const groups = new Map();

  props.placeholders.forEach(function (item) {
    const group = item.group || t('mock.otherGroup');
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({
      key: group + '::' + item.name,
      label: '{{@' + item.name + '}}' + (item.desc ? '　' + item.desc : ''),
      insert: insertText(item)
    });
  });

  const list = [];
  groups.forEach(function (items, group) {
    list.push({ type: 'group', label: group, key: 'g:' + group, children: items });
  });
  return list;
});

function onSelect(key) {
  let found = null;
  options.value.forEach(function (group) {
    (group.children || []).forEach(function (item) {
      if (item.key === key) found = item;
    });
  });
  if (found) emit('insert', found.insert);
}
</script>

<template>
  <n-dropdown
    :options="options"
    trigger="click"
    placement="bottom-start"
    :scrollable="true"
    @select="onSelect"
  >
    <slot />
  </n-dropdown>
</template>
