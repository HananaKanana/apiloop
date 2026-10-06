<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NEmpty, NModal, NSelect, NSpace, NSpin, NTree, useMessage } from 'naive-ui';
import * as copyApi from '@/api/copy';
import * as treeApi from '@/api/tree';
import { useProjectStore } from '@/stores/project';
import { buildTree } from '@/utils/tree';

/**
 * 「复制到其他项目 / 移动到其他项目」弹窗（第六轮第 3 节）。
 *
 * 两步：选目标项目（**只列我在里面是 editor 及以上的**，不含当前项目）→ 选目标目录
 * （目标项目的目录树，默认根目录）。移动会写清楚「原项目里的会放进回收站」。
 *
 * 目标项目的目录树是**现拉**的（`GET /projects/:pid/tree`）：目录树 store 里只有当前
 * 项目那一棵，直接拿它会串到别的项目上去。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  /** `api` 或 `folder` */
  kind: { type: String, default: 'api' },
  nodeId: { type: String, default: '' },
  nodeName: { type: String, default: '' },
  /** 复制还是移动 */
  move: { type: Boolean, default: false }
});

const emit = defineEmits(['update:show', 'done']);

const projects = useProjectStore();
const message = useMessage();
const { t } = useI18n();

const show = computed({
  get: function () { return props.show; },
  set: function (value) { emit('update:show', value); }
});

const targetProjectId = ref('');
const targetFolderId = ref('');
const loadingTree = ref(false);
const submitting = ref(false);
const folderNodes = ref([]);

/** 目标项目：我在里面是 editor 及以上，而且不是当前项目 */
const projectOptions = computed(function () {
  return projects.projects.filter(function (project) {
    if (project.id === projects.currentId) return false;
    const role = project.myRole;
    return role === 'admin' || role === 'owner' || role === 'editor';
  }).map(function (project) {
    return { label: project.name, value: project.id };
  });
});

const title = computed(function () {
  return t(props.move
    ? (props.kind === 'folder' ? 'tree.moveTitleFolder' : 'tree.moveTitleApi')
    : (props.kind === 'folder' ? 'tree.copyTitleFolder' : 'tree.copyTitleApi'));
});

const selectedKeys = computed(function () {
  return targetFolderId.value ? ['f:' + targetFolderId.value] : [];
});

watch(
  function () { return props.show; },
  function (value) {
    if (!value) return;
    targetProjectId.value = projectOptions.value.length ? projectOptions.value[0].value : '';
    targetFolderId.value = '';
    folderNodes.value = [];
    loadFolders();
  }
);

// 换目标项目要重新拉它的目录树
watch(targetProjectId, function () { loadFolders(); });

async function loadFolders() {
  const pid = targetProjectId.value;
  if (!pid) {
    folderNodes.value = [];
    return;
  }

  loadingTree.value = true;
  try {
    const data = await treeApi.getTree(pid);
    // 只要目录（接口不进这个选择器）
    folderNodes.value = buildTree(data.folders || [], []);
  } catch (err) {
    folderNodes.value = [];
    message.error(err.message);
  } finally {
    loadingTree.value = false;
  }
}

function onSelectFolder(keys) {
  const key = keys[keys.length - 1];
  targetFolderId.value = key && key.indexOf('f:') === 0 ? key.slice(2) : '';
}

async function submit() {
  if (!props.nodeId) return;
  if (!targetProjectId.value) {
    message.warning(t('tree.pickTargetProject'));
    return;
  }

  submitting.value = true;
  try {
    const result = await copyApi.copyNode(props.kind, props.nodeId, {
      projectId: targetProjectId.value,
      folderId: targetFolderId.value || null,
      move: props.move
    });
    show.value = false;
    emit('done', result);
  } catch (err) {
    message.error(err.message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="title"
    style="width: 520px; max-width: 94vw"
    @update:show="(value) => emit('update:show', value)"
  >
    <div class="form">
      <div class="field">
        <span class="label">{{ move ? t('tree.targetNodeMove') : t('tree.targetNodeCopy') }}</span>
        <span class="value">{{ nodeName || (kind === 'folder' ? t('tree.thisFolder') : t('tree.thisApi')) }}</span>
      </div>

      <div class="field">
        <span class="label">{{ t('tree.targetProject') }}</span>
        <n-select
          v-model:value="targetProjectId"
          size="small"
          :options="projectOptions"
          :placeholder="t('tree.pickProjectPlaceholder')"
          style="width: 260px"
        />
      </div>

      <div class="field block">
        <span class="label">{{ t('tree.targetFolder') }}</span>
        <div class="folders">
          <button
            class="root-item"
            :class="{ active: !targetFolderId }"
            @click="targetFolderId = ''"
          >
            {{ t('tree.projectRoot') }}
          </button>

          <n-spin :show="loadingTree">
            <n-tree
              v-if="folderNodes.length"
              block-line
              selectable
              :data="folderNodes"
              :selected-keys="selectedKeys"
              :cancelable="false"
              @update:selected-keys="onSelectFolder"
            />
            <div v-else-if="!loadingTree" class="empty">
              {{ targetProjectId ? t('tree.noFoldersInTarget') : t('tree.pickTargetProject') }}
            </div>
          </n-spin>
        </div>
      </div>

      <p v-if="move" class="warn">
        {{ kind === 'folder' ? t('tree.moveWarnFolder') : t('tree.moveWarnApi') }}
      </p>
      <p v-else class="tip">
        {{ t('tree.copyTip') }}
      </p>

      <n-empty
        v-if="!projectOptions.length"
        class="no-target"
        size="small"
        :description="t('tree.noTargetProject')"
      />
    </div>

    <template #footer>
      <n-space justify="end">
        <n-button size="small" @click="show = false">{{ t('app.cancel') }}</n-button>
        <n-button
          size="small"
          type="primary"
          :loading="submitting"
          :disabled="!projectOptions.length || !targetProjectId"
          @click="submit"
        >
          {{ move ? t('tree.moveAction') : t('tree.copyAction') }}
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.field.block {
  align-items: flex-start;
}

.field .label {
  flex: none;
  width: 68px;
  opacity: 0.65;
}

.field .value {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folders {
  flex: 1;
  min-width: 0;
  max-height: 240px;
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.2));
  border-radius: 6px;
}

.root-item {
  display: block;
  width: 100%;
  padding: 5px 8px;
  margin-bottom: 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.root-item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.root-item.active {
  background: rgba(255, 108, 55, 0.12);
  color: var(--apiloop-primary);
}

.empty {
  padding: 12px 8px;
  font-size: 12px;
  opacity: 0.5;
}

.warn {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: #d03050;
}

.tip {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.6;
}

.no-target {
  padding: 8px 0;
}
</style>
