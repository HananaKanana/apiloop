<script setup>
import { computed, h, ref, watch } from 'vue';
import { NButton, NDataTable, NEmpty, NModal, NSpace, useMessage } from 'naive-ui';
import * as sharesApi from '@/api/shares';
import { useDialog } from '@/utils/dialog';
import { copyText } from '@/utils/clipboard';
import { shareUrl, shareScopeText, shareExpiresCell, formatShareTime } from '@/utils/share';

/**
 * 头像菜单里的「我的分享」（第 6 节）。
 *
 * 分享链接原来只能在「项目设置 → 分享链接」里按项目看，项目一多就说不清「现在到底
 * 有哪些接口文档对外公开着」。这个弹窗把**所有项目**的链接列在一张表里。
 *
 * 和 `ShareLinksPanel.vue` 的区别只有两点：多了「项目」一列、撤销的权限**逐行**判
 * （`row.canRevoke`，服务端算的）—— 因为这里是跨项目的，同一个人在不同项目里可能是
 * 不同角色。展示文案（范围 / 时间 / 有效期）都走 `utils/share.js`，不各写一份。
 *
 * 只在能用云端时才有入口（网页版一直有，客户端里要登录），判断在 `UserMenu.vue`。
 */
const props = defineProps({
  show: { type: Boolean, default: false }
});

const emit = defineEmits(['update:show']);

const message = useMessage();
const dialog = useDialog();

const loading = ref(false);
const errorText = ref('');
const shares = ref([]);

const show = computed({
  get: function () { return props.show; },
  set: function (value) { emit('update:show', value); }
});

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const data = await sharesApi.listMyShares();
    shares.value = data.shares || [];
  } catch (err) {
    errorText.value = err.message;
  } finally {
    loading.value = false;
  }
}

// 每次打开都重新拉一遍：链接可能在别的地方（项目设置）刚被撤销或新建过
watch(
  function () { return props.show; },
  function (value) { if (value) load(); }
);

async function copy(row) {
  try {
    await copyText(shareUrl(row.id));
    message.success('链接已复制');
  } catch (err) {
    message.error(err.message);
  }
}

function revoke(row) {
  dialog.error({
    title: '撤销分享链接',
    content: '撤销后这个链接立刻失效，「' + (row.projectName || '这个项目') + '」的' +
      (row.folderName ? '目录「' + row.folderName + '」' : '整个项目') + '就打不开了。确定吗？',
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
  return [
    {
      title: '项目',
      key: 'projectName',
      minWidth: 120,
      ellipsis: { tooltip: true },
      render: function (row) { return row.projectName || '—'; }
    },
    {
      title: '范围',
      key: 'scope',
      minWidth: 120,
      ellipsis: { tooltip: true },
      render: function (row) { return shareScopeText(row); }
    },
    {
      title: '创建人',
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
      render: function (row) { return formatShareTime(row.createdAt); }
    },
    {
      title: '有效期至',
      key: 'expiresAt',
      width: 100,
      render: function (row) { return shareExpiresCell(row); }
    },
    {
      title: '操作',
      key: 'actions',
      width: 116,
      render: function (row) {
        const buttons = [
          h(NButton, {
            size: 'tiny',
            quaternary: true,
            onClick: function () { copy(row); }
          }, { default: function () { return '复制'; } })
        ];

        // 没有撤销权限的那一行不显示按钮（服务端在 DELETE /shares/:id 上也会拦一次）
        if (row.canRevoke) {
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
});
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    title="分享链接"
    style="width: 780px; max-width: 94vw"
  >
    <p class="tip">这些链接不用登录就能打开。不再需要的请及时撤销。</p>

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
      description="还没有分享过接口文档。在目录树上右键目录，选「分享文档」。"
    />
  </n-modal>
</template>

<style scoped>
.tip {
  margin: 0 0 10px;
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

/* 已过期的链接调灰：和项目设置里那张表同一套写法 */
:deep(.expired) {
  opacity: 0.55;
}
</style>
