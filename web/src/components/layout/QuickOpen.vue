<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NIcon, NInput, NModal } from 'naive-ui';
import { Search } from '@vicons/tabler';
import { useDialog } from '@/utils/dialog';
import { usePrefsStore } from '@/stores/prefs';
import { useProjectStore } from '@/stores/project';
import { useTabsStore } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import { useUiStore } from '@/stores/ui';
import { methodColor } from '@/utils/method';
import { folderChain } from '@/utils/tree';

/**
 * 快速打开（⌘K / Ctrl+K，或者点顶栏那个搜索框）。
 *
 * 没输入时列出**最近打开的 20 个接口**（跨项目，显示「项目名 / 接口名」，点了切到那个项目
 * 并打开）；开始打字就换成当前项目的接口模糊匹配，回车打开。
 * 数据就是目录树 store 里的接口。最近打开来自个人偏好（第七轮第 2 节）。
 */
const tabs = useTabsStore();
const tree = useTreeStore();
const ui = useUiStore();
const prefs = usePrefsStore();
const projects = useProjectStore();
const dialog = useDialog();
const { t } = useI18n();

const MAX_ROWS = 50;

const keyword = ref('');
const cursor = ref(0);
const inputRef = ref(null);

/** 最近打开（跨项目）。打开弹窗时拉一次 */
const recents = ref([]);

const visible = computed({
  get: function () { return ui.quickOpenVisible; },
  set: function (value) { ui.quickOpenVisible = value; }
});

const searching = computed(function () { return Boolean(keyword.value.trim()); });

/** 项目 id → 名字（最近打开要显示「项目名 / 接口名」） */
const projectNameById = computed(function () {
  const map = new Map();
  projects.projects.forEach(function (project) { map.set(project.id, project.name); });
  return map;
});

function projectNameOf(id) {
  return projectNameById.value.get(id) || t('layout.projectMissing');
}

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
        name: node.name || t('layout.untitledApi'),
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

/**
 * 把文字按关键字切成几段，命中的那段标出来高亮（只标第一处连续命中，不区分大小写）。
 * 子序列命中（比如 uif 命中 userInfo）就不标了 —— 零零散散的高亮反而难看。
 */
function segments(text, query) {
  const source = String(text || '');
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [{ text: source, hit: false }];
  const at = source.toLowerCase().indexOf(needle);
  if (at === -1) return [{ text: source, hit: false }];
  return [
    { text: source.slice(0, at), hit: false },
    { text: source.slice(at, at + needle.length), hit: true },
    { text: source.slice(at + needle.length), hit: false }
  ].filter(function (part) { return part.text; });
}

/** 键盘现在在操作哪一份列表：没输入时是「最近打开」，输入了是搜索结果 */
const activeList = computed(function () {
  return searching.value ? results.value : recents.value;
});

function move(step) {
  const total = activeList.value.length;
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

/** 切换项目前问一句（打开着的标签页会全关掉） */
function confirmSwitchProject() {
  return new Promise(function (resolve) {
    dialog.warning({
      title: t('layout.switchProjectTitle'),
      content: t('layout.switchProjectBody'),
      positiveText: t('layout.switchAction'),
      negativeText: t('app.cancel'),
      onPositiveClick: function () { resolve(true); },
      onNegativeClick: function () { resolve(false); },
      onClose: function () { resolve(false); },
      onMaskClick: function () { resolve(false); }
    });
  });
}

/** 打开「最近」里的一条：可能在别的项目里，先切到那个项目再开 */
async function openRecent(item) {
  if (!item) return;

  if (item.projectId !== projects.currentId) {
    if (tabs.hasDirty && !(await confirmSwitchProject())) return;
    visible.value = false;
    tabs.closeAll();
    projects.setCurrent(item.projectId);
  } else {
    visible.value = false;
  }

  try {
    await tabs.openApi(item.apiId);
  } catch (err) {
    // 同上：接口可能刚被删掉
  }
}

/** 拉一次「最近打开」。拉不到就空着 —— ⌘K 主要是拿来搜索的，别为这个弹错 */
async function loadRecents() {
  recents.value = [];
  try {
    recents.value = await prefs.visibleRecent();
  } catch (err) {
    recents.value = [];
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
    if (searching.value) open(results.value[cursor.value]);
    else openRecent(recents.value[cursor.value]);
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
  loadRecents();
});

// 列表变了（打字、或者最近打开拉回来了）之后，光标回到第一条
watch(activeList, function () {
  if (cursor.value >= activeList.value.length) cursor.value = 0;
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
        :placeholder="t('layout.searchPlaceholder')"
        :theme-overrides="{ borderRadius: '0' }"
        @keydown="onKeydown"
      >
        <template #prefix>
          <n-icon :component="Search" />
        </template>
      </n-input>

      <div class="list">
        <!-- 没输入时：最近打开的 20 个接口（跨项目），点了切到那个项目并打开 -->
        <template v-if="!searching">
          <div class="hint">{{ t('layout.recentOpened') }}</div>

          <div
            v-for="(item, index) in recents"
            :key="item.projectId + ':' + item.apiId"
            class="item"
            :class="{ active: index === cursor }"
            @mouseenter="cursor = index"
            @click="openRecent(item)"
          >
            <span class="method" :style="{ color: methodColor(item.method) }">{{ item.method }}</span>
            <div class="main">
              <!-- 跨项目的，光看接口名分不清是哪个项目里的 -->
              <div class="line">
                <span class="name">{{ projectNameOf(item.projectId) }} / {{ item.name }}</span>
              </div>
              <div class="url">{{ item.url || t('layout.noUrl') }}</div>
            </div>
          </div>

          <div v-if="!recents.length" class="empty">{{ t('layout.noRecent') }}</div>
        </template>

        <template v-else>
          <div
            v-for="(item, index) in results"
            :key="item.id"
            class="item"
            :class="{ active: index === cursor }"
            @mouseenter="cursor = index"
            @click="open(item)"
          >
            <span class="method" :style="{ color: methodColor(item.method) }">{{ item.method }}</span>
            <!-- 两行：上面是名字和所在目录，下面是地址 —— 只看名字分不清是不是要找的那个 -->
            <div class="main">
              <div class="line">
                <span class="name">
                  <span
                    v-for="(part, i) in segments(item.name, keyword)"
                    :key="i"
                    :class="{ hit: part.hit }"
                  >{{ part.text }}</span>
                </span>
                <span v-if="item.path" class="path">{{ item.path }}</span>
              </div>
              <div class="url">
                <span
                  v-for="(part, i) in segments(item.url || t('layout.noUrl'), keyword)"
                  :key="i"
                  :class="{ hit: part.hit }"
                >{{ part.text }}</span>
              </div>
            </div>
          </div>

          <div v-if="!results.length" class="empty">{{ t('layout.noMatchingApis') }}</div>
        </template>
      </div>

      <div class="foot">
        <span>{{ t('layout.footerSelect') }}</span>
        <span>{{ t('layout.footerOpen') }}</span>
        <span>{{ t('layout.footerClose') }}</span>
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

/* 「最近打开」的小标题（只有没输入时才有这一行） */
.hint {
  padding: 4px 12px 6px;
  font-size: 11px;
  letter-spacing: 0.02em;
  opacity: 0.5;
}

.item {
  display: flex;
  align-items: flex-start;
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
  line-height: 19px;
  text-align: right;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.main {
  flex: 1;
  min-width: 0;
}

.line {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.name {
  flex: none;
  max-width: 70%;
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
  opacity: 0.5;
  text-align: right;
}

.url {
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  /* 用灰色而不是 opacity：父元素半透明的话，里面高亮的那段也跟着变淡 */
  color: #8a8f98;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* 搜索命中的那一段：主色加粗 */
.hit {
  color: var(--apiloop-primary);
  font-weight: 600;
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
