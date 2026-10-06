<script setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInputNumber,
  NSelect,
  NSpace,
  NSwitch,
  useMessage
} from 'naive-ui';
import * as backupApi from '@/api/backup';

/**
 * 系统设置 → 「自动备份」（只有管理员能进这个页面）。
 *
 * 接口形状和代理那节一样包一层：`{ backup: { enabled, hour, keepDays } }`。
 * 这里自己读自己存（页头那个「保存」只管代理）。
 */
const { t } = useI18n();
const message = useMessage();

const loading = ref(true);
const saving = ref(false);
const errorText = ref('');

const form = ref({
  enabled: false,
  hour: 3,
  keepDays: 14
});

/** 每天几点：0–23 点，标签写成 03:00 这种（不用翻译） */
const hourOptions = computed(function () {
  const list = [];
  for (let hour = 0; hour < 24; hour += 1) {
    list.push({ label: String(hour).padStart(2, '0') + ':00', value: hour });
  }
  return list;
});

function fillFrom(backup) {
  form.value = {
    enabled: backup.enabled === true,
    hour: Number(backup.hour) || 0,
    keepDays: Number(backup.keepDays) || 14
  };
}

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const data = await backupApi.getBackupSetting();
    fillFrom(data.backup || {});
  } catch (err) {
    errorText.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    const data = await backupApi.updateBackupSetting({
      enabled: form.value.enabled,
      hour: form.value.hour,
      keepDays: form.value.keepDays
    });
    // 用服务端返回的覆盖本地：hour / keepDays 会被夹到合法范围
    fillFrom(data.backup || {});
    message.success(t('backup.settingsSaved'));
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <n-card :bordered="false" size="small" :title="t('backup.settingsTitle')">
    <n-alert v-if="errorText" type="error" :show-icon="false" class="alert">
      {{ errorText }}
    </n-alert>

    <template v-else>
      <p class="tip">{{ t('backup.settingsHint') }}</p>

      <n-form label-placement="top">
        <n-form-item :label="t('backup.settingsEnabled')">
          <n-switch v-model:value="form.enabled" :disabled="loading" />
        </n-form-item>

        <n-form-item :label="t('backup.settingsHour')">
          <n-select
            v-model:value="form.hour"
            :options="hourOptions"
            :disabled="loading || !form.enabled"
            style="width: 140px"
          />
        </n-form-item>

        <n-form-item :label="t('backup.settingsKeepDays')">
          <n-input-number
            v-model:value="form.keepDays"
            :min="1"
            :max="90"
            :disabled="loading || !form.enabled"
            style="width: 140px"
          />
        </n-form-item>
      </n-form>

      <p class="tip">{{ t('backup.settingsKeepHint') }}</p>

      <n-space>
        <n-button type="primary" size="small" :loading="saving" :disabled="loading" @click="save">
          {{ t('app.confirm') }}
        </n-button>
      </n-space>
    </template>
  </n-card>
</template>

<style scoped>
.alert {
  margin-bottom: 12px;
}

.tip {
  margin: 0 0 10px;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.7;
}
</style>
