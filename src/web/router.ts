import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';

// The chart-heavy views are loaded on demand, keeping Chart.js out of the dashboard's initial bundle.
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardView },
    { path: '/statistics', name: 'statistics', component: () => import('./views/StatisticsView.vue') },
    { path: '/cameras/:id', name: 'camera-detail', component: () => import('./views/CameraDetailView.vue'), props: true },
  ],
});

export default router;
