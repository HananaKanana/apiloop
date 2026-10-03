<script setup>
import { NButton } from 'naive-ui';

/**
 * 响应面板的「字段」视图（第六轮第 1 节）：一行一个 JSON 字段，右边两个动作。
 *
 * 摊平这件事在 `@/utils/jsonTree.js` 里（纯函数，能单独跑断言），这里只负责画和点。
 * 路径由父组件摊好传进来 —— 父组件还要用它决定这个视图能不能显示，摊两遍是白费。
 */
const props = defineProps({
  /** `buildJsonRows` 的结果：`{ ok, rows, truncated }` 或 `{ ok: false, reason }` */
  tree: { type: Object, required: true },
  /** 只读角色：不给这两个写入口（它们会改接口、让它变成「未保存」） */
  readonly: { type: Boolean, default: false }
});

const emit = defineEmits(['add-assertion', 'add-extract']);
</script>

<template>
  <div class="json-fields">
    <p v-if="!props.tree.ok" class="hint">{{ props.tree.reason }}</p>
    <p v-else-if="!props.tree.rows.length" class="hint">这是一段顶层不是对象的 JSON，没有字段可以点。</p>

    <template v-else>
      <div
        v-for="row in props.tree.rows"
        :key="row.path"
        class="field-row"
        :class="{ container: row.container }"
        :style="{ paddingLeft: (8 + row.depth * 14) + 'px' }"
      >
        <span class="key">{{ row.label }}</span>
        <span class="type">{{ row.type }}</span>
        <span class="value">{{ row.preview }}</span>
        <span v-if="!readonly" class="actions">
          <n-button
            size="tiny"
            quaternary
            title="在「断言」里加一行：JSON 字段 · 这个路径"
            @click="emit('add-assertion', { path: row.path, value: row.value, container: row.container })"
          >
            加断言
          </n-button>
          <n-button
            size="tiny"
            quaternary
            title="在「断言」页签的提取表里加一行"
            @click="emit('add-extract', { path: row.path })"
          >
            提取为变量
          </n-button>
        </span>
      </div>

      <p v-if="props.tree.truncated" class="hint">字段太多，只列出前 500 个。</p>
    </template>
  </div>
</template>

<style scoped>
.json-fields {
  padding: 4px 0;
}

.field-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 8px;
  font-size: 12px;
  line-height: 1.7;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.field-row:hover {
  background: rgba(128, 128, 128, 0.1);
}

.key {
  flex: none;
  font-weight: 600;
}

.type {
  flex: none;
  font-size: 11px;
  opacity: 0.5;
  font-family: inherit;
}

.value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}

/* 对象 / 数组那一行没有值可看，压暗一点，让人一眼看出它只是个「入口」 */
.container .value {
  opacity: 0.5;
}

.actions {
  flex: none;
  display: none;
  gap: 2px;
}

.field-row:hover .actions {
  display: inline-flex;
}

.hint {
  margin: 8px 0;
  font-size: 12px;
  opacity: 0.6;
}
</style>
