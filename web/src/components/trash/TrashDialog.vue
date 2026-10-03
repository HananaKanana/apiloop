<script setup>
import { computed, h } from 'vue';
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

const show = computed({
  get: function () { return props.show; },
  set: function (value) { emit('update:show', value); }
});

const KIND_LABEL = { folder: '目录', api: '接口', environment: '环境' };

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
    message.success('已恢复到 ' + (data.restoredTo || '原位置'));
  } catch (err) {
    message.error(err.message);
  }
}

function onRemove(row) {
  dialog.error({
    title: '彻底删除',
    content: '「' + row.name + '」将被永久删除，不能再恢复。确定吗？',
    positiveText: '彻底删除',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await trash.remove(row.id);
        message.success('已彻底删除');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

function onClear() {
  if (!trash.items.length) return;
  dialog.error({
    title: '清空回收站',
    content: '回收站里的 ' + trash.items.length + ' 项将被永久删除，不能再恢复。确定吗？',
    positiveText: '清空',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await trash.clear();
        message.success('回收站已清空');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

const columns = computed(function () {
  const list = [
    { title: '名称', key: 'name', ellipsis: { tooltip: true } },
    {
      title: '类型',
      key: 'kind',
      width: 68,
      render: function (row) { return KIND_LABEL[row.kind] || row.kind; }
    },
    { title: '原位置', key: 'location', width: 150, ellipsis: { tooltip: true } },
    {
      title: '删除人',
      key: 'deletedBy',
      width: 96,
      render: function (row) { return (row.deletedBy && row.deletedBy.displayName) || '—'; }
    },
    {
      title: '删除时间',
      key: 'deletedAt',
      width: 132,
      render: function (row) { return formatTime(row.deletedAt); }
    }
  ];

  if (projects.canEdit) {
    list.push({
      title: '操作',
      key: 'actions',
      width: 150,
      align: 'right',
      render: function (row) {
        return h(NSpace, { size: 4, justify: 'end', wrap: false }, {
          default: function () {
            return [
              h(NButton, { size: 'tiny', onClick: function () { onRestore(row); } },
                { default: function () { return '恢复'; } }),
              h(NButton, {
                size: 'tiny',
                type: 'error',
                ghost: true,
                onClick: function () { onRemove(row); }
              }, { default: function () { return '彻底删除'; } })
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
    title="回收站"
    style="width: 780px; max-width: 94vw"
  >
    <p class="hint">删除的目录、接口、环境在这里保留 30 天，团队成员都能看到和恢复。</p>

    <div class="head">
      <span class="count">{{ trash.items.length }} 项</span>
      <n-button
        v-if="projects.canEdit"
        size="small"
        :disabled="!trash.items.length"
        @click="onClear"
      >
        清空回收站
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
