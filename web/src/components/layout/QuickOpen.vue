<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { NIcon, NInput, NModal } from 'naive-ui';
import { Search } from '@vicons/tabler';
import { useTabsStore } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import { useUiStore } from '@/stores/ui';
import { methodColor } from '@/utils/method';
import { folderChain } from '@/utils/tree';

/**
 * 快速打开（⌘K / Ctrl+K，或者点顶栏那个搜索框）。
 * 数据就是目录树 store 里的接口，按名字和地址做模糊匹配；回车打开标签页。
 */
const tabs = useTabsStore();
const tree = useTreeStore();
const ui = useUiStore();

const MAX_ROWS = 50;

const keyword = ref('');
const cursor = ref(0);
const inputRef = ref(null);

const visible = computed({
  get: function () { return ui.quickOpenVisible; },
  set: function (value) { ui.quickOpenVisible = value; }
});

/** 目录树里所有接口，带上级目录的路径 */
const allApis = computed(function () {
  const list = [];

  (function walk(nodes) {
    (nodes || []).forEach(function (node) {
      if (node.kind === 'folder') {
        walk(node.children);
        return;
      }
      if (!node.api) return;
      list.push({
        id: node.api.id,
        name: node.name || '(未命名接口)',
        method: String(node.api.method || 'GET').toUpperCase(),
        url: node.api.url || '',
        path: folderChain(tree.folders, node.folderId).map(function (folder) {
          return folder.name;
        }).join(' › ')
      });
    });
  })(tree.nodes);

  return list;
});

/**
 * 命中打分：开头命中 > 中间命中 > 子序列命中。
 * 不追求多聪明，够用就行 —— 名字短，用户打字也快。
 */
function score(text, query) {
  const haystack = String(text || '').toLowerCase();
  const needle = String(query || '').toLowerCase();
  if (!needle) return 0;

  const at = haystack.indexOf(needle);
  if (at === 0) return 100;
  if (at > 0) return 60 - Math.min(at, 50);

  let index = 0;
  for (let i = 0; i < haystack.length && index < needle.length; i += 1) {
    if (haystack[i] === needle[index]) index += 1;
  }
  return index === needle.length ? 20 : 0;
}

const results = computed(function () {
  const query = keyword.value.trim();
  if (!query) return allApis.value.slice(0, MAX_ROWS);

  return allApis.value
    .map(function (item) {
      const byName = score(item.name, query);
      const byUrl = score(item.url, query) * 0.8;
      return Object.assign({}, item, { rank: Math.max(byName, byUrl) });
    })
    .filter(function (item) { return item.rank > 0; })
    .sort(function (a, b) { return b.rank - a.rank; })
    .slice(0, MAX_ROWS);
});

function move(step) {
  const total = results.value.length;
  if (!total) return;
  cursor.value = (cursor.value + step + total) % total;
}

async function open(item) {
  if (!item) return;
  visible.value = false;
  try {
    await tabs.openApi(item.id);
  } catch (err) {
    // 打开失败（接口刚被删掉之类）不弹提示，下次刷新目录树就同步了
  }
}

function onKeydown(event) {
  /*
   * 中文输入法组字过程中，回车是在确认候选词 —— 不能拿它去打开接口。
   * `isComposing` 是标准字段，Safari 老版本不给，所以同时看 keyCode === 229
   * （组字期间的 keydown 都是 229）。
   */
  if (event.isComposing || event.keyCode === 229) return;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    open(results.value[cursor.value]);
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    visible.value = false;
  }
}

watch(visible, async function (value) {
  if (!value) return;
  keyword.value = '';
  cursor.value = 0;
  await nextTick();
  if (inputRef.value) inputRef.value.focus();
});

// 结果集变了（打字）之后，光标回到第一条
watch(results, function () {
  if (cursor.value >= results.value.length) cursor.value = 0;
});
</script>

<template>
  <n-modal
    v-model:show="visible"
    :auto-focus="false"
    :mask-closable="true"
    transform-origin="center"
  >
    <div class="quick-open">
      <n-input
        ref="inputRef"
        v-model:value="keyword"
        size="large"
        placeholder="搜索接口名或地址"
        :theme-overrides="{ borderRadius: '0' }"
        @keydown="onKeydown"
      >
        <template #prefix>
          <n-icon :component="Search" />
        </template>
      </n-input>

      <div class="list">
        <div
          v-for="(item, index) in results"
          :key="item.id"
          class="item"
          :class="{ active: index === cursor }"
          @mouseenter="cursor = index"
          @click="open(item)"
        >
          <span class="method" :style="{ color: methodColor(item.method) }">{{ item.method }}</span>
          <span class="name">{{ item.name }}</span>
          <span class="path">{{ item.path }}</span>
        </div>

        <div v-if="!results.length" class="empty">没有匹配的接口</div>
      </div>

      <div class="foot">
        <span>↑↓ 选择</span>
        <span>回车打开</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.quick-open {
  width: 560px;
  max-width: 92vw;
  border-radius: 8px;
  overflow: hidden;
  background: var(--n-color, #fff);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
}

.list {
  max-height: 46vh;
  overflow: auto;
  padding: 4px 0;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
}

.item.active {
  background: rgba(128, 128, 128, 0.14);
}

.method {
  flex: none;
  width: 44px;
  text-align: right;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.name {
  flex: none;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  opacity: 0.55;
}

.empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  opacity: 0.55;
}

.foot {
  display: flex;
  gap: 14px;
  padding: 6px 12px;
  border-top: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
  font-size: 11px;
  opacity: 0.55;
}
</style>
