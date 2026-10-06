<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NCheckbox,
  NIcon,
  NInput,
  NInputNumber,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NSwitch,
  useMessage
} from 'naive-ui';
import { Plus, Trash } from '@vicons/tabler';
import * as treeApi from '@/api/tree';

/**
 * 「Mock 故障模拟」设置面板（第七轮第 1 节）。
 *
 * 前端要测「接口报错时提示对不对」「慢的时候有没有加载状态」「失败后会不会重试」，
 * 可 Mock 永远秒回、永远成功。这里让整个项目按比例故意出错。
 *
 * 值就是 `projects.extra.mockFaults` 那一份（`v-model` 传出去，由项目设置页保存）：
 * `{ enabled, scope: { type, ids }, rules: [...] }`。
 *
 * 三条要一直提醒用户的事，界面上都写了：**开着会影响所有调这个项目 Mock 的人**、
 * 只对普通 HTTP 响应生效（SSE / WebSocket 不管）、带 `X-Apiloop-Fault: off` 可以绕过。
 */
const props = defineProps({
  modelValue: { type: Object, default: null },
  /** 作用范围要列目录和接口，用这个去拉目录树 */
  pid: { type: String, default: '' },
  disabled: { type: Boolean, default: false }
});

const emit = defineEmits(['update:modelValue']);

const message = useMessage();
const { t } = useI18n();

/** 故障类型。用 computed 包住，切语言后选项跟着变 */
const RULE_TYPES = computed(function () {
  return [
    { label: t('mock.faultError'), value: 'error' },
    { label: t('mock.faultDelay'), value: 'delay' },
    { label: t('mock.faultTimeout'), value: 'timeout' },
    { label: t('mock.faultDisconnect'), value: 'disconnect' },
    { label: t('mock.faultThrottle'), value: 'throttle' }
  ];
});

const DEFAULT_BODY = computed(function () {
  return t('mock.faultDefaultBody');
});

function emptyFaults() {
  return { enabled: false, scope: { type: 'all', ids: [] }, rules: [] };
}

const faults = computed(function () {
  return props.modelValue || emptyFaults();
});

/** 一律**整份换新对象**再传出去：直接改 props 里那个对象，外面的 form 察觉不到 */
function patchFaults(patch) {
  emit('update:modelValue', Object.assign({}, faults.value, patch));
}

function newRuleId() {
  return 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
}

/** 新加一条规则时按类型给一套能直接跑的默认值 */
function defaultRule(type) {
  const base = { id: newRuleId(), enabled: true, type: type, percent: 100 };

  if (type === 'error') return Object.assign(base, { status: 500, body: DEFAULT_BODY.value });
  if (type === 'delay') return Object.assign(base, { minMs: 1000, maxMs: 3000 });
  if (type === 'timeout') return Object.assign(base, { timeoutMs: 30000 });
  if (type === 'throttle') return Object.assign(base, { retryAfter: 1 });
  return base;
}

function addRule(type) {
  patchFaults({ rules: faults.value.rules.concat([defaultRule(type || 'error')]) });
}

function updateRule(index, patch) {
  const rules = faults.value.rules.slice();
  rules[index] = Object.assign({}, rules[index], patch);
  patchFaults({ rules: rules });
}

/** 换类型时把参数换成新类型的那一套（老参数留着只会让人以为还生效） */
function changeRuleType(index, type) {
  const next = defaultRule(type);
  next.id = faults.value.rules[index].id;
  next.enabled = faults.value.rules[index].enabled;

  const rules = faults.value.rules.slice();
  rules[index] = next;
  patchFaults({ rules: rules });
}

function removeRule(index) {
  const rules = faults.value.rules.slice();
  rules.splice(index, 1);
  patchFaults({ rules: rules });
}

/* ---------------- 快速预设 ---------------- */

const PRESETS = computed(function () {
  return [
    {
      key: 'slow',
      label: t('mock.presetSlow'),
      rules: [{ type: 'delay', percent: 50, minMs: 1000, maxMs: 3000 }]
    },
    {
      key: 'flaky',
      label: t('mock.presetFlaky'),
      rules: [{ type: 'error', percent: 10, status: 500, body: DEFAULT_BODY.value }]
    },
    {
      key: 'down',
      label: t('mock.presetDown'),
      rules: [{ type: 'error', percent: 100, status: 500, body: DEFAULT_BODY.value }]
    }
  ];
});

/** 预设是**填进规则表**（整份换掉），不是另外存一份；填完还是未保存状态 */
function applyPreset(preset) {
  patchFaults({
    enabled: true,
    scope: { type: 'all', ids: [] },
    rules: preset.rules.map(function (rule) {
      return Object.assign(defaultRule(rule.type), rule, { id: newRuleId() });
    })
  });
  message.success(t('mock.presetApplied'));
}

/* ---------------- 作用范围 ---------------- */

const scopeType = computed(function () {
  return faults.value.scope ? faults.value.scope.type : 'all';
});

function changeScope(type) {
  patchFaults({ scope: { type: type, ids: [] } });
}

const folderOptions = ref([]);
const apiOptions = ref([]);
const loadingTree = ref(false);

/** 目录 / 接口的选项**现拉一次**（作用范围是 folders / apis 时才需要） */
async function loadTree() {
  if (!props.pid || (folderOptions.value.length && apiOptions.value.length)) return;

  loadingTree.value = true;
  try {
    const data = await treeApi.getTree(props.pid);

    const byId = {};
    (data.folders || []).forEach(function (folder) { byId[folder.id] = folder; });

    function label(folder) {
      const chain = [];
      let current = folder;
      let guard = 0;
      while (current && guard < 32) {
        guard += 1;
        chain.unshift(current.name);
        current = current.parentId ? byId[current.parentId] : null;
      }
      return chain.join(' / ');
    }

    folderOptions.value = (data.folders || []).map(function (folder) {
      return { label: label(folder), value: folder.id };
    });

    apiOptions.value = (data.apis || []).map(function (api) {
      return {
        label: api.method + ' ' + api.url + (api.name ? '（' + api.name + '）' : ''),
        value: api.id
      };
    });
  } catch (err) {
    message.error(err.message);
  } finally {
    loadingTree.value = false;
  }
}

watch(function () { return [props.pid, scopeType.value]; }, function (value) {
  if (value[1] === 'folders' || value[1] === 'apis') loadTree();
}, { immediate: true });

function scopeIds() {
  return (faults.value.scope && faults.value.scope.ids) || [];
}

function changeScopeIds(ids) {
  patchFaults({ scope: { type: scopeType.value, ids: ids } });
}

const enabledRuleCount = computed(function () {
  return faults.value.rules.filter(function (rule) { return rule.enabled !== false; }).length;
});
</script>

<template>
  <div class="faults">
    <div class="head">
      <n-switch
        :value="faults.enabled === true"
        :disabled="disabled"
        size="small"
        @update:value="(value) => patchFaults({ enabled: value })"
      />
      <span class="head-label">{{ t('mock.faultEnable') }}</span>
      <span v-if="faults.enabled" class="head-count">
        {{ t('mock.faultRulesActive', { n: enabledRuleCount }) }}
      </span>
    </div>

    <n-alert v-if="faults.enabled" type="warning" :show-icon="false" class="warn">
      {{ t('mock.faultWarnLead') }}<strong>{{ t('mock.faultWarnStrong') }}</strong>{{ t('mock.faultWarnTail') }}
    </n-alert>

    <!-- 作用范围 -->
    <div class="block">
      <div class="block-title">{{ t('mock.faultScope') }}</div>
      <n-radio-group
        :value="scopeType"
        size="small"
        :disabled="disabled"
        @update:value="changeScope"
      >
        <n-radio-button value="all">{{ t('mock.scopeAll') }}</n-radio-button>
        <n-radio-button value="folders">{{ t('mock.scopeFolders') }}</n-radio-button>
        <n-radio-button value="apis">{{ t('mock.scopeApis') }}</n-radio-button>
      </n-radio-group>

      <div v-if="scopeType === 'folders'" class="scope-picker">
        <n-select
          multiple
          filterable
          size="small"
          :disabled="disabled"
          :loading="loadingTree"
          :options="folderOptions"
          :value="scopeIds()"
          :placeholder="t('mock.scopeFoldersPlaceholder')"
          @update:value="changeScopeIds"
        />
      </div>

      <div v-else-if="scopeType === 'apis'" class="scope-picker">
        <n-select
          multiple
          filterable
          size="small"
          :disabled="disabled"
          :loading="loadingTree"
          :options="apiOptions"
          :value="scopeIds()"
          :placeholder="t('mock.scopeApisPlaceholder')"
          @update:value="changeScopeIds"
        />
      </div>
    </div>

    <!-- 规则表 -->
    <div class="block">
      <div class="block-title">
        {{ t('mock.faultRulesTitle') }}
        <span class="block-note">{{ t('mock.rulesNote') }}</span>
      </div>

      <div v-if="faults.rules.length" class="grid">
        <div class="grid-head">
          <span class="col-enabled">{{ t('mock.colEnabled') }}</span>
          <span class="col-type">{{ t('mock.colFaultType') }}</span>
          <span class="col-percent">{{ t('mock.colPercent') }}</span>
          <span class="col-params">{{ t('mock.colParams') }}</span>
          <span class="col-actions" />
        </div>

        <div v-for="(rule, index) in faults.rules" :key="rule.id" class="grid-row">
          <span class="col-enabled">
            <n-checkbox
              :checked="rule.enabled !== false"
              :disabled="disabled"
              @update:checked="(value) => updateRule(index, { enabled: value })"
            />
          </span>

          <span class="col-type">
            <n-select
              size="tiny"
              :disabled="disabled"
              :options="RULE_TYPES"
              :value="rule.type"
              @update:value="(value) => changeRuleType(index, value)"
            />
          </span>

          <span class="col-percent">
            <n-input-number
              size="tiny"
              :disabled="disabled"
              :min="0"
              :max="100"
              :value="rule.percent"
              @update:value="(value) => updateRule(index, { percent: value === null ? 0 : value })"
            >
              <template #suffix>%</template>
            </n-input-number>
          </span>

          <span class="col-params">
            <template v-if="rule.type === 'error'">
              <n-input-number
                class="status-input"
                size="tiny"
                :disabled="disabled"
                :min="100"
                :max="599"
                :value="rule.status"
                @update:value="(value) => updateRule(index, { status: value === null ? 500 : value })"
              />
              <n-input
                class="body-input"
                size="tiny"
                :disabled="disabled"
                :value="rule.body"
                :placeholder="t('mock.faultBodyPlaceholder')"
                @update:value="(value) => updateRule(index, { body: value })"
              />
            </template>

            <template v-else-if="rule.type === 'delay'">
              <n-input-number
                class="ms-input"
                size="tiny"
                :disabled="disabled"
                :min="0"
                :value="rule.minMs"
                @update:value="(value) => updateRule(index, { minMs: value === null ? 0 : value })"
              />
              <span class="dash">–</span>
              <n-input-number
                class="ms-input"
                size="tiny"
                :disabled="disabled"
                :min="0"
                :value="rule.maxMs"
                @update:value="(value) => updateRule(index, { maxMs: value === null ? 0 : value })"
              />
              <span class="unit">{{ t('mock.unitDelay') }}</span>
            </template>

            <template v-else-if="rule.type === 'timeout'">
              <n-input-number
                class="ms-input"
                size="tiny"
                :disabled="disabled"
                :min="0"
                :value="rule.timeoutMs"
                @update:value="(value) => updateRule(index, { timeoutMs: value === null ? 0 : value })"
              />
              <span class="unit">{{ t('mock.unitTimeout') }}</span>
            </template>

            <template v-else-if="rule.type === 'throttle'">
              <n-input-number
                class="ms-input"
                size="tiny"
                :disabled="disabled"
                :min="0"
                :value="rule.retryAfter"
                @update:value="(value) => updateRule(index, { retryAfter: value === null ? 0 : value })"
              />
              <span class="unit">{{ t('mock.unitThrottle') }}</span>
            </template>

            <span v-else class="unit">{{ t('mock.disconnectNote') }}</span>
          </span>

          <span class="col-actions">
            <n-button
              size="tiny"
              quaternary
              :disabled="disabled"
              :title="t('mock.removeRule')"
              @click="removeRule(index)"
            >
              <template #icon>
                <n-icon :component="Trash" />
              </template>
            </n-button>
          </span>
        </div>
      </div>

      <p v-else class="empty">{{ t('mock.noRules') }}</p>

      <n-space align="center" :size="8" class="add-row">
        <n-button size="small" :disabled="disabled" @click="addRule('error')">
          <template #icon>
            <n-icon :component="Plus" />
          </template>
          {{ t('mock.addRule') }}
        </n-button>
        <span class="block-note">{{ t('mock.presetsLabel') }}</span>
        <n-button
          v-for="preset in PRESETS"
          :key="preset.key"
          size="small"
          secondary
          :disabled="disabled"
          @click="applyPreset(preset)"
        >
          {{ preset.label }}
        </n-button>
      </n-space>
    </div>

    <p class="tip">
      {{ t('mock.faultTipLead') }}<code>X-Apiloop-Fault: off</code>{{ t('mock.faultTipTail') }}
    </p>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.head-label {
  font-size: 13px;
  font-weight: 500;
}

.head-count {
  font-size: 12px;
  opacity: 0.6;
}

.warn {
  margin-top: 10px;
}

.block {
  margin-top: 14px;
}

.block-title {
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.75;
}

.block-note {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  opacity: 0.55;
}

.scope-picker {
  margin-top: 8px;
  max-width: 620px;
}

.grid {
  margin-top: 8px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.18));
  border-radius: 6px;
  overflow: hidden;
}

.grid-head,
.grid-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
}

.grid-head {
  height: 30px;
  font-size: 12px;
  opacity: 0.6;
  background: rgba(128, 128, 128, 0.06);
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.18));
}

.grid-row {
  min-height: 38px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
}

.grid-row:last-child {
  border-bottom: none;
}

.col-enabled {
  flex: none;
  width: 40px;
  display: flex;
  justify-content: center;
}

.col-type {
  flex: none;
  width: 118px;
}

.col-percent {
  flex: none;
  width: 92px;
}

.col-params {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.col-actions {
  flex: none;
  width: 30px;
  display: flex;
  justify-content: flex-end;
}

.status-input {
  flex: none;
  width: 92px;
}

.body-input {
  flex: 1;
  min-width: 0;
}

.ms-input {
  flex: none;
  width: 104px;
}

.dash {
  opacity: 0.5;
}

.unit {
  font-size: 12px;
  opacity: 0.55;
}

.empty {
  margin: 8px 0 0;
  font-size: 12px;
  opacity: 0.55;
}

.add-row {
  margin-top: 10px;
  flex-wrap: wrap;
}

.tip {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.8;
  opacity: 0.6;
}

.tip code {
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(128, 128, 128, 0.14);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
