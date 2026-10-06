<script setup>
import { computed, h } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NDataTable, NModal, NSpace, useMessage } from 'naive-ui';
import { useTrashStore } from '@/stores/trash';
import { useProjectStore } from '@/stores/project';
import { useDialog } from '@/utils/dialog';

/**
 * 回收站弹窗（第三轮第 1 节）。
 *
 * 删掉的目录 / 接口 / 环境在这里保留 30 天，团队成员都能看到；viewer 只能看，
 * 恢复 / 彻底删除的按钮对它不显示（服务端也会再挡一次）。
 */
const props = defineProps({
  show: { type: Boolean, default: false }
});
const emit = defineEmits(['update:show']);

const trash = useTrashStore();
const projects = useProjectStore();
const message = useMessage();
const dialog = useDialog();
const { t } = useI18n();

const show = computed({
  get: function () { return props.show; },
  set: function (value) { emit('update:show', value); }
});

/** 回收站三列。用 computed 包住（表头和类型名都要跟着语言变） */
const KIND_LABEL = computed(function () {
  return { folder: t('trash.kindFolder'), api: t('trash.kindApi'), environment: t('trash.kindEnv') };
});

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTime(ts) {
  if (!ts) return '';
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return '';
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

async function onRestore(row) {
  try {
    const data = await trash.restore(row.id);
    message.success(t('trash.restoredTo', { where: data.restoredTo || t('trash.originalLocation') }));
  } catch (err) {
    message.error(err.message);
  }
}

function onRemove(row) {
  dialog.error({
    title: t('trash.deleteForever'),
    content: t('trash.deleteForeverBody', { name: row.name }),
    positiveText: t('trash.deleteForever'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        await trash.remove(row.id);
        message.success(t('trash.deletedForever'));
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

function onClear() {
  if (!trash.items.length) return;
  dialog.error({
    title: t('trash.clearTitle'),
    content: t('trash.clearBody', { n: trash.items.length }),
    positiveText: t('trash.clearAction'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        await trash.clear();
        message.success(t('trash.cleared'));
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

const columns = computed(function () {
  const list = [
    { title: t('trash.colName'), key: 'name', ellipsis: { tooltip: true } },
    {
      title: t('trash.colKind'),
      key: 'kind',
      width: 68,
      render: function (row) { return KIND_LABEL.value[row.kind] || row.kind; }
    },
    { title: t('trash.colLocation'), key: 'location', width: 150, ellipsis: { tooltip: true } },
    {
      title: t('trash.colDeletedBy'),
      key: 'deletedBy',
      width: 96,
      render: function (row) { return (row.deletedBy && row.deletedBy.displayName) || '—'; }
    },
    {
      title: t('trash.colDeletedAt'),
      key: 'deletedAt',
      width: 132,
      render: function (row) { return formatTime(row.deletedAt); }
    }
  ];

  if (projects.canEdit) {
    list.push({
      title: t('trash.colActions'),
      key: 'actions',
      width: 150,
      align: 'right',
      render: function (row) {
        return h(NSpace, { size: 4, justify: 'end', wrap: false }, {
          default: function () {
            return [
              h(NButton, { size: 'tiny', onClick: function () { onRestore(row); } },
                { default: function () { return t('trash.restore'); } }),
              h(NButton, {
                size: 'tiny',
                type: 'error',
                ghost: true,
                onClick: function () { onRemove(row); }
              }, { default: function () { return t('trash.deleteForever'); } })
            ];
          }
        });
      }
    });
  }

  return list;
});
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="t('trash.title')"
    style="width: 780px; max-width: 94vw"
  >
    <p class="hint">{{ t('trash.hint') }}</p>

    <div class="head">
      <span class="count">{{ t('trash.countLabel', { n: trash.items.length }) }}</span>
      <n-button
        v-if="projects.canEdit"
        size="small"
        :disabled="!trash.items.length"
        @click="onClear"
      >
        {{ t('trash.clearTitle') }}
      </n-button>
    </div>

    <n-data-table
      size="small"
      :bordered="false"
      :columns="columns"
      :data="trash.items"
      :loading="trash.loading"
      :max-height="420"
    />
  </n-modal>
</template>

<style scoped>
.hint {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.6;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.count {
  font-size: 12px;
  opacity: 0.7;
}
</style>
