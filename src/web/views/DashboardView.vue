<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { CameraEntry } from '../../types/camera';
import type { CameraAnalysisOverview, TrafficLevel } from '../../types/analysis';
import type { StatsSummary } from '../../types/stats';
import { fetchCameras } from '../services/api';
import { fetchLatestOverview, subscribeOverview } from '../services/analysis';
import { fetchStatsSummary } from '../services/stats';
import { RANGES, TRAFFIC_LABELS, formatCount, useStatsRange } from '../composables/trafficUi';
import CameraCard from '../components/CameraCard.vue';

const range = useStatsRange();
const cameras = ref<CameraEntry[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

// Dashboard-wide traffic overview (count + Light/Moderate/Heavy badge per
// camera): one shared bootstrap call + one shared SSE connection for the
// whole dashboard, rather than every CameraCard opening its own stream.
const overviewByCameraId = shallowRef(new Map<string, CameraAnalysisOverview>());
let unsubscribeOverview: (() => void) | null = null;

const summary = ref<StatsSummary | null>(null);
const summaryByCameraId = computed(() => new Map((summary.value?.cameras ?? []).map((c) => [c.cameraId, c])));

const SUMMARY_REFRESH_MS = 60_000;
const SNAPSHOT_REFRESH_MS = 30_000;
const snapshotTick = ref(Date.now());
let summaryHandle: ReturnType<typeof setInterval> | null = null;
let snapshotHandle: ReturnType<typeof setInterval> | null = null;

// Toolbar state, persisted per browser - a convenience, never required.
type SortKey = 'busiest' | 'name' | 'level';
const search = ref('');
const statusFilter = ref<'all' | 'active' | 'offline'>('all');
const levelFilter = ref<'all' | TrafficLevel>('all');
const sortKey = ref<SortKey>('busiest');
const layout = ref<'grid' | 'list'>('grid');
try {
  const saved = JSON.parse(localStorage.getItem('dashboard-view') ?? '{}');
  if (saved.layout === 'list' || saved.layout === 'grid') layout.value = saved.layout;
  if (['busiest', 'name', 'level'].includes(saved.sortKey)) sortKey.value = saved.sortKey;
} catch {
  // Storage unavailable - defaults are fine.
}
watch([layout, sortKey], () => {
  try {
    localStorage.setItem('dashboard-view', JSON.stringify({ layout: layout.value, sortKey: sortKey.value }));
  } catch {
    // Ignore.
  }
});

const LEVEL_RANK: Record<TrafficLevel, number> = { heavy: 0, moderate: 1, light: 2 };

const visibleCameras = computed(() => {
  const query = search.value.trim().toLowerCase();
  const list = cameras.value.filter((camera) => {
    if (query && !`${camera.name} ${camera.location.address ?? ''}`.toLowerCase().includes(query)) return false;
    if (statusFilter.value === 'active' && camera.status !== 'active') return false;
    if (statusFilter.value === 'offline' && camera.status === 'active') return false;
    if (levelFilter.value !== 'all') {
      const overview = overviewByCameraId.value.get(camera.id);
      if (!overview || overview.error || overview.trafficLevel !== levelFilter.value) return false;
    }
    return true;
  });
  const total = (camera: CameraEntry) => summaryByCameraId.value.get(camera.id)?.total ?? -1;
  const level = (camera: CameraEntry) => {
    const overview = overviewByCameraId.value.get(camera.id);
    return camera.status !== 'active' || !overview || overview.error ? 3 : LEVEL_RANK[overview.trafficLevel];
  };
  return [...list].sort((x, y) => {
    if (x.status !== y.status) return x.status === 'active' ? -1 : 1;
    if (sortKey.value === 'busiest') return total(y) - total(x) || x.name.localeCompare(y.name);
    if (sortKey.value === 'level') return level(x) - level(y) || total(y) - total(x);
    return x.name.localeCompare(y.name);
  });
});

const kpis = computed(() => {
  const active = cameras.value.filter((c) => c.status === 'active');
  let heavy = 0;
  let failing = 0;
  for (const camera of active) {
    const overview = overviewByCameraId.value.get(camera.id);
    if (overview?.error) failing += 1;
    else if (overview?.trafficLevel === 'heavy') heavy += 1;
  }
  return {
    active: active.length,
    total: cameras.value.length,
    passed: summary.value?.totals.total ?? null,
    heavy,
    offline: cameras.value.length - active.length + failing,
  };
});

const rangeLabel = computed(() => RANGES.find((r) => r.value === range.value)?.label ?? range.value);

async function loadSummary() {
  try {
    summary.value = await fetchStatsSummary(range.value);
  } catch {
    // Non-fatal: cards show "–" until the next refresh.
  }
}
watch(range, loadSummary);

onMounted(async () => {
  loadSummary();
  summaryHandle = setInterval(loadSummary, SUMMARY_REFRESH_MS);
  snapshotHandle = setInterval(() => (snapshotTick.value = Date.now()), SNAPSHOT_REFRESH_MS);

  try {
    cameras.value = await fetchCameras();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load cameras.';
  } finally {
    loading.value = false;
  }

  try {
    const overview = await fetchLatestOverview();
    const map = new Map(overviewByCameraId.value);
    for (const entry of overview) map.set(entry.cameraId, entry);
    overviewByCameraId.value = map;
  } catch {
    // Non-fatal: cards just show without a badge until the SSE stream delivers one.
  }

  unsubscribeOverview = subscribeOverview((entry) => {
    const map = new Map(overviewByCameraId.value);
    map.set(entry.cameraId, entry);
    overviewByCameraId.value = map;
  });
});

onBeforeUnmount(() => {
  unsubscribeOverview?.();
  if (summaryHandle !== null) clearInterval(summaryHandle);
  if (snapshotHandle !== null) clearInterval(snapshotHandle);
});
</script>

<template>
  <main class="mx-auto max-w-7xl px-4 py-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-slate-100">Traffic overview</h1>
        <p class="mt-1 text-sm text-slate-400">Belgrade traffic cameras · last {{ rangeLabel }}</p>
      </div>
    </div>

    <!-- KPI row -->
    <div class="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <p class="text-xs text-slate-500">Vehicles passed · {{ rangeLabel }}</p>
        <p class="mt-1 text-2xl font-bold tabular-nums text-slate-100">{{ kpis.passed === null ? '–' : formatCount(kpis.passed) }}</p>
      </div>
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <p class="text-xs text-slate-500">Active cameras</p>
        <p class="mt-1 text-2xl font-bold tabular-nums text-slate-100">{{ kpis.active }}<span class="text-base font-medium text-slate-500"> / {{ kpis.total }}</span></p>
      </div>
      <button type="button" class="rounded-xl border border-slate-800 bg-slate-900 p-4 text-left hover:border-slate-600" @click="levelFilter = levelFilter === 'heavy' ? 'all' : 'heavy'">
        <p class="text-xs text-slate-500">Heavy traffic now</p>
        <p class="mt-1 text-2xl font-bold tabular-nums" :class="kpis.heavy > 0 ? 'text-red-400' : 'text-slate-100'">{{ kpis.heavy }}</p>
      </button>
      <button type="button" class="rounded-xl border border-slate-800 bg-slate-900 p-4 text-left hover:border-slate-600" @click="statusFilter = statusFilter === 'offline' ? 'all' : 'offline'">
        <p class="text-xs text-slate-500">Offline or failing</p>
        <p class="mt-1 text-2xl font-bold tabular-nums" :class="kpis.offline > 0 ? 'text-amber-400' : 'text-slate-100'">{{ kpis.offline }}</p>
      </button>
    </div>

    <!-- Toolbar -->
    <div class="mt-5 flex flex-wrap items-center gap-2 text-sm">
      <input
        v-model="search"
        type="search"
        placeholder="Search by name or address"
        class="min-w-[14rem] flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
      />
      <select v-model="statusFilter" class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-200" aria-label="Status">
        <option value="all">All cameras</option>
        <option value="active">Active</option>
        <option value="offline">Offline</option>
      </select>
      <select v-model="levelFilter" class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-200" aria-label="Traffic level">
        <option value="all">Any traffic</option>
        <option v-for="(label, level) in TRAFFIC_LABELS" :key="level" :value="level">{{ label }}</option>
      </select>
      <select v-model="sortKey" class="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-200" aria-label="Sort">
        <option value="busiest">Busiest first</option>
        <option value="level">Traffic level</option>
        <option value="name">Name</option>
      </select>
      <div class="flex gap-1 rounded-lg bg-slate-900 p-1" role="group" aria-label="Layout">
        <button
          v-for="option in ['grid', 'list'] as const"
          :key="option"
          type="button"
          class="rounded-md px-2.5 py-1 text-xs font-medium capitalize"
          :class="layout === option ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'"
          @click="layout = option"
        >
          {{ option }}
        </button>
      </div>
    </div>

    <p v-if="loading" class="mt-8 text-sm text-slate-400">Loading cameras…</p>
    <p v-else-if="error" class="mt-8 text-sm text-red-400">{{ error }}</p>
    <p v-else-if="visibleCameras.length === 0" class="mt-8 text-sm text-slate-400">No cameras match these filters.</p>
    <div v-else :class="layout === 'grid' ? 'mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'mt-4 space-y-2'">
      <CameraCard
        v-for="camera in visibleCameras"
        :key="camera.id"
        :camera="camera"
        :overview="overviewByCameraId.get(camera.id)"
        :summary="summaryByCameraId.get(camera.id)"
        :range="range"
        :layout="layout"
        :snapshot-tick="snapshotTick"
      />
    </div>
  </main>
</template>
