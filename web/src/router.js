import { createRouter, createWebHashHistory } from 'vue-router';
import { useSessionStore } from '@/stores/session';
import { useGatewayStore } from '@/stores/gateway';
import { hasChosen } from '@/utils/firstRun';
import LoginView from '@/views/LoginView.vue';

/*
 * 页面按需加载（用户 2026-10-13：网页版首次打开更快）。登录页还是直接打进主包 ——
 * 没登录时它是第一个页面，要马上出来；其余页面进去的时候才下载各自那一块。
 */
const WorkbenchView = function () { return import('@/views/WorkbenchView.vue'); };
const UsersView = function () { return import('@/views/UsersView.vue'); };
const ProjectsOverviewView = function () { return import('@/views/ProjectsOverviewView.vue'); };
const ProjectSettingsView = function () { return import('@/views/ProjectSettingsView.vue'); };
const SettingsView = function () { return import('@/views/SettingsView.vue'); };
const ChangePasswordView = function () { return import('@/views/ChangePasswordView.vue'); };
const ShareView = function () { return import('@/views/ShareView.vue'); };

/**
 * 用 hash 路由，后端的静态文件服务就不用为前端路由做任何特殊处理。
 */
const routes = [
  { path: '/', redirect: '/workbench' },
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  { path: '/change-password', name: 'change-password', component: ChangePasswordView },
  /**
   * 分享出去的接口文档（第 4 节）：`<云端地址>/#/share/<链接串>`。
   * `meta.public` 让路由守卫直接放行 —— 打开链接的人不用登录，也不该被弹到登录页。
   */
  { path: '/share/:token', name: 'share', component: ShareView, meta: { public: true } },
  { path: '/workbench', name: 'workbench', component: WorkbenchView },
  { path: '/users', name: 'users', component: UsersView, meta: { admin: true } },
  // 项目总览（管理员）：所有项目和各自的成员
  { path: '/admin/projects', name: 'projects-overview', component: ProjectsOverviewView, meta: { admin: true } },
  { path: '/settings', name: 'settings', component: SettingsView, meta: { admin: true } },
  {
    path: '/projects/:pid/settings',
    name: 'project-settings',
    component: ProjectSettingsView
  },
  { path: '/:pathMatch(.*)*', redirect: '/workbench' }
];

const router = createRouter({
  history: createWebHashHistory(),
  routes: routes
});

router.beforeEach(async function (to) {
  const session = useSessionStore();

  if (to.meta.public) return true;

  if (!session.ready) await session.load();
  if (!session.user) {
    // next 统一用 #/ 开头的形式，登录页只接受这种值
    return { name: 'login', query: { next: '#' + to.fullPath } };
  }
  // 本机 apiloop 没登录（从没登录过 / 退出了 / 登录过期）：这次打开先去登录页，
  // 选过「不登录」就不再拦（见 utils/firstRun.js）
  if (!hasChosen()) {
    const gateway = useGatewayStore();
    if (!gateway.loaded) await gateway.load().catch(function () {});
    if (gateway.isGateway && gateway.spaceState !== 'signedIn') {
      return { name: 'login', query: { next: '#' + to.fullPath } };
    }
  }
  // 密码是管理员重置或设置的：改掉之前哪儿都不能去（服务端也会拦）
  if (session.user.mustChangePassword) {
    return to.name === 'change-password' ? true : { name: 'change-password' };
  }
  if (to.name === 'change-password') {
    // 接口返回「请先修改密码」时会直接跳到这里，本地的 user 可能还是旧的：先重新拉一次再判断，
    // 否则会在这里和工作台之间来回跳
    await session.refreshMeta();
    if (session.user && session.user.mustChangePassword) return true;
    return { name: 'workbench' };
  }
  if (to.meta.admin && !session.isAdmin) {
    return { name: 'workbench' };
  }
  return true;
});

export default router;
