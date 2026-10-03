<script setup>
import { computed, ref, watch } from 'vue';
import { NButton, NForm, NFormItem, NModal, NRadio, NRadioGroup, NSpace, useMessage } from 'naive-ui';
import * as importExportApi from '@/api/importExport';
import { downloadText } from '@/utils/download';

/**
 * 导出 OpenAPI 的小弹窗（第四轮第 2 节）。
 *
 * 只问一件事：格式（默认 YAML）。范围由调用方定 —— 项目菜单进来是整个项目，
 * 目录右键进来是那个目录（含子目录），服务端按 `folderId` 划。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  pid: { type: String, default: '' },
  /** 空表示整个项目 */
  folderId: { type: String, default: null },
  scopeName: { type: String, default: '' }
});
const emit = defineEmits(['update:show']);

const message = useMessage();
const format = ref('yaml');
const exporting = ref(false);

const show = computed({
  get: function () { return props.show; },
  set: function (value) { emit('update:show', value); }
});

/**
 * 提示文案放在 script 里：模板的 `{{ }}` 插值里不能出现 `}}`，
 * 而这句话里正好要写一个 `{{host}}`。
 */
const HINT = '变量（{{host}} 这类）原样保留；鉴权只导出类型，不导出值。';

const title = computed(function () {
  return props.scopeName ? '导出为 OpenAPI：' + props.scopeName : '导出为 OpenAPI';
});

// 每次打开都回到默认的 YAML
watch(function () { return props.show; }, function (value) {
  if (value) format.value = 'yaml';
});

async function confirm() {
  if (!props.pid) return;

  exporting.value = true;
  try {
    const data = await importExportApi.exportOpenapi(props.pid, {
      folderId: props.folderId || null,
      format: format.value
    });
    // YAML 的 mime 用 text/yaml；浏览器对扩展名更敏感，mime 只是个提示
    downloadText(data.filename, data.text, format.value === 'json' ? 'application/json' : 'text/yaml');
    message.success('已导出');
    show.value = false;
  } catch (err) {
    message.error(err.message);
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="title"
    style="width: 460px; max-width: 92vw"
  >
    <n-form>
      <n-form-item label="格式">
        <n-radio-group v-model:value="format">
          <n-space>
            <n-radio value="yaml">YAML</n-radio>
            <n-radio value="json">JSON</n-radio>
          </n-space>
        </n-radio-group>
      </n-form-item>
    </n-form>

    <p class="hint">{{ HINT }}</p>

    <template #footer>
      <n-space justify="end">
        <n-button @click="show = false">取消</n-button>
        <n-button type="primary" :loading="exporting" @click="confirm">导出</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.6;
}
</style>
