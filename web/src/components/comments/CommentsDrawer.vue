<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { NButton, NDrawer, NDrawerContent, NEmpty, NInput, NSpin, useMessage } from 'naive-ui';
import * as commentsApi from '@/api/comments';
import { useDialog } from '@/utils/dialog';
import { useSessionStore } from '@/stores/session';
import { loadMembers } from '@/utils/projectMembers';
import {
  avatarText,
  extractMentions,
  formatFullTime,
  formatRelativeTime,
  splitBody
} from '@/utils/comment';

/**
 * 接口评论面板（第五轮第 4 节）。
 *
 * 右侧滑出的抽屉，**不挡住请求编辑**。评论只在云端保存（`lib/api/comments.js`），
 * 接口还没同步到云端时显示一句「同步后才能评论」。
 *
 * **正文一律当纯文本**：不解析 HTML、不 v-html —— 评论是别人随便写的，
 * 用 v-html 渲染等于让别人的评论在你的浏览器里执行脚本。网址靠 `splitBody` 拆出来
 * 拼成 `<a>`（`utils/comment.js`）。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  /** 评论挂在哪个接口上 */
  apiId: { type: String, default: '' },
  apiName: { type: String, default: '' },
  /** @ 要拿项目成员列表 */
  projectId: { type: String, default: '' },
  /** 从提醒点进来时要滚到的那一条 */
  focusCommentId: { type: String, default: '' }
});

const emit = defineEmits(['update:show', 'count']);

const session = useSessionStore();
const message = useMessage();
const dialog = useDialog();

const rootRef = ref(null);
const inputRef = ref(null);

const loading = ref(false);
const sending = ref(false);
const savingEdit = ref(false);
const errorText = ref('');
/** 接口还没同步到云端（服务端给 API_NOT_SYNCED） */
const notSynced = ref(false);

const comments = ref([]);
const members = ref([]);

const body = ref('');
const editingId = ref('');
const editingBody = ref('');
const highlightId = ref('');

/* ---------------- @ 提到某人 ---------------- */

const mentionOpen = ref(false);
const mentionQuery = ref('');
const mentionStart = ref(0);

const mentionCandidates = computed(function () {
  const query = mentionQuery.value.toLowerCase();
  return members.value.filter(function (member) {
    const name = String(member.displayName || member.username || '');
    if (!query) return true;
    return name.toLowerCase().indexOf(query) > -1;
  }).slice(0, 8);
});

/** 光标前面是不是刚打了一个 `@`（可以带半截名字） */
function onBodyInput() {
  const el = inputRef.value && inputRef.value.textareaEl;
  const caret = el ? el.selectionStart : body.value.length;
  const before = body.value.slice(0, caret);
  const matched = /(^|\s)@([^\s@]*)$/.exec(before);

  if (!matched) {
    mentionOpen.value = false;
    return;
  }
  mentionQuery.value = matched[2];
  mentionStart.value = caret - matched[2].length - 1;
  mentionOpen.value = true;
}

function pickMember(member) {
  const name = String(member.displayName || member.username || '');
  if (!name) return;

  const caret = mentionStart.value + 1 + mentionQuery.value.length;
  body.value = body.value.slice(0, mentionStart.value) + '@' + name + ' ' + body.value.slice(caret);
  mentionOpen.value = false;

  nextTick(function () {
    const el = inputRef.value && inputRef.value.textareaEl;
    if (!el) return;
    const at = mentionStart.value + name.length + 2;
    el.focus();
    el.setSelectionRange(at, at);
  });
}

/* ---------------- 读 ---------------- */

const activeCount = computed(function () {
  return comments.value.filter(function (item) { return !item.deleted; }).length;
});

async function load() {
  if (!props.apiId) return;

  loading.value = true;
  errorText.value = '';
  notSynced.value = false;

  try {
    const data = await commentsApi.listComments(props.apiId);
    comments.value = data.comments || [];
    emit('count', activeCount.value);
    if (props.focusCommentId) await focusComment(props.focusCommentId);
    else await scrollToBottom();
  } catch (err) {
    if (err.data && err.data.code === 'API_NOT_SYNCED') notSynced.value = true;
    else errorText.value = err.message;
  } finally {
    loading.value = false;
  }
}

/** 成员列表：@ 用。拉不到就当没有成员（还是能评论，只是没法 @） */
async function loadMemberList() {
  if (!props.projectId) {
    members.value = [];
    return;
  }
  try {
    members.value = await loadMembers(props.projectId);
  } catch (err) {
    members.value = [];
  }
}

async function scrollToBottom() {
  await nextTick();
  const el = rootRef.value && rootRef.value.querySelector('.list');
  if (el) el.scrollTop = el.scrollHeight;
}

async function focusComment(id) {
  await nextTick();
  const el = rootRef.value && rootRef.value.querySelector('[data-comment-id="' + id + '"]');
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  highlightId.value = id;
  setTimeout(function () { highlightId.value = ''; }, 2500);
}

// 每次打开（或换了接口）重新拉
watch(
  function () { return [props.show, props.apiId]; },
  function (value) {
    if (!value[0]) {
      mentionOpen.value = false;
      return;
    }
    editingId.value = '';
    body.value = '';
    load();
    loadMemberList();
  },
  { immediate: true }
);

/* ---------------- 写 ---------------- */

function mentionIdsFor(text) {
  return extractMentions(text, members.value);
}

async function send() {
  const text = body.value.trim();
  if (!text || !props.apiId) return;

  sending.value = true;
  try {
    const data = await commentsApi.createComment(props.apiId, {
      body: text,
      mentions: mentionIdsFor(text)
    });
    comments.value = comments.value.concat([data.comment]);
    body.value = '';
    mentionOpen.value = false;
    emit('count', activeCount.value);
    await scrollToBottom();
  } catch (err) {
    if (err.data && err.data.code === 'API_NOT_SYNCED') notSynced.value = true;
    else message.error(err.message);
  } finally {
    sending.value = false;
  }
}

function onKeydown(event) {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key !== 'Enter') return;
  event.preventDefault();
  send();
}

function canEdit(item) {
  return !item.deleted && item.user && session.user && item.user.id === session.user.id;
}

function canDelete(item) {
  if (item.deleted) return false;
  if (!session.user) return false;
  // 作者本人或管理员（服务端也是这两条）
  return (item.user && item.user.id === session.user.id) || session.isAdmin;
}

function startEdit(item) {
  editingId.value = item.id;
  editingBody.value = item.body;
}

function cancelEdit() {
  editingId.value = '';
  editingBody.value = '';
}

async function saveEdit(item) {
  const text = editingBody.value.trim();
  if (!text) {
    message.warning('评论内容不能为空');
    return;
  }

  savingEdit.value = true;
  try {
    const data = await commentsApi.updateComment(item.id, {
      body: text,
      // mentions 是整份替换，每次都要带上（不然原来的 @ 会被清掉）
      mentions: mentionIdsFor(text)
    });
    replaceComment(data.comment);
    cancelEdit();
  } catch (err) {
    message.error(err.message);
  } finally {
    savingEdit.value = false;
  }
}

function askDelete(item) {
  dialog.error({
    title: '删除评论',
    content: '删除后这一楼会显示「这条评论已删除」，内容不再显示。确定吗？',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        const data = await commentsApi.removeComment(item.id);
        replaceComment(data.comment);
        emit('count', activeCount.value);
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

function replaceComment(next) {
  comments.value = comments.value.map(function (item) {
    return item.id === next.id ? next : item;
  });
}

function isEdited(item) {
  return !item.deleted && item.updatedAt - item.createdAt > 1000;
}
</script>

<template>
  <n-drawer
    :show="show"
    :width="420"
    placement="right"
    @update:show="(value) => emit('update:show', value)"
  >
    <n-drawer-content :title="'评论 · ' + (apiName || '接口')" closable>
      <div ref="rootRef" class="panel">
        <p class="tip">评论只在云端保存，所有项目成员都能看到。</p>

        <div v-if="notSynced" class="notice">
          这个接口还没同步到云端，同步后才能评论。
        </div>
        <div v-else-if="errorText" class="notice error">{{ errorText }}</div>

        <n-spin :show="loading">
          <div class="list">
            <n-empty
              v-if="!loading && !comments.length && !notSynced"
              class="empty"
              size="small"
              description="还没有评论，说点什么吧"
            />

            <div
              v-for="item in comments"
              :key="item.id"
              class="comment"
              :class="{ deleted: item.deleted, highlight: item.id === highlightId }"
              :data-comment-id="item.id"
            >
              <div class="avatar">{{ avatarText(item.user.displayName) }}</div>

              <div class="main">
                <div class="meta">
                  <span class="name">{{ item.user.displayName }}</span>
                  <span class="time" :title="formatFullTime(item.createdAt)">
                    {{ formatRelativeTime(item.createdAt) }}
                  </span>
                  <span v-if="isEdited(item)" class="edited">已编辑</span>
                  <span class="spacer" />
                  <button v-if="canEdit(item)" class="link" @click="startEdit(item)">编辑</button>
                  <button v-if="canDelete(item)" class="link danger" @click="askDelete(item)">删除</button>
                </div>

                <div v-if="item.deleted" class="body gone">这条评论已删除</div>

                <template v-else-if="editingId === item.id">
                  <n-input
                    v-model:value="editingBody"
                    type="textarea"
                    size="small"
                    :autosize="{ minRows: 2, maxRows: 8 }"
                  />
                  <div class="edit-actions">
                    <n-button size="tiny" @click="cancelEdit">取消</n-button>
                    <n-button size="tiny" type="primary" :loading="savingEdit" @click="saveEdit(item)">
                      保存
                    </n-button>
                  </div>
                </template>

                <!-- 正文当纯文本：只把网址拆成链接，别的原样 -->
                <div v-else class="body">
                  <template v-for="(part, index) in splitBody(item.body)" :key="index">
                    <a
                      v-if="part.type === 'link'"
                      :href="part.text"
                      target="_blank"
                      rel="noopener noreferrer"
                    >{{ part.text }}</a>
                    <span v-else>{{ part.text }}</span>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </n-spin>

        <div v-if="!notSynced" class="composer">
          <div v-if="mentionOpen && mentionCandidates.length" class="mention-list">
            <button
              v-for="member in mentionCandidates"
              :key="member.userId"
              class="mention-item"
              @click="pickMember(member)"
            >
              <span class="avatar tiny">{{ avatarText(member.displayName || member.username) }}</span>
              <span class="mention-name">{{ member.displayName || member.username }}</span>
            </button>
          </div>

          <n-input
            ref="inputRef"
            v-model:value="body"
            type="textarea"
            size="small"
            :autosize="{ minRows: 2, maxRows: 6 }"
            placeholder="写点什么…输入 @ 可以提到项目成员"
            @input="onBodyInput"
            @keydown="onKeydown"
          />

          <div class="composer-foot">
            <span class="hint">⌘/Ctrl + Enter 发送</span>
            <n-button
              size="small"
              type="primary"
              :loading="sending"
              :disabled="!body.trim()"
              @click="send"
            >
              发送
            </n-button>
          </div>
        </div>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tip {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
}

.notice {
  padding: 6px 10px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.1);
  font-size: 12px;
}

.notice.error {
  background: rgba(208, 48, 80, 0.08);
  color: #d03050;
}

.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-right: 2px;
}

.empty {
  padding: 24px 0;
}

.comment {
  display: flex;
  gap: 8px;
  padding: 8px 6px;
  border-radius: 6px;
}

.comment + .comment {
  border-top: 1px solid rgba(128, 128, 128, 0.12);
}

/* 从提醒点进来时闪一下，让人知道是哪一条 */
.comment.highlight {
  background: rgba(255, 108, 55, 0.1);
}

.comment.deleted {
  opacity: 0.6;
}

.avatar {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--apiloop-primary);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.avatar.tiny {
  width: 20px;
  height: 20px;
  font-size: 11px;
}

.main {
  flex: 1;
  min-width: 0;
}

.meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
}

.meta .name {
  font-weight: 600;
}

.meta .time {
  opacity: 0.5;
}

.meta .edited {
  opacity: 0.45;
}

.spacer {
  flex: 1;
}

.link {
  padding: 0 4px;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  opacity: 0;
}

.comment:hover .link {
  opacity: 0.7;
}

.link:hover {
  opacity: 1;
  color: var(--apiloop-primary);
}

.link.danger:hover {
  color: #d03050;
}

.body {
  margin-top: 2px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.body a {
  color: var(--apiloop-primary);
}

.body.gone {
  opacity: 0.55;
  font-style: italic;
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
}

.composer {
  flex: none;
  position: relative;
  border-top: 1px solid rgba(128, 128, 128, 0.16);
  padding-top: 8px;
}

.composer-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}

.hint {
  font-size: 12px;
  opacity: 0.5;
}

/* @ 成员候选：贴在输入框上面（不做跟随光标的浮层，简单可靠） */
.mention-list {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  margin-bottom: 4px;
  max-height: 200px;
  overflow: auto;
  padding: 4px;
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 6px;
  background: var(--apiloop-surface);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  z-index: 10;
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.mention-item:hover {
  background: rgba(128, 128, 128, 0.14);
}

.mention-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
