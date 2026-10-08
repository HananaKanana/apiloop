<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NSpace,
  NTag,
  useMessage
} from 'naive-ui';
import { useDialog } from '@/utils/dialog';
import { isLoginRequired } from '@/api/client';
import * as mockLogApi from '@/api/mockLog';
import { useProjectStore } from '@/stores/project';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';
import { useGatewayStore } from '@/stores/gateway';
import { mockBaseUrl } from '@/utils/mock';

/**
 * Mock 调用日志抽屉。
 *
 * 轮询的四条硬要求（计划里的审阅重点第 1 条）：
 *   1. 只在面板打开时轮询 —— 打开才开始，关闭立刻停；
 *   2. 关闭面板、组件卸载、切换项目、`document.hidden` 时都要停；
 *   3. 切换项目和清空日志之后 lastSeq 归零，否则会漏掉或错位；
 *   4. 任何时刻只有一个定时器 —— 所以 start 之前一定先 stop。
 *
 * 另外还要防住**请求交叠**（定时器只有一个，不代表请求只有一个）：用 `inFlight`
 * 保证同一时刻只有一次拉取，用 `generation` 把「切项目 / 清空」之前发出的那批结果
 * 整批作废。少了这两样，慢网络下会出现重复的行，清空之后旧记录还会自己回来。
 *
 * **两个来源**（2026-10-08）：客户端里本机 Mock 的调用记在本机网关，云端 Mock 的记在云端，
 * 两边各拉各的（各有各的 lastSeq —— seq 是各自进程里的计数器，不能混用），合在一起按时间倒序，
 * 每行标上「本机 / 云端」。云端关了 Mock 或者项目没上过云端时只拉本机。网页版只有云端一个来源。
 */
const POLL_MS = 2000;
const MAX_ROWS = 500;

const projects = useProjectStore();
const tabs = useTabsStore();
const ui = useUiStore();
const gateway = useGatewayStore();
const message = useMessage();

/**
 * 这些接口都是「只有云端有的功能」：没登录时网关返回 409 + LOGIN_REQUIRED。
 * 那是「要先登录」，不是出错，所以用提示语气，也别跳登录页（客户端只在 401 时跳）。
 */
function showError(err) {
  if (isLoginRequired(err)) message.warning(err.message);
  else message.error(err.message);
}
const dialog = useDialog();
const { t } = useI18n();

/** 新的在最上面，所以内部是倒序存的 */
const items = ref([]);
/** 每个来源各自的 lastSeq：`{ local: 12, cloud: 3 }`（网页版只有 `cloud`） */
const lastSeq = ref({});
const paused = ref(false);
const loaded = ref(false);
const expandedSeq = ref(null);

let timer = null;
/** 已经有拉取在途时不再发第二个 —— 否则两批结果会拼出重复的行 */
let inFlight = false;
/**
 * 第几代数据。`reset()`（切项目 / 清空）时加一，在途请求返回时值变了就整批丢弃。
 * 只靠 pid 比较挡不住「同一个项目里前后两轮请求交叠」，也挡不住清空之后旧结果复活。
 */
let generation = 0;

const visible = computed({
  get: function () { return ui.mockLogVisible; },
  set: function (value) { ui.mockLogVisible = value; }
});

/**
 * 这次要拉哪几个来源。'local' 是本机网关，'cloud' 是云端（网页版直接连的就是云端）。
 * 云端 Mock 默认关（2026-10-08）—— 关着时 mockAvailable 是 false，**一条都不转发给云端**，
 * 客户端只拉本机；只有云端开了 Mock 才顺带拉云端那份。
 */
const sources = computed(function () {
  if (!gateway.isGateway) return gateway.cloudMockOff ? [] : ['cloud'];
  return gateway.mockAvailable ? ['local', 'cloud'] : ['local'];
});

/** 每行一个唯一键：两个来源的 seq 会撞 */
function keyOf(item) {
  return item.source + ':' + item.seq;
}

/**
 * 空状态里要显示的 mock 地址前缀，和 Mock 页签里那条保持一致。
 * 客户端里给本机 Mock 的地址（本机的一直在；云端的默认关，2026-10-08），网页版给云端的。
 */
const mockPrefixText = computed(function () {
  const project = projects.current;
  if (!project) return '';
  return mockBaseUrl(project, gateway.isGateway ? 'local' : 'cloud');
});

/* ---------------- 轮询 ---------------- */

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function startPolling() {
  // 先停掉可能已经在跑的那个 —— 漏掉这一步就会出现两个定时器同时拉
  stopPolling();
  if (paused.value) return;
  timer = setInterval(tick, POLL_MS);
}

async function tick() {
  const pid = projects.currentId;
  if (!pid || paused.value || document.hidden) return;
  // 上一轮还没回来就跳过这一轮：宁可少拉一次，也不要两批结果叠在一起
  if (inFlight) return;

  const mine = generation;
  inFlight = true;

  try {
    const results = await Promise.all(sources.value.map(function (source) {
      const after = lastSeq.value[source] || 0;
      const opts = { after: after, limit: 100 };
      if (gateway.isGateway && source === 'cloud') opts.source = 'cloud';
      // 一边失败（比如云端连不上）不影响另一边：失败的这一边这轮当没有新记录
      return mockLogApi.listMockLog(pid, opts).then(function (data) {
        return { source: source, data: data };
      }, function () {
        return null;
      });
    }));

    // 拉的过程中切了项目、或者点了清空 —— 这一批已经不属于当前这一代，整批丢掉
    if (mine !== generation || pid !== projects.currentId) return;

    let fresh = [];
    const seqs = { ...lastSeq.value };
    results.forEach(function (result) {
      if (!result) return;
      const list = (result.data && result.data.items) || [];
      fresh = fresh.concat(list.map(function (item) { return { ...item, source: result.source }; }));
      if (typeof result.data.lastSeq === 'number') seqs[result.source] = result.data.lastSeq;
    });
    lastSeq.value = seqs;

    if (fresh.length) {
      items.value = fresh.concat(items.value).sort(function (a, b) {
        return (b.time || 0) - (a.time || 0) || b.seq - a.seq;
      }).slice(0, MAX_ROWS);
    }
  } catch (err) {
    // 轮询失败不打断用户：不弹提示，下一个周期自己会重试
  } finally {
    inFlight = false;
    // 被丢弃的那一批不算「加载完成」，否则空状态会在新数据回来之前闪一下
    if (mine === generation) loaded.value = true;
  }
}

/** 换项目 / 清空之后都要从头拉，lastSeq 必须归零，在途的结果也要作废 */
function reset() {
  generation += 1;
  items.value = [];
  lastSeq.value = {};
  expandedSeq.value = null;
  loaded.value = false;
}

async function reload() {
  reset();
  await tick();
}

function togglePause() {
  paused.value = !paused.value;
  if (paused.value) stopPolling();
  else startPolling();
}

function onVisibilityChange() {
  if (document.hidden) {
    // 标签页切到后台就停掉，别在用户看不见的时候一直请求
    stopPolling();
    return;
  }
  if (!visible.value || paused.value) return;
  startPolling();
  tick();
}

watch(visible, function (value) {
  if (value) {
    reload().then(startPolling);
    return;
  }
  stopPolling();
});

watch(
  function () { return projects.currentId; },
  function () {
    // 换项目：旧项目的记录一条都不能留，lastSeq 也要归零
    reset();
    if (visible.value) reload();
  }
);

onMounted(function () {
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onBeforeUnmount(function () {
  stopPolling();
  document.removeEventListener('visibilitychange', onVisibilityChange);
});

/* ---------------- 展示 ---------------- */

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  function pad(number) { return String(number).padStart(2, '0'); }
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function formatMs(value) {
  if (value === null || value === undefined) return '—';
  return Math.round(value) + ' ms';
}

/** 命中情况：命中期望显示「接口名 · 期望名」，命中默认示例只显示接口名 */
function matchLabel(item) {
  const matched = item.matched;
  if (!matched) return '';
  if (matched.via === 'expectation') {
    return matched.apiName + ' · ' + (matched.expectationName || t('mock.expectationFallback'));
  }
  return matched.apiName;
}

function statusType(item) {
  const status = item.status;
  if (!status) return 'default';
  if (status >= 200 && status < 300) return 'success';
  if (status >= 400 && status < 500) return 'warning';
  if (status >= 500) return 'error';
  return 'default';
}

function toggleRow(item) {
  expandedSeq.value = expandedSeq.value === keyOf(item) ? null : keyOf(item);
}

async function openApi(item) {
  const apiId = item.matched && item.matched.apiId;
  if (!apiId) return;

  try {
    await tabs.openApi(apiId);
    visible.value = false;
  } catch (err) {
    showError(err);
  }
}

function clearAll() {
  dialog.error({
    title: t('mock.clearTitle'),
    content: t('mock.clearBody'),
    positiveText: t('mock.clearAction'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        // 两边都清；客户端里云端那边清不掉（没权限、连不上）也不挡本机这边
        const pid = projects.currentId;
        await Promise.all(sources.value.map(function (source) {
          const cloud = gateway.isGateway && source === 'cloud';
          const call = mockLogApi.clearMockLog(pid, cloud ? 'cloud' : '');
          return cloud ? call.catch(function () {}) : call;
        }));
        reset();
        message.success(t('mock.cleared'));
      } catch (err) {
        showError(err);
      }
    }
  });
}
</script>

<template>
  <n-drawer v-model:show="visible" :width="620" placement="right">
    <n-drawer-content closable>
      <template #header>{{ t('mock.logTitle') }}</template>
      <template #header-extra>
        <n-space align="center" :size="6">
          <n-button size="tiny" quaternary @click="togglePause">
            {{ paused ? t('mock.resume') : t('mock.pause') }}
          </n-button>
          <n-button v-if="projects.canEdit" size="tiny" quaternary type="error" @click="clearAll">
            {{ t('mock.clearAction') }}
          </n-button>
        </n-space>
      </template>

      <div class="log-body">
        <p class="tip">
          {{ t('mock.logTip') }}
        </p>

        <div class="list">
          <div
            v-for="item in items"
            :key="keyOf(item)"
            class="item"
            :class="{ expanded: expandedSeq === keyOf(item) }"
          >
            <div class="row" @click="toggleRow(item)">
              <span class="time">{{ formatTime(item.time) }}</span>
              <!-- 客户端里两个来源合在一起，标一下是哪边的 Mock -->
              <span v-if="gateway.isGateway" class="source" :class="item.source">
                {{ item.source === 'cloud' ? t('mock.urlCloud') : t('mock.urlLocal') }}
              </span>
              <span class="method">{{ item.method }}</span>
              <span class="url" :title="item.url">{{ item.url }}</span>

              <span v-if="item.matched" class="match" :title="matchLabel(item)">
                {{ matchLabel(item) }}
              </span>
              <span v-else class="match unmatched">{{ t('mock.unmatched') }}</span>

              <n-tag size="tiny" :bordered="false" :type="statusType(item)">
                {{ item.status || '—' }}
              </n-tag>
              <!-- Mock 故障模拟命中的那条（第七轮第 1 节）：橙色，一眼能看出这不是接口本身的行为 -->
              <n-tag v-if="item.fault" size="tiny" :bordered="false" type="warning" class="fault">
                {{ t('mock.faultPrefix', { name: item.fault }) }}
              </n-tag>
              <span class="ms">{{ formatMs(item.durationMs) }}</span>
            </div>

            <div v-if="expandedSeq === keyOf(item)" class="detail">
              <div v-if="item.query && Object.keys(item.query).length" class="block">
                <p class="label">{{ t('mock.queryString') }}</p>
                <pre class="pre">{{ JSON.stringify(item.query, null, 2) }}</pre>
              </div>

              <div class="block">
                <p class="label">{{ t('mock.headersMasked') }}</p>
                <pre class="pre">{{ (item.headers || []).map((h) => h[0] + ': ' + h[1]).join('\n') || t('mock.none') }}</pre>
              </div>

              <div class="block">
                <p class="label">{{ t('mock.requestBody') }}</p>
                <pre class="pre">{{ item.bodyPreview || t('mock.emptyValue') }}</pre>
              </div>

              <div class="block">
                <p class="label">{{ t('mock.response') }}</p>
                <pre class="pre">{{ item.responsePreview || t('mock.emptyValue') }}</pre>
              </div>

              <n-space v-if="item.matched && item.matched.apiId" justify="end">
                <n-button size="tiny" type="primary" secondary @click="openApi(item)">
                  {{ t('mock.openApi') }}
                </n-button>
              </n-space>
            </div>
          </div>

          <n-empty
            v-if="loaded && !items.length"
            :description="t('mock.noRecords')"
            class="empty"
          >
            <template #extra>
              <p class="empty-tip">
                {{ t('mock.emptyTipLead') }}<code>{{ mockPrefixText }}/...</code>{{ t('mock.emptyTipTail') }}
              </p>
            </template>
          </n-empty>

          <div v-if="!loaded" class="loading">{{ t('mock.loading') }}</div>
        </div>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.log-body {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tip {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}

.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.item {
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.item.expanded {
  background: rgba(128, 128, 128, 0.06);
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 12px;
}

.row:hover {
  background: rgba(128, 128, 128, 0.08);
}

.time,
.ms {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.55;
}

.ms {
  width: 62px;
  text-align: right;
}

/* 来源：本机 / 云端，小灰字，云端的带一点蓝 */
.source {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 11px;
  line-height: 16px;
  background: rgba(128, 128, 128, 0.14);
  opacity: 0.75;
}

.source.cloud {
  background: rgba(32, 128, 240, 0.14);
}

/* 故障标签：让它自己撑开、不要被挤掉（名字可能有点长） */
.fault {
  flex: none;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.method {
  flex: none;
  width: 54px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #18a058;
}

.url {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.match {
  flex: none;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}

.unmatched {
  color: #d03050;
  opacity: 1;
}

.detail {
  padding: 4px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.label {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
}

.pre {
  margin: 0;
  padding: 6px 8px;
  max-height: 200px;
  overflow: auto;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.empty {
  margin-top: 40px;
}

.empty-tip {
  margin: 0;
  font-size: 12px;
  opacity: 0.7;
  line-height: 1.7;
}

.empty-tip code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.loading {
  padding: 10px;
  text-align: center;
  font-size: 12px;
  opacity: 0.5;
}
</style>
