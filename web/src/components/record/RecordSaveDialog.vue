<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NCheckbox,
  NModal,
  NSelect,
  NSpace,
  NSwitch
} from 'naive-ui';
import { useTreeStore } from '@/stores/tree';

/**
 * 「保存所选」的确认弹窗。
 *
 * 录到的记录分两组：**对上了已有接口的**存成那个接口的示例；**没对上的**顺手新建接口
 * （新建的放到哪个目录在这里选）。两个开关（参数化、设为 Mock 返回）默认都开。
 *
 * 真正写库在父组件里做（那边要管消息提示、刷新目录树、把保存过的从选中里去掉），
 * 这里只负责收选项、emit `confirm`。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  /** 对上已有接口的记录 */
  matched: { type: Array, default: function () { return []; } },
  /** 没对上的记录（会新建接口） */
  unmatched: { type: Array, default: function () { return []; } },
  saving: { type: Boolean, default: false }
});

const emit = defineEmits(['update:show', 'confirm']);
const tree = useTreeStore();
const { t } = useI18n();

const visible = computed({
  get: function () { return props.show; },
  set: function (value) { emit('update:show', value); }
});

const folderId = ref(null);
const paramize = ref(true);
const setMock = ref(true);

// 每次打开都回到默认：目录不选（根目录）、两个开关都开
watch(
  function () { return props.show; },
  function (open) {
    if (!open) return;
    folderId.value = null;
    paramize.value = true;
    setMock.value = true;
  }
);

/** 目录下拉：扁平列表 + 完整路径当标签（子目录缩进一点） */
const folderOptions = computed(function () {
  const byId = new Map();
  (tree.folders || []).forEach(function (folder) { byId.set(folder.id, folder); });

  function pathOf(folder) {
    const parts = [];
    let current = folder;
    let guard = 0;
    while (current && guard < 20) {
      parts.unshift(current.name);
      current = current.parentId ? byId.get(current.parentId) : null;
      guard += 1;
    }
    return parts.join(' / ');
  }

  return (tree.folders || []).map(function (folder) {
    const depth = pathOf(folder).split(' / ').length - 1;
    return {
      label: '　'.repeat(depth) + folder.name,
      value: folder.id,
      title: pathOf(folder)
    };
  });
});

function confirm() {
  emit('confirm', {
    folderId: folderId.value,
    paramize: paramize.value,
    setMock: setMock.value
  });
}

function pathOf(entry) {
  return entry.path + (entry.query ? '?' + entry.query : '');
}
</script>

<template>
  <n-modal
    v-model:show="visible"
    preset="card"
    :title="t('record.saveDialogTitle')"
    class="save-modal"
    :bordered="false"
    :mask-closable="!saving"
  >
    <div class="body">
      <div v-if="matched.length" class="group">
        <p class="label">{{ t('record.saveMatchedGroup', { n: matched.length }) }}</p>
        <p class="hint">{{ t('record.saveMatchedHint') }}</p>
        <ul class="rows">
          <li v-for="entry in matched.slice(0, 8)" :key="entry.id">
            <span class="m">{{ entry.method }}</span> {{ pathOf(entry) }}
            <span class="to">→ {{ entry.match.apiName }}</span>
          </li>
        </ul>
        <p v-if="matched.length > 8" class="more">{{ t('record.moreItems', { n: matched.length - 8 }) }}</p>
      </div>

      <div v-if="unmatched.length" class="group">
        <p class="label">{{ t('record.createGroup', { n: unmatched.length }) }}</p>
        <p class="hint">{{ t('record.createHint') }}</p>
        <ul class="rows">
          <li v-for="entry in unmatched.slice(0, 8)" :key="entry.id">
            <span class="m">{{ entry.method }}</span> {{ pathOf(entry) }}
          </li>
        </ul>
        <p v-if="unmatched.length > 8" class="more">{{ t('record.moreCreated', { n: unmatched.length - 8 }) }}</p>

        <div class="field">
          <span class="field-label">{{ t('record.folderLabel') }}</span>
          <n-select
            v-model:value="folderId"
            size="small"
            clearable
            :placeholder="t('record.rootFolder')"
            :options="folderOptions"
          />
        </div>
      </div>

      <div class="options">
        <n-checkbox v-if="unmatched.length" v-model:checked="paramize">
          {{ t('record.paramize') }}
        </n-checkbox>
        <n-checkbox v-model:checked="setMock">
          {{ t('record.setMock') }}
        </n-checkbox>
      </div>
    </div>

    <template #footer>
      <n-space justify="end">
        <n-button :disabled="saving" @click="visible = false">{{ t('app.cancel') }}</n-button>
        <n-button type="primary" :loading="saving" @click="confirm">
          {{ t('record.saveCount', { n: matched.length + unmatched.length }) }}
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.save-modal {
  width: 560px;
  max-width: calc(100vw - 32px);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.label {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}

.rows {
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
  max-height: 150px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.9;
}

.rows li {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rows .m {
  display: inline-block;
  min-width: 44px;
  opacity: 0.6;
}

.rows .to {
  opacity: 0.6;
}

.more {
  margin: 0;
  font-size: 12px;
  opacity: 0.5;
}

.field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.field-label {
  flex: none;
  font-size: 12px;
  opacity: 0.7;
}

.field :deep(.n-select) {
  flex: 1;
}

.options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid var(--apiloop-divider);
}
</style>
