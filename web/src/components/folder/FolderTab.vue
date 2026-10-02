<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, useMessage } from 'naive-ui';
import { useProjectStore } from '@/stores/project';
import { useTreeStore } from '@/stores/tree';
import { useTabsStore } from '@/stores/tabs';
import VarTable from '@/components/common/VarTable.vue';
import InlineRename from '@/components/common/InlineRename.vue';
import AuthEditor from '@/components/request/AuthEditor.vue';
import ScriptEditor from '@/components/scripts/ScriptEditor.vue';
import { folderChain } from '@/utils/tree';
import { inheritHint } from '@/utils/auth';

/**
 * 目录设置：名称 / 描述 / 目录变量 / 目录级鉴权（+ 只读的脚本）。
 *
 * 以前目录的鉴权在界面上根本没有入口，接口选了「继承父级」也没人知道继承到了什么；
 * 目录变量更是存下来了却不参与替换（那一半由 F1 在后端修）。这个标签页补的是入口。
 *
 * 可编辑的内容放在 `tab.spec` 上，和接口标签页共用「和快照比出 dirty」那套机制，
 * 所以未保存标记、切换项目时的提醒都不用另外写。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const projects = useProjectStore();
const tree = useTreeStore();
const tabs = useTabsStore();
const message = useMessage();

const saving = ref(false);

const spec = computed(function () {
  return props.tab.spec;
});

const canEdit = computed(function () {
  return projects.canEdit;
});

/** 服务端那一份（算路径用），和正在编辑的 spec 分开 */
const folder = computed(function () {
  return tree.folderById.get(props.tab.folderId) || null;
});

/** 「位置：A / B」——只显示上级，自己那一级已经在标题上了 */
const parentPath = computed(function () {
  const parents = folderChain(tree.folders, folder.value ? folder.value.parentId : null);
  return parents.reverse().map(function (item) { return item.name; }).join(' / ');
});

/**
 * 「继承父级」实际会用到哪一级（契约第 5 节第 2 步）：
 * 从**父目录**开始往上找，最后是项目。自己那一级不算 —— 要继承的就是它。
 */
const authLevels = computed(function () {
  const levels = folderChain(tree.folders, folder.value ? folder.value.parentId : null)
    .map(function (item) {
      return { auth: item.auth, label: '目录「' + item.name + '」' };
    });

  levels.push({
    auth: projects.current ? projects.current.auth : null,
    label: '项目'
  });
  return levels;
});

const authHint = computed(function () {
  return inheritHint(authLevels.value);
});

watch(
  function () { return props.tab.spec; },
  function () { tabs.touch(props.tab); },
  { deep: true }
);

/** 标题上双击改名：只改名字、立刻存（`applyRename` 会把保存快照里的名字一起换掉，dirty 不变） */
async function renameTitle(name) {
  try {
    await tree.renameFolder(props.tab.folderId, name);
    tabs.applyRename('folder', props.tab.folderId, name);
    message.success('已重命名');
  } catch (err) {
    message.error(err.message);
  }
}

async function save() {
  if (!String(spec.value.name || '').trim()) {
    message.warning('请填写目录名称');
    return;
  }

  saving.value = true;
  try {
    const saved = await tree.saveFolder(props.tab.folderId, {
      name: String(spec.value.name).trim(),
      description: spec.value.description,
      auth: spec.value.auth,
      variables: spec.value.variables,
      scripts: spec.value.scripts
    });
    tabs.markFolderSaved(props.tab, saved);
    message.success('已保存');
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

function onKeydown(event) {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (String(event.key).toLowerCase() !== 's') return;
  event.preventDefault();

  // 只读角色连快捷键也要挡住，并说清楚为什么
  if (!canEdit.value) {
    message.warning('当前角色是只读，不能保存修改');
    return;
  }
  save();
}

onMounted(function () {
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(function () {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="folder-tab">
    <div class="head">
      <!-- 双击改名（参考 Postman）：立刻存，只改名字，下面表单里别的没保存的修改不受影响 -->
      <span class="title">
        <inline-rename :value="spec.name" placeholder="目录设置" :editable="canEdit" @commit="renameTitle" />
      </span>
      <span v-if="parentPath" class="path">位置：{{ parentPath }}</span>
      <span class="spacer" />
      <n-button
        v-if="canEdit"
        size="small"
        type="primary"
        :loading="saving"
        :disabled="!folder"
        @click="save"
      >
        保存
      </n-button>
    </div>

    <div class="content">
      <n-alert v-if="!folder" type="warning" :show-icon="false" class="alert">
        这个目录已经不在了，它可能刚被删掉。
      </n-alert>

      <template v-else>
        <n-alert v-if="!canEdit" type="info" :show-icon="false" class="alert">
          当前角色是只读，只能查看目录设置。
        </n-alert>

        <n-card :bordered="false" size="small" title="基本信息">
          <n-form label-placement="top">
            <n-form-item label="名称">
              <n-input v-model:value="spec.name" :disabled="!canEdit" placeholder="目录名称" />
            </n-form-item>
            <n-form-item label="描述">
              <n-input
                v-model:value="spec.description"
                type="textarea"
                :disabled="!canEdit"
                :autosize="{ minRows: 2, maxRows: 5 }"
              />
            </n-form-item>
          </n-form>
        </n-card>

        <n-card :bordered="false" size="small" title="目录变量" class="card">
          <p class="tip">
            目录变量在发送时展开，优先级是「项目 &lt; 外层目录 &lt; 内层目录 &lt; 环境」，
            后面的覆盖前面的。这个目录下的接口、子目录都能用到。
          </p>
          <var-table v-model="spec.variables" :disabled="!canEdit" />
        </n-card>

        <n-card :bordered="false" size="small" title="目录级鉴权" class="card">
          <p class="tip">
            这个目录下的接口和子目录选了「继承父级」时，就沿用到这一级。
          </p>
          <auth-editor v-model="spec.auth" :disabled="!canEdit" :inherit-hint="authHint" />
        </n-card>

        <n-card :bordered="false" size="small" title="脚本" class="card">
          <p class="tip">
            这个目录下的接口发送时，会先按「项目 → 目录（从外到内）→ 接口」执行「请求前」脚本，
            响应回来后再按同样的顺序执行「响应后」脚本。
          </p>
          <script-editor v-model="spec.scripts" :disabled="!canEdit" min-height="180px" />
        </n-card>
      </template>
    </div>
  </div>
</template>

<style scoped>
.folder-tab {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.title {
  font-size: 14px;
  font-weight: 600;
}

.path {
  font-size: 12px;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spacer {
  flex: 1;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px;
  max-width: 760px;
  width: 100%;
  box-sizing: border-box;
}

.card {
  margin-top: 12px;
}

.alert {
  margin-bottom: 12px;
}

.tip {
  margin: 0 0 10px;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}
</style>
