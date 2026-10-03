<script setup>
import { computed, h, onMounted, ref, watch } from 'vue';
import { NButton, NDataTable, NEmpty, NSpace, useMessage } from 'naive-ui';
import * as sharesApi from '@/api/shares';
import { useProjectStore } from '@/stores/project';
import { useDialog } from '@/utils/dialog';
import { copyText } from '@/utils/clipboard';
import { shareUrl } from '@/utils/share';

/**
 * 项目设置里的「分享链接」区域（第 4 节）。
 *
 * 列出这个项目已生成的链接：范围、谁建的、什么时候建的、有效期到哪天，每行「复制」「撤销」。
 * **viewer 只能看**（服务端也只允许 editor 撤销）—— 撤销按钮对它不显示。
 *
 * 数据在云端（分享是云端对外发布的东西），所以这一块和成员管理一样，未登录时整块不显示
 * （由调用方判断 `cloudFeaturesAvailable`）。
 */
const props = defineProps({
  pid: { type: String, default: '' }
});

const projects = useProjectStore();
const message = useMessage();
const dialog = useDialog();

const loading = ref(false);
const errorText = ref('');
const shares = ref([]);

const canEdit = computed(function () { return projects.canEdit; });

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

function isExpired(row) {
  return Boolean(row.expiresAt) && Number(row.expiresAt) <= Date.now();
}

async function load() {
  if (!props.pid) return;
  loading.value = true;
  errorText.value = '';
  try {
    const data = await sharesApi.listShares(props.pid);
    shares.value = data.shares || [];
  } catch (err) {
    errorText.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function copy(row) {
  try {
    await copyText(shareUrl(row.id));
    message.success('链接已复制');
  } catch (err) {
    message.error(err.message);
  }
}

function revoke(row) {
  const scope = row.folderName ? '目录「' + row.folderName + '」' : '整个项目';
  dialog.error({
    title: '撤销分享链接',
    content: '撤销后这个链接立刻失效，' + scope + '的文档就打不开了。确定吗？',
    positiveText: '撤销',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await sharesApi.revokeShare(row.id);
        message.success('已撤销');
        await load();
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

const columns = computed(function () {
  const list = [
    {
      title: '范围',
      key: 'scope',
      render: function (row) {
        return row.folderName ? '目录：' + row.folderName : '整个项目';
      }
    },
    {
      title: '谁建的',
      key: 'createdBy',
      width: 110,
      render: function (row) {
        return (row.createdBy && row.createdBy.displayName) || '—';
      }
    },
    {
      title: '创建时间',
      key: 'createdAt',
      width: 140,
      render: function (row) { return formatTime(row.createdAt); }
    },
    {
      title: '有效期至',
      key: 'expiresAt',
      width: 160,
      render: function (row) {
        if (!row.expiresAt) return '永久';
        if (isExpired(row)) {
          return h('span', { class: 'expired' }, '已过期（' + formatTime(row.expiresAt) + '）');
        }
        return formatTime(row.expiresAt);
      }
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: function (row) {
        const buttons = [
          h(NButton, {
            size: 'tiny',
            quaternary: true,
            onClick: function () { copy(row); }
          }, { default: function () { return '复制'; } })
        ];

        if (canEdit.value) {
          buttons.push(h(NButton, {
            size: 'tiny',
            quaternary: true,
            onClick: function () { revoke(row); }
          }, { default: function () { return '撤销'; } }));
        }

        return h(NSpace, { size: 4, align: 'center' }, { default: function () { return buttons; } });
      }
    }
  ];

  return list;
});

onMounted(load);
watch(function () { return props.pid; }, load);
</script>

<template>
  <div class="panel">
    <p class="tip">
      分享出去的是云端的接口文档，打开链接的人不用登录就能看。撤销之后链接立刻失效。
    </p>

    <div v-if="errorText" class="error">{{ errorText }}</div>

    <n-data-table
      v-else
      size="small"
      :columns="columns"
      :data="shares"
      :loading="loading"
      :bordered="false"
      :row-key="(row) => row.id"
    />

    <n-empty
      v-if="!loading && !errorText && !shares.length"
      class="empty"
      size="small"
      description="还没有生成过分享链接。在目录树上右键「分享文档」就能生成一条。"
    />
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tip {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}

.error {
  font-size: 12px;
  color: #d03050;
}

.empty {
  padding: 20px 0;
}

:deep(.expired) {
  opacity: 0.55;
}
</style>
