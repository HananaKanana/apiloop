<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, useMessage } from 'naive-ui';
import { changePassword } from '@/api/auth';
import { useSessionStore } from '@/stores/session';

/**
 * 「请先修改密码」：密码是管理员重置或设置的（`user.mustChangePassword`），
 * 登录后先到这里，改完才能进工作台（2026-10-01 用户要求）。
 *
 * 只能改密码或退出登录，没有「跳过」。服务端在改掉之前也会拒绝其他接口（403
 * `PASSWORD_CHANGE_REQUIRED`），这个页面只是把路给指清楚。
 */
const router = useRouter();
const message = useMessage();
const { t } = useI18n();
const session = useSessionStore();

const form = ref({ oldPassword: '', newPassword: '', confirm: '' });
const saving = ref(false);
const errorText = ref('');

async function submit() {
  errorText.value = '';

  if (!form.value.oldPassword) {
    errorText.value = t('views.changeErrOld');
    return;
  }
  if (form.value.newPassword.length < 6) {
    errorText.value = t('views.changeErrShort');
    return;
  }
  if (form.value.newPassword !== form.value.confirm) {
    errorText.value = t('views.changeErrMismatch');
    return;
  }
  if (form.value.newPassword === form.value.oldPassword) {
    errorText.value = t('views.changeErrSame');
    return;
  }

  saving.value = true;
  try {
    await changePassword(form.value.oldPassword, form.value.newPassword);
    session.setUser(Object.assign({}, session.user, { mustChangePassword: false }));
    message.success(t('views.changeDone'));
    router.replace('/workbench');
  } catch (err) {
    errorText.value = err.message;
  } finally {
    saving.value = false;
  }
}

async function logout() {
  await session.logout();
  router.replace('/login');
}
</script>

<template>
  <div class="change-page">
    <n-card class="change-card" :bordered="false">
      <h1 class="brand">{{ t('views.changeTitle') }}</h1>
      <p class="subtitle">
        {{ t('views.changeSubtitle') }}
      </p>

      <n-alert v-if="errorText" type="error" :show-icon="false" class="alert">
        {{ errorText }}
      </n-alert>

      <n-form @submit.prevent="submit">
        <n-form-item :label="t('views.changeOldLabel')">
          <n-input
            v-model:value="form.oldPassword"
            type="password"
            show-password-on="click"
            :placeholder="t('views.changeOldPlaceholder')"
            autofocus
          />
        </n-form-item>
        <n-form-item :label="t('views.changeNewLabel')">
          <n-input
            v-model:value="form.newPassword"
            type="password"
            show-password-on="click"
            :placeholder="t('views.changeNewPlaceholder')"
          />
        </n-form-item>
        <n-form-item :label="t('views.changeConfirmLabel')">
          <n-input
            v-model:value="form.confirm"
            type="password"
            show-password-on="click"
            :placeholder="t('views.changeConfirmPlaceholder')"
            @keyup.enter="submit"
          />
        </n-form-item>
      </n-form>

      <n-button type="primary" block :loading="saving" @click="submit">
        {{ t('views.changeSubmit') }}
      </n-button>
      <n-button quaternary block class="logout" @click="logout">
        {{ t('views.changeLogout') }}
      </n-button>
    </n-card>
  </div>
</template>

<style scoped>
.change-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
}

.change-card {
  width: 380px;
  max-width: 100%;
}

.brand {
  margin: 0 0 8px;
  font-size: 22px;
  font-weight: 600;
  text-align: center;
}

.subtitle {
  margin: 0 0 20px;
  text-align: center;
  opacity: 0.6;
  font-size: 13px;
  line-height: 1.6;
}

.alert {
  margin-bottom: 16px;
}

.logout {
  margin-top: 8px;
}
</style>
