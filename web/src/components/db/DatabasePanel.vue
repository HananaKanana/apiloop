<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NButton,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpace,
  useMessage
} from 'naive-ui';
import { useEnvStore, MOCK_ENV_ID } from '@/stores/env';
import { testConnection } from '@/api/db';
import {
  DEFAULT_PORTS,
  TYPE_OPTIONS,
  addressOf,
  newConnection,
  passwordWarning,
  typeLabel,
  withType
} from '@/utils/db';

/**
 * 项目设置里的「数据库连接」（第九轮第 3 节）。
 *
 * 连接是**项目级**的，跟着 `PUT /projects/:pid` 一起保存（`extra.databases`），
 * 所以这里只有一张列表 + 一个编辑弹窗，没有单独的增删改接口。
 *
 * 密码那一格会同步给项目里所有人 —— 这是这一块最容易被忽略的地方，所以填了明文就黄字提醒。
 * 组件本身不碰 store 的保存动作：改哪一份由父组件决定（它持有表单），和别的设置块一样。
 */
const props = defineProps({
  databases: { type: Array, default: function () { return []; } },
  /** 只读角色：一个都不能改（连「测试连接」也不给 —— 那是拿库密码去连真库） */
  disabled: { type: Boolean, default: false },
  /** 测试连接要带项目 id（接口挂在这个项目下） */
  pid: { type: String, default: '' },
  /**
   * 是不是在客户端里（本机网关上）。网页版连不了数据库：云端不该拿着库密码去连库，
   * 「测试连接」的接口也只在客户端上有 —— 所以网页版上整块只读，只能看（用户 2026-10-04 要求）。
   */
  localAllowed: { type: Boolean, default: true }
});

/** 能不能改：只读角色不能，网页版也不能 */
const locked = computed(function () { return props.disabled || !props.localAllowed; });

const emit = defineEmits(['update:databases']);

const env = useEnvStore();
const message = useMessage();
const { t } = useI18n();

const databases = computed(function () { return props.databases || []; });

const editing = ref(null);
const showEditor = ref(false);
const testing = ref(false);
const testResult = ref(null);

/** 编辑弹窗的标题：有名字就带上，没名字就是新增 */
const editorTitle = computed(function () {
  const row = editing.value;
  return row && row.name
    ? t('db.editConnectionTitle', { name: row.name })
    : t('db.newConnectionTitle');
});

/** 选中的环境（内置 Mock 环境不存库，测试连接时当没选 —— 和提取变量的口径一致） */
const environmentId = computed(function () {
  return env.selectedId && env.selectedId !== MOCK_ENV_ID ? env.selectedId : '';
});

const warning = computed(function () {
  return editing.value ? passwordWarning(editing.value) : '';
});

function openNew() {
  editing.value = newConnection();
  testResult.value = null;
  showEditor.value = true;
}

function openEdit(row) {
  editing.value = JSON.parse(JSON.stringify(row));
  testResult.value = null;
  showEditor.value = true;
}

function closeEditor() {
  showEditor.value = false;
  editing.value = null;
  testResult.value = null;
}

function patch(changes) {
  editing.value = Object.assign({}, editing.value, changes);
  // 改了任何一个字段，上一次的测试结果就不算数了
  testResult.value = null;
}

function onTypeChange(type) {
  editing.value = withType(editing.value, type);
  testResult.value = null;
}

function save() {
  const row = editing.value;
  if (!String(row.name || '').trim()) {
    message.warning(t('db.nameRequired'));
    return;
  }
  if (!String(row.host || '').trim()) {
    message.warning(t('db.hostRequired'));
    return;
  }

  const exists = databases.value.some(function (item) { return item.id === row.id; });
  const next = exists
    ? databases.value.map(function (item) { return (item.id === row.id ? row : item); })
    : databases.value.concat([row]);

  emit('update:databases', next);
  closeEditor();
}

function remove(row) {
  emit('update:databases', databases.value.filter(function (item) { return item.id !== row.id; }));
}

async function runTest() {
  if (!props.pid) return;
  testing.value = true;
  testResult.value = null;
  try {
    const data = await testConnection(props.pid, {
      connection: editing.value,
      environmentId: environmentId.value || undefined
    });
    testResult.value = { ok: data.ok === true, timeMs: data.timeMs, error: data.error };
  } catch (err) {
    testResult.value = { ok: false, error: err.message };
  } finally {
    testing.value = false;
  }
}

/** 没选环境时连接里的 {{变量}} 替换不出来，先把话说在前面 */
const noEnvironment = computed(function () { return !environmentId.value; });

/**
 * 模板里不能直接写 `{{ '{{变量}}' }}` —— 字符串里的 `}}` 会把插值提前关掉。
 * 提示文案统一放在 script 里（AssertionsPane 也是这么办的）。
 */
const varSample = computed(function () { return t('db.varSample'); });
const varPassword = computed(function () { return t('db.varPassword'); });
const hostPlaceholder = computed(function () { return t('db.hostPlaceholder'); });
const passwordPlaceholder = computed(function () { return t('db.passwordPlaceholder'); });
</script>

<template>
  <div class="block">
    <p class="hint">
      {{ t('db.hintLead') }} <code>{{ varSample }}</code> {{ t('db.hintMid') }}
      <code>{{ varPassword }}</code> {{ t('db.hintTail') }}
    </p>

    <div class="table">
      <div class="row head">
        <div class="cell">{{ t('db.name') }}</div>
        <div class="cell">{{ t('db.type') }}</div>
        <div class="cell">{{ t('db.address') }}</div>
        <div class="cell action" />
      </div>

      <div v-for="row in databases" :key="row.id" class="row">
        <div class="cell">{{ row.name }}</div>
        <div class="cell">{{ typeLabel(row.type) }}</div>
        <div class="cell mono">{{ addressOf(row) }}</div>
        <div class="cell action">
          <n-button v-if="!locked" size="tiny" quaternary @click="openEdit(row)">{{ t('db.edit') }}</n-button>
          <n-button v-if="!locked" size="tiny" quaternary type="error" @click="remove(row)">{{ t('app.delete') }}</n-button>
        </div>
      </div>

      <div v-if="!databases.length" class="empty">
        {{ t('db.emptyConnections') }}
      </div>
    </div>

    <div v-if="!locked" class="tools">
      <n-button size="small" @click="openNew">{{ t('db.addConnection') }}</n-button>
    </div>
    <p v-if="!localAllowed" class="hint">{{ t('db.webUnavailable') }}</p>
    <p v-else-if="disabled" class="hint">{{ t('db.readonlyHint') }}</p>

    <n-modal
      :show="showEditor"
      preset="card"
      :title="editorTitle"
      style="width: 520px"
      :mask-closable="false"
      @update:show="(v) => { if (!v) closeEditor(); }"
    >
      <n-form v-if="editing" label-placement="left" label-width="80" size="small">
        <n-form-item :label="t('db.name')">
          <n-input
            :value="editing.name"
            :placeholder="t('db.namePlaceholder')"
            @update:value="(v) => patch({ name: v })"
          />
        </n-form-item>

        <n-form-item :label="t('db.type')">
          <n-select
            :value="editing.type"
            :options="TYPE_OPTIONS"
            @update:value="onTypeChange"
          />
        </n-form-item>

        <n-form-item :label="t('db.host')">
          <n-input
            :value="editing.host"
            :placeholder="hostPlaceholder"
            @update:value="(v) => patch({ host: v })"
          />
        </n-form-item>

        <n-form-item :label="t('db.port')">
          <n-input
            :value="editing.port === null || editing.port === undefined ? '' : String(editing.port)"
            :placeholder="t('db.portPlaceholder', { port: DEFAULT_PORTS[editing.type] || '' })"
            @update:value="(v) => patch({ port: v })"
          />
        </n-form-item>

        <n-form-item :label="t('db.user')">
          <n-input
            :value="editing.user"
            :placeholder="editing.type === 'redis' ? t('db.userPlaceholderRedis') : 'root'"
            @update:value="(v) => patch({ user: v })"
          />
        </n-form-item>

        <n-form-item :label="t('db.password')">
          <div class="password-cell">
            <n-input
              :value="editing.password"
              type="password"
              show-password-on="click"
              :placeholder="passwordPlaceholder"
              @update:value="(v) => patch({ password: v })"
            />
            <p v-if="warning" class="warn">{{ warning }}</p>
          </div>
        </n-form-item>

        <n-form-item :label="editing.type === 'redis' ? t('db.labelRedisDb') : t('db.labelDatabase')">
          <n-input
            :value="editing.database"
            :placeholder="editing.type === 'redis' ? t('db.dbIndexPlaceholder') : 'demo'"
            @update:value="(v) => patch({ database: v })"
          />
        </n-form-item>
      </n-form>

      <p v-if="noEnvironment" class="hint">
        {{ t('db.noEnvLead') }} <code>{{ varSample }}</code> {{ t('db.noEnvTail') }}
      </p>

      <div v-if="testResult" class="result" :class="{ bad: !testResult.ok }">
        <template v-if="testResult.ok">{{ t('db.testOk', { ms: testResult.timeMs }) }}</template>
        <template v-else>{{ t('db.testFail', { error: testResult.error }) }}</template>
      </div>

      <template #footer>
        <n-space justify="space-between" align="center" style="width: 100%">
          <n-button size="small" :loading="testing" @click="runTest">{{ t('db.testConnection') }}</n-button>
          <n-space>
            <n-button size="small" @click="closeEditor">{{ t('app.cancel') }}</n-button>
            <n-button size="small" type="primary" @click="save">{{ t('app.confirm') }}</n-button>
          </n-space>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.block {
  display: block;
}

.hint {
  margin: 0 0 8px;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.7;
}

.hint code {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(128, 128, 128, 0.16);
}

.table {
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 4px;
  overflow: hidden;
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 110px minmax(0, 1fr) 120px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.14));
}

.row:last-child {
  border-bottom: none;
}

.row.head {
  background: rgba(128, 128, 128, 0.07);
  font-size: 12px;
  opacity: 0.7;
}

.cell {
  min-width: 0;
  display: flex;
  align-items: center;
  padding: 5px 8px;
  border-right: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.14));
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell:last-child {
  border-right: none;
}

.cell.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.cell.action {
  justify-content: flex-end;
  gap: 2px;
}

.empty {
  padding: 10px 12px;
  font-size: 12px;
  opacity: 0.55;
}

.tools {
  margin-top: 8px;
}

.password-cell {
  width: 100%;
}

.warn {
  margin: 6px 0 0;
  font-size: 12px;
  color: #f0a020;
}

.result {
  margin-top: 10px;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
  color: #18a058;
  background: rgba(24, 160, 88, 0.12);
  word-break: break-all;
}

.result.bad {
  color: #d03050;
  background: rgba(208, 48, 80, 0.12);
}
</style>
