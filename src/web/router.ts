import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import { fetchAuthStatus, redirectOnAdminUnauthorized } from './services/auth';

// The chart-heavy views are loaded on demand, keeping Chart.js out of the dashboard's initial bundle.
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardView },
    { path: '/statistics', name: 'statistics', component: () => import('./views/StatisticsView.vue') },
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue') },
    { path: '/admin', name: 'admin', component: () => import('./views/AdminView.vue'), meta: { admin: true } },
    { path: '/admin/accuracy', name: 'admin-accuracy', component: () => import('./views/AccuracyCheckView.vue'), meta: { admin: true } },
    { path: '/admin/accuracy/:id', name: 'admin-accuracy-check', component: () => import('./views/AccuracyCheckView.vue'), props: true, meta: { admin: true } },
    { path: '/cameras/:id', name: 'camera-detail', component: () => import('./views/CameraDetailView.vue'), props: true },
  ],
});

// Admin pages need a signed-in browser when the server has a password; the server enforces it too.
router.beforeEach(async (to) => {
  if (!to.meta.admin) return true;
  try {
    const status = await fetchAuthStatus();
    if (status.required && !status.signedIn) return { name: 'login', query: { next: to.fullPath } };
  } catch {
    // Server unreachable - let the page load and show its own error.
  }
  return true;
});

redirectOnAdminUnauthorized(() => {
  const current = router.currentRoute.value;
  if (current.meta.admin) void router.replace({ name: 'login', query: { next: current.fullPath } });
});

export default router;
