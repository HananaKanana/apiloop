<script setup>
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NCheckbox,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSpace,
  NSpin,
  NTag,
  useMessage
} from 'naive-ui';
import { useDialog } from '@/utils/dialog';
import * as cookiesApi from '@/api/cookies';
import { useProjectStore } from '@/stores/project';
import { useSessionStore } from '@/stores/session';

/**
 * Cookie 管理弹窗。
 *
 * **Cookie 是「每个用户 × 每个项目」自己的数据**，不是项目数据 —— 同一个项目里
 * 别人登录的是别的账号，他看不到我的 cookie，也不会用在别人的请求里。所以这个弹窗
 * 对 viewer 也要照常开放（发送请求本来就是 viewer 能做的事），不跟着只读角色一起收。
 *
 * 服务端存的域名约定：以 `.` 开头是「域 cookie」（会发给子域名），否则是 host-only。
 */
const props = defineProps({
  show: { type: Boolean, default: false }
});

const emit = defineEmits(['update:show']);

const projects = useProjectStore();
const session = useSessionStore();
const message = useMessage();
const dialog = useDialog();

const cookies = ref([]);
const loading = ref(false);
/** 哪些 cookie 的值被点开看了 */
const revealed = ref({});

const showAdd = ref(false);
const adding = ref(false);
const addForm = ref(emptyForm());

function emptyForm() {
  return {
    domain: '',
    name: '',
    value: '',
    path: '/',
    expires: '',
    secure: false,
    httpOnly: false
  };
}

const groups = computed(function () {
  const map = new Map();
  cookies.value.forEach(function (cookie) {
    if (!map.has(cookie.domain)) map.set(cookie.domain, []);
    map.get(cookie.domain).push(cookie);
  });

  return Array.from(map.entries())
    .map(function (pair) { return { domain: pair[0], items: pair[1] }; })
    .sort(function (a, b) { return a.domain < b.domain ? -1 : 1; });
});

async function load() {
  const pid = projects.currentId;
  if (!pid) {
    cookies.value = [];
    return;
  }

  loading.value = true;
  try {
    const data = await cookiesApi.listCookies(pid);
    cookies.value = data.cookies || [];
    revealed.value = {};
  } catch (err) {
    message.error(err.message);
  } finally {
    loading.value = false;
  }
}

watch(
  function () { return props.show; },
  function (visible) {
    if (visible) load();
  },
  { immediate: true }
);

watch(
  function () { return projects.currentId; },
  function () {
    if (props.show) load();
  }
);

function toggleReveal(cookie) {
  const next = Object.assign({}, revealed.value);
  next[cookie.id] = !next[cookie.id];
  revealed.value = next;
}

function formatExpires(expires) {
  if (!expires) return '会话';
  const date = new Date(expires);
  function pad(number) { return String(number).padStart(2, '0'); }
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function removeOne(cookie) {
  dialog.error({
    title: '删除 Cookie',
    content: '确定删除「' + cookie.name + '」（' + cookie.domain + '）吗？',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await cookiesApi.removeCookie(cookie.id);
        await load();
        message.success('已删除');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

function clearDomain(domain) {
  dialog.error({
    title: '清空该域名',
    content: '确定清空「' + domain + '」下的全部 Cookie 吗？',
    positiveText: '清空',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await cookiesApi.clearCookies(projects.currentId, domain);
        await load();
        message.success('已清空');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

function clearAll() {
  dialog.error({
    title: '清空全部 Cookie',
    content: '确定清空当前项目下你自己的全部 Cookie 吗？',
    positiveText: '清空',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await cookiesApi.clearCookies(projects.currentId);
        await load();
        message.success('已清空');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

/**
 * 解析过期时间。留空 = 会话 cookie；否则接受
 * `2026-09-30 18:00`（本地时区，秒可省）、`2026-09-30 18:00:00`，
 * 或者纯数字时间戳：**10 位按秒、13 位按毫秒**。
 *
 * 10 位那一档必须按秒算：`date +%s` 给的就是 10 位，按毫秒解释会落到 1970 年，
 * 存进去等于这条 cookie 立刻就过期了，而且界面上完全看不出来（N3）。
 * 11–12 位两种解释都不成立（按秒是公元 2286 年以后，按毫秒是 1970–2001），
 * 一律当成看不懂 —— 与其猜一个错的，不如让用户改。
 *
 * 刻意不用日期选择器组件：naive-ui 的 `n-date-picker` 一个就值 36KB gzip，
 * 而这里绝大多数时候是留空的。解析不了就提示，不把 NaN 发给服务端。
 */
function parseExpires(text) {
  const value = String(text === undefined || text === null ? '' : text).trim();
  if (!value) return { ok: true, value: null };

  if (/^\d+$/.test(value)) {
    if (value.length <= 10) return { ok: true, value: Number(value) * 1000 };
    if (value.length >= 13) return { ok: true, value: Number(value) };
    return { ok: false, value: null };
  }

  const ms = Date.parse(value.replace(' ', 'T'));
  if (Number.isNaN(ms)) return { ok: false, value: null };
  return { ok: true, value: ms };
}

function openAdd() {
  addForm.value = emptyForm();
  showAdd.value = true;
}

async function submitAdd() {
  const domain = addForm.value.domain.trim();
  const name = addForm.value.name.trim();

  if (!domain) {
    message.warning('请填写域名');
    return;
  }
  if (!name) {
    message.warning('请填写 cookie 名');
    return;
  }

  const expires = parseExpires(addForm.value.expires);
  if (!expires.ok) {
    message.warning('过期时间看不懂：用 2026-09-30 18:00，或者 10 位秒 / 13 位毫秒时间戳；留空表示会话 cookie');
    return;
  }

  adding.value = true;
  try {
    await cookiesApi.saveCookie(projects.currentId, {
      domain: domain,
      name: name,
      value: addForm.value.value,
      path: addForm.value.path.trim() || '/',
      expires: expires.value,
      secure: addForm.value.secure,
      httpOnly: addForm.value.httpOnly
    });
    showAdd.value = false;
    await load();
    message.success('已保存');
  } catch (err) {
    // 域名 / cookie 名不合法这类 400 由服务端说清楚
    message.error(err.message);
  } finally {
    adding.value = false;
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="Cookie 管理"
    style="width: 780px; max-width: 94vw"
    @update:show="emit('update:show', $event)"
  >
    <div class="cookie-manager">
      <p class="tip">
        这些 Cookie 只属于你自己（{{ session.displayName || '当前用户' }} 在「{{
          projects.current ? projects.current.name : '当前项目'
        }}」下各一份），项目里的其他成员看不到，也不会用在他们的请求里。
        发送请求时自动带上，响应里的 Set-Cookie 自动写回。
      </p>

      <n-space align="center" :size="8">
        <n-button size="small" type="primary" secondary @click="openAdd">手动添加</n-button>
        <n-button size="small" quaternary @click="load">刷新</n-button>
        <n-button
          v-if="cookies.length"
          size="small"
          quaternary
          type="error"
          @click="clearAll"
        >
          清空全部
        </n-button>
      </n-space>

      <n-spin :show="loading">
        <div v-if="groups.length" class="groups">
          <div v-for="group in groups" :key="group.domain" class="group">
            <div class="group-head">
              <span class="domain">{{ group.domain }}</span>
              <n-button size="tiny" quaternary type="error" @click="clearDomain(group.domain)">
                清空该域名
              </n-button>
            </div>

            <div class="table">
              <div class="row head">
                <span class="cell name">名称</span>
                <span class="cell value">值</span>
                <span class="cell path">路径</span>
                <span class="cell expires">过期</span>
                <span class="cell flags">标记</span>
                <span class="cell action" />
              </div>

              <div v-for="cookie in group.items" :key="cookie.id" class="row">
                <span class="cell name" :title="cookie.name">{{ cookie.name }}</span>
                <span
                  class="cell value clickable"
                  :title="revealed[cookie.id] ? '点击隐藏' : '点击查看'"
                  @click="toggleReveal(cookie)"
                >
                  {{ revealed[cookie.id] ? cookie.value : '••••••' }}
                </span>
                <span class="cell path" :title="cookie.path">{{ cookie.path }}</span>
                <span class="cell expires">{{ formatExpires(cookie.expires) }}</span>
                <span class="cell flags">
                  <n-tag v-if="cookie.secure" size="tiny" :bordered="false">Secure</n-tag>
                  <n-tag v-if="cookie.httpOnly" size="tiny" :bordered="false">HttpOnly</n-tag>
                  <n-tag v-if="!cookie.hostOnly" size="tiny" :bordered="false" type="info">域</n-tag>
                </span>
                <span class="cell action">
                  <n-button size="tiny" quaternary type="error" @click="removeOne(cookie)">
                    删除
                  </n-button>
                </span>
              </div>
            </div>
          </div>
        </div>

        <n-empty v-else-if="!loading" size="small" description="还没有 cookie" class="empty" />
      </n-spin>
    </div>

    <n-modal
      v-model:show="showAdd"
      preset="card"
      title="添加 / 修改 Cookie"
      style="width: 520px; max-width: 94vw"
    >
      <n-form label-placement="top">
        <n-form-item label="域名">
          <n-input v-model:value="addForm.domain" placeholder="example.com，或以 . 开头表示发给子域名" />
        </n-form-item>
        <n-form-item label="名称">
          <n-input v-model:value="addForm.name" placeholder="sid" />
        </n-form-item>
        <n-form-item label="值">
          <n-input v-model:value="addForm.value" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" />
        </n-form-item>
        <n-form-item label="路径">
          <n-input v-model:value="addForm.path" placeholder="/" />
        </n-form-item>
        <n-form-item label="过期时间">
          <n-input
            v-model:value="addForm.expires"
            placeholder="2026-09-30 18:00，或 10 位秒 / 13 位毫秒时间戳；留空表示会话 cookie"
          />
        </n-form-item>
        <n-space align="center" :size="16">
          <n-checkbox v-model:checked="addForm.secure">Secure（只走 https）</n-checkbox>
          <n-checkbox v-model:checked="addForm.httpOnly">HttpOnly</n-checkbox>
        </n-space>
      </n-form>

      <template #footer>
        <n-space justify="end">
          <n-button @click="showAdd = false">取消</n-button>
          <n-button type="primary" :loading="adding" @click="submitAdd">保存</n-button>
        </n-space>
      </template>
    </n-modal>
  </n-modal>
</template>

<style scoped>
.cookie-manager {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 200px;
}

.tip {
  margin: 0;
  font-size: 12px;
  opacity: 0.65;
  line-height: 1.7;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 56vh;
  overflow: auto;
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 2px 6px;
}

.domain {
  font-size: 13px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.table {
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 4px;
  overflow: hidden;
  font-size: 12px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.row:last-child {
  border-bottom: none;
}

.row.head {
  opacity: 0.65;
  background: rgba(128, 128, 128, 0.08);
}

.cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  /* 和请求区的键值表格同一套：列之间也有细线 */
  border-right: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.cell:last-child {
  border-right: none;
}

.cell.name {
  flex: 0 0 18%;
}

.cell.value {
  flex: 1;
}

.clickable {
  cursor: pointer;
}

.cell.path {
  flex: 0 0 12%;
  opacity: 0.75;
}

.cell.expires {
  flex: 0 0 18%;
  opacity: 0.75;
}

.cell.flags {
  flex: none;
  width: 132px;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: visible;
}

.cell.action {
  flex: none;
  width: 52px;
  text-align: right;
  overflow: visible;
}

.empty {
  margin-top: 30px;
}
</style>
