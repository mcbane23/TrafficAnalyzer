<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watchEffect } from 'vue';
import { useRoute } from 'vue-router';
import type { StatsRange } from '../types/stats';
import { RANGES, useStatsRange } from './composables/trafficUi';
import { pageSubject } from './composables/pageTitle';
import { LOCALES, locale, setLocale, t } from './i18n';
import AppIcon from './components/AppIcon.vue';
import { cycleTheme, themeChoice } from './composables/theme';

const range = useStatsRange();
const route = useRoute();
setLocale(locale.value);

// Browser tab title: the page, then the app ("Brankov most · Saobraćaj Beograd").
const ROUTE_TITLES: Record<string, () => string> = {
  statistics: () => t('stats.title'),
  wall: () => t('wall.title'),
  map: () => t('map.title'),
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
  { name: 'map', icon: 'map', label: () => t('nav.map') },
  { name: 'wall', icon: 'grid', label: () => t('nav.wall') },
  { name: 'admin', icon: 'settings', label: () => t('nav.admin') },
] as const;
const NAV_PATHS: Record<string, string> = { dashboard: '/', statistics: '/statistics', map: '/map', wall: '/wall', admin: '/admin' };
const navActive = (name: string) => (name === 'admin' ? route.path.startsWith('/admin') : route.path === NAV_PATHS[name]);
const navTarget = (name: string) =>
  name === 'admin' || name === 'wall' || name === 'map' ? NAV_PATHS[name] : { path: NAV_PATHS[name], query: { range: range.value } };
const showRange = () => !String(route.name ?? '').startsWith('admin') && route.name !== 'wall' && route.name !== 'map';

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
  <a href="#content" class="sr-only z-50 rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
    {{ t('a11y.skip') }}
  </a>
  <!-- On a phone: brand, range (a dropdown) and language on one row, the pages (icon over label) on the next. -->
  <header class="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
    <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-2 sm:gap-x-6 sm:gap-y-2 sm:py-3">
      <router-link :to="{ path: '/', query: { range } }" class="order-1 flex min-w-0 flex-1 items-center gap-2 font-semibold text-slate-100 sm:order-none sm:flex-none">
        <span class="inline-block h-2.5 w-2.5 shrink-0 rounded-full" :class="online ? 'bg-emerald-400' : 'bg-red-500'" :title="online ? t('app.online') : t('app.offline')"></span>
        <span class="truncate">{{ t('app.title') }}</span>
      </router-link>
      <div class="order-4 basis-full sm:hidden"></div>
      <nav class="order-5 grid w-full grid-cols-5 gap-1 text-[11px] sm:order-none sm:flex sm:w-auto sm:text-sm">
        <router-link
          v-for="item in NAV"
          :key="item.name"
          :to="navTarget(item.name)"
          class="flex flex-col items-center gap-0.5 whitespace-nowrap rounded-md px-1 py-1 sm:flex-row sm:gap-1.5 sm:px-3 sm:py-1.5"
          :class="navActive(item.name) ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'"
          :aria-current="navActive(item.name) ? 'page' : undefined"
          :aria-label="item.label()"
          :title="item.label()"
        >
          <AppIcon :name="item.icon" :size="15" />
          <!-- Tablet widths have no room for five labels next to the range and language switches: icons only there. -->
          <span class="sm:hidden lg:inline">{{ item.label() }}</span>
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
      <button
        type="button"
        class="order-3 rounded-lg bg-slate-900 p-2 text-slate-300 hover:text-slate-100 sm:order-none"
        :aria-label="t('theme.button', { theme: t(`theme.${themeChoice}`) })"
        :title="t('theme.button', { theme: t(`theme.${themeChoice}`) })"
        @click="cycleTheme"
      >
        <AppIcon :name="themeChoice === 'light' ? 'sun' : themeChoice === 'dark' ? 'moon' : 'monitor'" :size="15" />
      </button>
    </div>
  </header>
  <div id="content" tabindex="-1" class="outline-none">
    <router-view />
  </div>
</template>
