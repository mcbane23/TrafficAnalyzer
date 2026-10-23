<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { CameraEntry } from '../../types/camera';
import type { CameraAnalysisOverview, TrafficLevel } from '../../types/analysis';
import type { StatsSummary } from '../../types/stats';
import { fetchCameras } from '../services/api';
import { fetchAnalyzedCameras, fetchLatestOverview, subscribeOverview } from '../services/analysis';
import { fetchSnapshotTimes, fetchStatsSummary } from '../services/stats';
import { RANGES, TRAFFIC_LABELS, formatCount, useStatsRange } from '../composables/trafficUi';
import CameraCard from '../components/CameraCard.vue';
import AppIcon from '../components/AppIcon.vue';
import { favoriteIds } from '../composables/favorites';
import { t } from '../i18n';

const range = useStatsRange();
const cameras = ref<CameraEntry[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

// Dashboard-wide traffic overview (count + Light/Moderate/Heavy badge per
// camera): one shared bootstrap call + one shared SSE connection for the
// whole dashboard, rather than every CameraCard opening its own stream.
const overviewByCameraId = shallowRef(new Map<string, CameraAnalysisOverview>());
let unsubscribeOverview: (() => void) | null = null;

// Cameras the Admin page switches the analysis on for; null until loaded (or when every camera is analyzed).
// Analysis is off for every camera by default, so a fresh install would otherwise show a dashboard of
// empty cards and zero counts that looks broken rather than switched off.
const analyzedIds = ref<Set<string> | null>(null);
const isAnalyzed = (camera: CameraEntry) => camera.status === 'active' && (analyzedIds.value === null || analyzedIds.value.has(camera.id));
const analyzedCount = computed(() => cameras.value.filter(isAnalyzed).length);
const noneAnalyzed = computed(() => !loading.value && analyzedIds.value !== null && cameras.value.length > 0 && analyzedCount.value === 0);

const summary = ref<StatsSummary | null>(null);
const summaryByCameraId = computed(() => new Map((summary.value?.cameras ?? []).map((c) => [c.cameraId, c])));

const SUMMARY_REFRESH_MS = 60_000;
const SNAPSHOT_REFRESH_MS = 30_000;
const snapshotTick = ref(Date.now());
const snapshotTimes = ref<Record<string, string>>({});
// The clock the cards' "pre 12 s" thumbnail ages are measured against.
const now = ref(Date.now());
let clockHandle: ReturnType<typeof setInterval> | null = null;
let summaryHandle: ReturnType<typeof setInterval> | null = null;
let snapshotHandle: ReturnType<typeof setInterval> | null = null;

// Toolbar state, persisted per browser - a convenience, never required.
type SortKey = 'busiest' | 'name' | 'level';
const search = ref('');
const statusFilter = ref<'all' | 'favorites' | 'active' | 'analyzed' | 'offline'>('all');
const levelFilter = ref<'all' | TrafficLevel>('all');
const sortKey = ref<SortKey>('busiest');
// A phone fits one big card per screen, so it starts with the list (one row per camera).
const narrowScreen = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches;
const layout = ref<'grid' | 'list'>(narrowScreen ? 'list' : 'grid');
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
    if (statusFilter.value === 'favorites' && !favoriteIds.value.has(camera.id)) return false;
    if (statusFilter.value === 'active' && camera.status !== 'active') return false;
    if (statusFilter.value === 'analyzed' && !isAnalyzed(camera)) return false;
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
  const favorite = (camera: CameraEntry) => favoriteIds.value.has(camera.id);
  return [...list].sort((x, y) => {
    // Starred cameras always come first.
    if (favorite(x) !== favorite(y)) return favorite(x) ? -1 : 1;
    if (x.status !== y.status) return x.status === 'active' ? -1 : 1;
    if (isAnalyzed(x) !== isAnalyzed(y)) return isAnalyzed(x) ? -1 : 1;
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

async function loadSnapshotTimes() {
  try {
    snapshotTimes.value = await fetchSnapshotTimes();
  } catch {
    // Non-fatal: cards just don't show the thumbnail's age.
  }
}
watch(snapshotTick, loadSnapshotTimes);

onMounted(async () => {
  loadSummary();
  summaryHandle = setInterval(loadSummary, SUMMARY_REFRESH_MS);
  snapshotHandle = setInterval(() => (snapshotTick.value = Date.now()), SNAPSHOT_REFRESH_MS);
  clockHandle = setInterval(() => (now.value = Date.now()), 5_000);
  loadSnapshotTimes();

  try {
    cameras.value = await fetchCameras();
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('dash.loadFailed');
  } finally {
    loading.value = false;
  }

  try {
    const ids = await fetchAnalyzedCameras();
    analyzedIds.value = ids === null ? null : new Set(ids);
  } catch {
    // Unknown: treat every active camera as analyzed, as before.
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
  if (clockHandle !== null) clearInterval(clockHandle);
});
</script>

<template>
  <main class="mx-auto max-w-7xl px-4 py-4 sm:py-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-bold text-slate-100 sm:text-2xl">{{ t('dash.title') }}</h1>
        <p class="mt-1 text-sm text-slate-400">{{ t('dash.subtitle', { range: rangeLabel }) }}</p>
      </div>
    </div>

    <!-- First run: every camera's analysis is off until switched on in Admin. -->
    <div v-if="noneAnalyzed" class="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3">
      <div class="min-w-0 max-w-3xl">
        <p class="font-medium text-sky-200">{{ t('dash.noneAnalyzed.title') }}</p>
        <p class="mt-0.5 text-sm text-slate-300">{{ t('dash.noneAnalyzed.body') }}</p>
      </div>
      <router-link to="/admin" class="shrink-0 rounded-md bg-sky-400 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-sky-300">
        {{ t('dash.noneAnalyzed.action') }}
      </router-link>
    </div>

    <!-- KPI row -->
    <div class="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-3 sm:p-4">
        <p class="text-xs text-slate-500">{{ t('dash.kpi.passed', { range: rangeLabel }) }}</p>
        <p v-if="noneAnalyzed && !kpis.passed" class="mt-1 text-xl font-bold sm:text-2xl text-slate-500" :title="t('dash.kpi.passedOff')">–</p>
        <p v-else class="mt-1 text-xl font-bold sm:text-2xl tabular-nums text-slate-100">{{ kpis.passed === null ? '–' : formatCount(kpis.passed) }}</p>
        <p v-if="noneAnalyzed" class="mt-0.5 text-[11px] text-slate-500">{{ t('dash.kpi.passedOff') }}</p>
      </div>
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-3 sm:p-4">
        <p class="text-xs text-slate-500">{{ t('dash.kpi.active') }}</p>
        <p class="mt-1 text-xl font-bold sm:text-2xl tabular-nums text-slate-100">{{ kpis.active }}<span class="text-base font-medium text-slate-500"> / {{ kpis.total }}</span></p>
        <p v-if="analyzedIds !== null" class="mt-0.5 text-[11px] text-slate-500">{{ t('dash.kpi.analyzed', { count: analyzedCount }) }}</p>
      </div>
      <button type="button" class="rounded-xl border border-slate-800 bg-slate-900 p-3 sm:p-4 text-left hover:border-slate-600" :aria-pressed="levelFilter === 'heavy'" @click="levelFilter = levelFilter === 'heavy' ? 'all' : 'heavy'">
        <p class="text-xs text-slate-500">{{ t('dash.kpi.heavy') }}</p>
        <p class="mt-1 text-xl font-bold sm:text-2xl tabular-nums" :class="kpis.heavy > 0 ? 'text-red-400' : 'text-slate-100'">{{ kpis.heavy }}</p>
      </button>
      <button type="button" class="rounded-xl border border-slate-800 bg-slate-900 p-3 sm:p-4 text-left hover:border-slate-600" :aria-pressed="statusFilter === 'offline'" @click="statusFilter = statusFilter === 'offline' ? 'all' : 'offline'">
        <p class="text-xs text-slate-500">{{ t('dash.kpi.offline') }}</p>
        <p class="mt-1 text-xl font-bold sm:text-2xl tabular-nums" :class="kpis.offline > 0 ? 'text-amber-400' : 'text-slate-100'">{{ kpis.offline }}</p>
      </button>
    </div>

    <!-- Toolbar -->
    <div class="mt-5 flex flex-wrap items-center gap-2 text-sm">
      <input
        id="dashboard-search"
        v-model="search"
        type="search"
        :placeholder="t('dash.search')"
        :aria-label="t('dash.search')"
        class="min-w-[14rem] flex-1 basis-full rounded-lg sm:basis-auto border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
      />
      <select v-model="statusFilter" class="flex-auto rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-200 sm:flex-none" :aria-label="t('dash.filter.status')">
        <option value="all">{{ t('dash.filter.all') }}</option>
        <option value="favorites">{{ t('dash.filter.favorites') }}</option>
        <option value="active">{{ t('dash.filter.active') }}</option>
        <option value="analyzed">{{ t('dash.filter.analyzed') }}</option>
        <option value="offline">{{ t('dash.filter.offline') }}</option>
      </select>
      <select v-model="levelFilter" class="flex-auto rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-200 sm:flex-none" :aria-label="t('dash.filter.level')">
        <option value="all">{{ t('dash.filter.anyLevel') }}</option>
        <option v-for="(label, level) in TRAFFIC_LABELS" :key="level" :value="level">{{ label }}</option>
      </select>
      <select v-model="sortKey" class="flex-auto rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-200 sm:flex-none" :aria-label="t('dash.sort')">
        <option value="busiest">{{ t('dash.sort.busiest') }}</option>
        <option value="level">{{ t('dash.sort.level') }}</option>
        <option value="name">{{ t('dash.sort.name') }}</option>
      </select>
      <div class="flex gap-1 rounded-lg bg-slate-900 p-1" role="group" :aria-label="t('dash.layout')">
        <button
          v-for="option in ['grid', 'list'] as const"
          :key="option"
          type="button"
          class="rounded-md px-2.5 py-1 text-xs font-medium"
          :class="layout === option ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'"
          :aria-pressed="layout === option"
          @click="layout = option"
        >
          <span class="inline-flex items-center gap-1"><AppIcon :name="option" :size="13" />{{ t(option === 'grid' ? 'dash.layout.grid' : 'dash.layout.list') }}</span>
        </button>
      </div>
    </div>

    <p v-if="loading" class="mt-8 text-sm text-slate-400">{{ t('dash.loading') }}</p>
    <p v-else-if="error" class="mt-8 text-sm text-red-400">{{ error }}</p>
    <p v-else-if="visibleCameras.length === 0" class="mt-8 text-sm text-slate-400">{{ t('dash.empty') }}</p>
    <div v-else :class="layout === 'grid' ? 'mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'mt-4 space-y-2'">
      <CameraCard
        v-for="camera in visibleCameras"
        :key="camera.id"
        :camera="camera"
        :analyzed="isAnalyzed(camera)"
        :overview="overviewByCameraId.get(camera.id)"
        :summary="summaryByCameraId.get(camera.id)"
        :range="range"
        :layout="layout"
        :snapshot-tick="snapshotTick"
        :snapshot-at="snapshotTimes[camera.id]"
        :now="now"
      />
    </div>
  </main>
</template>
