<script setup>
import { computed, h, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NDataTable, NEmpty, NSpace, useMessage } from 'naive-ui';
import * as sharesApi from '@/api/shares';
import { useProjectStore } from '@/stores/project';
import { useDialog } from '@/utils/dialog';
import { copyText } from '@/utils/clipboard';
import { shareUrl, shareScopeText, shareExpiresCell, formatShareTime } from '@/utils/share';

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
const { t } = useI18n();

const loading = ref(false);
const errorText = ref('');
const shares = ref([]);

const canEdit = computed(function () { return projects.canEdit; });

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
    message.success(t('share.linkCopied'));
  } catch (err) {
    message.error(err.message);
  }
}

function revoke(row) {
  const scope = row.folderName
    ? t('share.folderScope', { name: row.folderName })
    : t('share.projectScope');
  dialog.error({
    title: t('share.revokeTitle'),
    content: t('share.revokeBody', { scope: scope }),
    positiveText: t('share.revokeAction'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        await sharesApi.revokeShare(row.id);
        message.success(t('share.revoked'));
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
      title: t('share.colScope'),
      key: 'scope',
      render: function (row) { return shareScopeText(row); }
    },
    {
      title: t('share.colCreatedBy'),
      key: 'createdBy',
      width: 110,
      render: function (row) {
        return (row.createdBy && row.createdBy.displayName) || '—';
      }
    },
    {
      title: t('share.colCreatedAt'),
      key: 'createdAt',
      width: 140,
      render: function (row) { return formatShareTime(row.createdAt); }
    },
    {
      title: t('share.colExpiresAt'),
      key: 'expiresAt',
      width: 160,
      render: function (row) { return shareExpiresCell(row); }
    },
    {
      title: t('share.colActions'),
      key: 'actions',
      width: 120,
      render: function (row) {
        const buttons = [
          h(NButton, {
            size: 'tiny',
            quaternary: true,
            onClick: function () { copy(row); }
          }, { default: function () { return t('share.copy'); } })
        ];

        if (canEdit.value) {
          buttons.push(h(NButton, {
            size: 'tiny',
            quaternary: true,
            onClick: function () { revoke(row); }
          }, { default: function () { return t('share.revokeAction'); } }));
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
      {{ t('share.panelTip') }}
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
      :description="t('share.noShares')"
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
