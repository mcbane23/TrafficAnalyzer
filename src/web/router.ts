import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import CameraDetailView from './views/CameraDetailView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardView },
    { path: '/cameras/:id', name: 'camera-detail', component: CameraDetailView, props: true },
  ],
});

export default router;
