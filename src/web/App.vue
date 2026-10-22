<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watchEffect } from 'vue';
import { useRoute } from 'vue-router';
import type { StatsRange } from '../types/stats';
import { RANGES, useStatsRange } from './composables/trafficUi';
import { pageSubject } from './composables/pageTitle';
import { LOCALES, locale, setLocale, t } from './i18n';
import AppIcon from './components/AppIcon.vue';

const range = useStatsRange();
const route = useRoute();
setLocale(locale.value);

// Browser tab title: the page, then the app ("Brankov most · Saobraćaj Beograd").
const ROUTE_TITLES: Record<string, () => string> = {
  statistics: () => t('stats.title'),
  admin: () => t('nav.admin'),
  'admin-accuracy': () => t('check.title'),
  'admin-accuracy-check': () => t('check.title'),
};
watchEffect(() => {
  const name = String(route.name ?? '');
  const subject = name === 'camera-detail' ? pageSubject.value : ROUTE_TITLES[name]?.();
  document.title = subject ? `${subject} · ${t('app.title')}` : t('app.title');
});

const NAV = [
  { name: 'dashboard', icon: 'dashboard', label: () => t('nav.dashboard') },
  { name: 'statistics', icon: 'chart', label: () => t('nav.statistics') },
  { name: 'admin', icon: 'settings', label: () => t('nav.admin') },
] as const;
const navActive = (name: string) =>
  name === 'admin' ? route.path.startsWith('/admin') : name === 'statistics' ? route.path === '/statistics' : route.path === '/';
const navTarget = (name: string) => (name === 'admin' ? '/admin' : { path: name === 'statistics' ? '/statistics' : '/', query: { range: range.value } });
const showRange = () => !String(route.name ?? '').startsWith('admin');

// Live indicator: the browser's own view of connectivity. Individual views
// still report their own stream disconnects next to the data they affect.
const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine);
const setOnline = () => (online.value = true);
const setOffline = () => (online.value = false);
onMounted(() => {
  window.addEventListener('online', setOnline);
  window.addEventListener('offline', setOffline);
});
onBeforeUnmount(() => {
  window.removeEventListener('online', setOnline);
  window.removeEventListener('offline', setOffline);
});
</script>

<template>
  <!-- On a phone: brand, range (a dropdown) and language on one row, the pages on the next. -->
  <header class="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
    <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-2 sm:gap-x-6 sm:gap-y-2 sm:py-3">
      <router-link :to="{ path: '/', query: { range } }" class="order-1 flex min-w-0 items-center gap-2 font-semibold text-slate-100 sm:order-none">
        <span class="inline-block h-2.5 w-2.5 shrink-0 rounded-full" :class="online ? 'bg-emerald-400' : 'bg-red-500'" :title="online ? t('app.online') : t('app.offline')"></span>
        <span class="truncate">{{ t('app.title') }}</span>
      </router-link>
      <div class="order-4 basis-full sm:hidden"></div>
      <nav class="order-5 flex gap-1 text-sm sm:order-none">
        <router-link
          v-for="item in NAV"
          :key="item.name"
          :to="navTarget(item.name)"
          class="flex items-center gap-1.5 rounded-md px-2 py-1.5 sm:px-3"
          :class="navActive(item.name) ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'"
          :aria-current="navActive(item.name) ? 'page' : undefined"
        >
          <AppIcon :name="item.icon" :size="15" />
          {{ item.label() }}
        </router-link>
      </nav>
      <!-- The Admin pages show live server figures, not traffic over a period. -->
      <template v-if="showRange()">
        <div class="ml-auto hidden items-center gap-1 rounded-lg bg-slate-900 p-1 text-xs sm:flex" role="group" :aria-label="t('nav.range')">
          <button
            v-for="option in RANGES"
            :key="option.value"
            type="button"
            class="rounded-md px-2.5 py-1 font-medium transition"
            :class="range === option.value ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'"
            :aria-pressed="range === option.value"
            @click="range = option.value"
          >
            {{ option.label }}
          </button>
        </div>
        <select
          :value="range"
          class="order-2 ml-auto rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs font-medium text-slate-200 sm:hidden"
          :aria-label="t('nav.range')"
          @change="range = ($event.target as HTMLSelectElement).value as StatsRange"
        >
          <option v-for="option in RANGES" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </template>
      <div class="order-3 flex items-center gap-1 rounded-lg bg-slate-900 p-1 text-xs sm:order-none" :class="showRange() ? '' : 'ml-auto'" role="group" :aria-label="t('nav.language')">
        <button
          v-for="option in LOCALES"
          :key="option.value"
          type="button"
          class="rounded-md px-2 py-1 font-medium transition"
          :class="locale === option.value ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'"
          :aria-pressed="locale === option.value"
          @click="setLocale(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>
  </header>
  <router-view />
</template>
