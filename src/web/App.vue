<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { RANGES, useStatsRange } from './composables/trafficUi';

const range = useStatsRange();

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
  <header class="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
    <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
      <router-link :to="{ path: '/', query: { range } }" class="flex items-center gap-2 font-semibold text-slate-100">
        <span class="inline-block h-2.5 w-2.5 rounded-full" :class="online ? 'bg-emerald-400' : 'bg-red-500'" :title="online ? 'Online' : 'Offline'"></span>
        Belgrade Traffic
      </router-link>
      <nav class="flex gap-1 text-sm">
        <router-link
          :to="{ path: '/', query: { range } }"
          class="rounded-md px-3 py-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          exact-active-class="bg-slate-800 !text-slate-100"
        >
          Dashboard
        </router-link>
        <router-link
          :to="{ path: '/statistics', query: { range } }"
          class="rounded-md px-3 py-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          active-class="bg-slate-800 !text-slate-100"
        >
          Statistics
        </router-link>
      </nav>
      <div class="ml-auto flex items-center gap-1 rounded-lg bg-slate-900 p-1 text-xs" role="group" aria-label="Time range">
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
    </div>
  </header>
  <router-view />
</template>
