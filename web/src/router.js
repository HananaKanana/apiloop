import { createRouter, createWebHashHistory } from 'vue-router';
import { useSessionStore } from '@/stores/session';
import LoginView from '@/views/LoginView.vue';
import WorkbenchView from '@/views/WorkbenchView.vue';
import UsersView from '@/views/UsersView.vue';
import ProjectSettingsView from '@/views/ProjectSettingsView.vue';

/**
 * 用 hash 路由，后端的静态文件服务就不用为前端路由做任何特殊处理。
 */
const routes = [
  { path: '/', redirect: '/workbench' },
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  { path: '/workbench', name: 'workbench', component: WorkbenchView },
  { path: '/users', name: 'users', component: UsersView, meta: { admin: true } },
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
  if (to.meta.admin && !session.isAdmin) {
    return { name: 'workbench' };
  }
  return true;
});

export default router;
