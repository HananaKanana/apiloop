<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
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
const { t } = useI18n();

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
  if (!expires) return t('request.session');
  const date = new Date(expires);
  function pad(number) { return String(number).padStart(2, '0'); }
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function removeOne(cookie) {
  dialog.error({
    title: t('request.deleteCookieTitle'),
    content: t('request.deleteCookieBody', { name: cookie.name, domain: cookie.domain }),
    positiveText: t('app.delete'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        await cookiesApi.removeCookie(cookie.id);
        await load();
        message.success(t('request.deleted'));
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

function clearDomain(domain) {
  dialog.error({
    title: t('request.clearDomainAction'),
    content: t('request.clearDomainBody', { domain: domain }),
    positiveText: t('request.clear'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        await cookiesApi.clearCookies(projects.currentId, domain);
        await load();
        message.success(t('request.cleared'));
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

function clearAll() {
  dialog.error({
    title: t('request.clearAllTitle'),
    content: t('request.clearAllBody'),
    positiveText: t('request.clear'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        await cookiesApi.clearCookies(projects.currentId);
        await load();
        message.success(t('request.cleared'));
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
    message.warning(t('request.domainRequired'));
    return;
  }
  if (!name) {
    message.warning(t('request.cookieNameRequired'));
    return;
  }

  const expires = parseExpires(addForm.value.expires);
  if (!expires.ok) {
    message.warning(t('request.expiresInvalid'));
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
    message.success(t('request.saved'));
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
    :title="t('request.cookieTitle')"
    style="width: 780px; max-width: 94vw"
    @update:show="emit('update:show', $event)"
  >
    <div class="cookie-manager">
      <p class="tip">
        {{ t('request.cookieTip', {
          user: session.displayName || t('request.currentUser'),
          project: projects.current ? projects.current.name : t('request.currentProject')
        }) }}
      </p>

      <n-space align="center" :size="8">
        <n-button size="small" type="primary" secondary @click="openAdd">{{ t('request.addManual') }}</n-button>
        <n-button size="small" quaternary @click="load">{{ t('request.refresh') }}</n-button>
        <n-button
          v-if="cookies.length"
          size="small"
          quaternary
          type="error"
          @click="clearAll"
        >
          {{ t('request.clearAll') }}
        </n-button>
      </n-space>

      <n-spin :show="loading">
        <div v-if="groups.length" class="groups">
          <div v-for="group in groups" :key="group.domain" class="group">
            <div class="group-head">
              <span class="domain">{{ group.domain }}</span>
              <n-button size="tiny" quaternary type="error" @click="clearDomain(group.domain)">
                {{ t('request.clearDomainAction') }}
              </n-button>
            </div>

            <div class="table">
              <div class="row head">
                <span class="cell name">{{ t('request.name') }}</span>
                <span class="cell value">{{ t('request.value') }}</span>
                <span class="cell path">{{ t('request.path') }}</span>
                <span class="cell expires">{{ t('request.expires') }}</span>
                <span class="cell flags">{{ t('request.flags') }}</span>
                <span class="cell action" />
              </div>

              <div v-for="cookie in group.items" :key="cookie.id" class="row">
                <span class="cell name" :title="cookie.name">{{ cookie.name }}</span>
                <span
                  class="cell value clickable"
                  :title="revealed[cookie.id] ? t('request.clickToHide') : t('request.clickToView')"
                  @click="toggleReveal(cookie)"
                >
                  {{ revealed[cookie.id] ? cookie.value : '••••••' }}
                </span>
                <span class="cell path" :title="cookie.path">{{ cookie.path }}</span>
                <span class="cell expires">{{ formatExpires(cookie.expires) }}</span>
                <span class="cell flags">
                  <n-tag v-if="cookie.secure" size="tiny" :bordered="false">Secure</n-tag>
                  <n-tag v-if="cookie.httpOnly" size="tiny" :bordered="false">HttpOnly</n-tag>
                  <n-tag v-if="!cookie.hostOnly" size="tiny" :bordered="false" type="info">{{ t('request.domainTag') }}</n-tag>
                </span>
                <span class="cell action">
                  <n-button size="tiny" quaternary type="error" @click="removeOne(cookie)">
                    {{ t('app.delete') }}
                  </n-button>
                </span>
              </div>
            </div>
          </div>
        </div>

        <n-empty v-else-if="!loading" size="small" :description="t('request.emptyCookies')" class="empty" />
      </n-spin>
    </div>

    <n-modal
      v-model:show="showAdd"
      preset="card"
      :title="t('request.addCookieTitle')"
      style="width: 520px; max-width: 94vw"
    >
      <n-form label-placement="top">
        <n-form-item :label="t('request.domainLabel')">
          <n-input v-model:value="addForm.domain" :placeholder="t('request.domainPlaceholder')" />
        </n-form-item>
        <n-form-item :label="t('request.name')">
          <n-input v-model:value="addForm.name" placeholder="sid" />
        </n-form-item>
        <n-form-item :label="t('request.value')">
          <n-input v-model:value="addForm.value" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" />
        </n-form-item>
        <n-form-item :label="t('request.path')">
          <n-input v-model:value="addForm.path" placeholder="/" />
        </n-form-item>
        <n-form-item :label="t('request.expiresLabel')">
          <n-input
            v-model:value="addForm.expires"
            :placeholder="t('request.expiresPlaceholder')"
          />
        </n-form-item>
        <n-space align="center" :size="16">
          <n-checkbox v-model:checked="addForm.secure">{{ t('request.secureCheckbox') }}</n-checkbox>
          <n-checkbox v-model:checked="addForm.httpOnly">HttpOnly</n-checkbox>
        </n-space>
      </n-form>

      <template #footer>
        <n-space justify="end">
          <n-button @click="showAdd = false">{{ t('app.cancel') }}</n-button>
          <n-button type="primary" :loading="adding" @click="submitAdd">{{ t('request.save') }}</n-button>
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
