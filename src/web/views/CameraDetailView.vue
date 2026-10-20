<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { CameraEntry } from '../../types/camera';
import type { CameraHeatmap, CameraStats, StatsBucket } from '../../types/stats';
import { fetchCameraById } from '../services/api';
import { cameraStatsCsvUrl, fetchCameraHeatmap, fetchCameraStats } from '../services/stats';
import { ALLOWED_BUCKETS_UI, directionLabels, formatCount, useStatsRange } from '../composables/trafficUi';
import StreamPlayer from '../components/StreamPlayer.vue';
import AnalysisPanel from '../components/AnalysisPanel.vue';
import VolumeChart from '../components/charts/VolumeChart.vue';
import HourHeatmap from '../components/charts/HourHeatmap.vue';
import '../components/charts/chartSetup';

const route = useRoute();
const range = useStatsRange();
const camera = ref<CameraEntry | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const showBoxes = ref(true);
const showTrails = ref(false);
const player = ref<InstanceType<typeof StreamPlayer> | null>(null);

const bucket = ref<StatsBucket | null>(null);
const stats = ref<CameraStats | null>(null);
const statsError = ref<string | null>(null);
const heatmap = ref<CameraHeatmap | null>(null);
let refreshHandle: ReturnType<typeof setInterval> | null = null;

const STATS_REFRESH_MS = 60_000;

const labels = computed(() => directionLabels(camera.value, stats.value?.axis));
const bucketOptions = computed(() => ALLOWED_BUCKETS_UI[range.value]);
const activeBucket = computed(() => (bucket.value && bucketOptions.value.some((o) => o.value === bucket.value) ? bucket.value : bucketOptions.value[0].value));

/** The three busiest analyzed buckets in the range. */
const peaks = computed(() => {
  if (!stats.value) return [];
  return stats.value.buckets
    .filter((b) => b.coverage >= 0.5 && b.total > 0)
    .sort((x, y) => y.total - x.total)
    .slice(0, 3);
});

function formatPeak(iso: string): string {
  const date = new Date(iso);
  const tz = stats.value?.timeZone;
  if (activeBucket.value === '1d') return date.toLocaleDateString(undefined, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
  return date.toLocaleString(undefined, { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

async function loadCamera(id: string) {
  loading.value = true;
  error.value = null;
  try {
    camera.value = await fetchCameraById(id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load camera.';
  } finally {
    loading.value = false;
  }
}

async function loadStats() {
  const id = route.params.id as string;
  try {
    stats.value = await fetchCameraStats(id, range.value, activeBucket.value);
    statsError.value = null;
  } catch (err) {
    statsError.value = err instanceof Error ? err.message : 'Failed to load statistics.';
  }
}

async function loadHeatmap() {
  try {
    heatmap.value = await fetchCameraHeatmap(route.params.id as string, 7);
  } catch {
    heatmap.value = null;
  }
}

function loadAll() {
  loadStats();
  loadHeatmap();
}

onMounted(() => {
  loadCamera(route.params.id as string);
  loadAll();
  refreshHandle = setInterval(loadAll, STATS_REFRESH_MS);
});
onBeforeUnmount(() => {
  if (refreshHandle !== null) clearInterval(refreshHandle);
});
watch(
  () => route.params.id,
  (id) => {
    if (!id) return;
    stats.value = null;
    heatmap.value = null;
    loadCamera(id as string);
    loadAll();
  },
);
watch([range, activeBucket], () => loadStats());
</script>

<template>
  <main class="mx-auto max-w-7xl px-4 py-6">
    <router-link :to="{ path: '/', query: { range } }" class="text-sm font-medium text-slate-400 hover:text-slate-200">&larr; All cameras</router-link>

    <p v-if="loading" class="mt-8 text-sm text-slate-400">Loading camera…</p>
    <p v-else-if="error" class="mt-8 text-sm text-red-400">{{ error }}</p>
    <template v-else-if="camera">
      <div class="mt-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 class="text-2xl font-bold text-slate-100">{{ camera.name }}</h1>
          <p class="mt-1 text-sm text-slate-400">{{ camera.location.address ?? `${camera.location.lat}, ${camera.location.lon}` }} · {{ camera.source }}</p>
        </div>
      </div>

      <div class="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div class="lg:col-span-2">
          <StreamPlayer ref="player" :camera="camera" :show-boxes="showBoxes" :show-trails="showTrails" />
          <div class="mt-2 flex flex-wrap items-center gap-4 text-xs text-slate-400">
            <label class="inline-flex cursor-pointer items-center gap-1.5">
              <input v-model="showBoxes" type="checkbox" class="accent-sky-400" /> Vehicle boxes
            </label>
            <label class="inline-flex cursor-pointer items-center gap-1.5">
              <input v-model="showTrails" type="checkbox" class="accent-sky-400" /> Motion trails
            </label>
            <button type="button" class="ml-auto rounded-md px-2 py-1 hover:bg-slate-800 hover:text-slate-200" @click="player?.toggleFullscreen()">
              ⛶ Fullscreen
            </button>
          </div>
        </div>
        <AnalysisPanel :camera="camera" :direction-labels="labels" />
      </div>

      <section class="mt-8 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-base font-semibold text-slate-100">Vehicles passed</h2>
            <p v-if="stats" class="mt-0.5 text-sm text-slate-400">
              <span class="font-semibold text-slate-100">{{ formatCount(stats.totals.total) }}</span>
              in the selected range ·
              {{ stats.totals.a }} {{ labels.a }} · {{ stats.totals.b }} {{ labels.b }} · {{ stats.totals.large }} large* ·
              analyzed {{ Math.round(stats.coverage * 100) }}% of the time
            </p>
          </div>
          <div class="flex items-center gap-2 text-xs">
            <div class="flex gap-1 rounded-lg bg-slate-950 p-1" role="group" aria-label="Bucket size">
              <button
                v-for="option in bucketOptions"
                :key="option.value"
                type="button"
                class="rounded-md px-2 py-1 font-medium"
                :class="activeBucket === option.value ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'"
                @click="bucket = option.value"
              >
                {{ option.label }}
              </button>
            </div>
            <a
              :href="cameraStatsCsvUrl(camera.id, range, activeBucket)"
              class="rounded-md border border-slate-700 px-2.5 py-1.5 font-medium text-slate-300 hover:bg-slate-800"
              download
            >
              Export CSV
            </a>
          </div>
        </div>

        <p v-if="statsError" class="mt-4 text-sm text-red-400">{{ statsError }}</p>
        <p v-else-if="!stats" class="mt-4 text-sm text-slate-500">Loading statistics…</p>
        <template v-else>
          <div class="mt-4">
            <VolumeChart :stats="stats" :labels="labels" />
          </div>
          <p class="mt-2 text-[11px] text-slate-500">Shaded periods were mostly not analyzed (camera offline or server not running) and are left out rather than drawn as low traffic.</p>
        </template>

        <div class="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-3">
          <div class="lg:col-span-2">
            <h3 class="text-sm font-semibold text-slate-100">Typical week</h3>
            <p class="mt-0.5 text-xs text-slate-500">Average vehicles per hour over the last 7 days ({{ heatmap?.timeZone ?? 'local time' }}).</p>
            <div class="mt-3">
              <HourHeatmap v-if="heatmap" :heatmap="heatmap" />
              <p v-else class="text-xs text-slate-500">Loading…</p>
            </div>
          </div>
          <div>
            <h3 class="text-sm font-semibold text-slate-100">Busiest periods</h3>
            <p class="mt-0.5 text-xs text-slate-500">In the selected range, per {{ bucketOptions.find((o) => o.value === activeBucket)?.label }}.</p>
            <ol v-if="peaks.length" class="mt-3 space-y-2">
              <li v-for="(peak, i) in peaks" :key="peak.start" class="flex items-baseline justify-between rounded-lg bg-slate-950 px-3 py-2 text-sm">
                <span class="text-slate-400">{{ i + 1 }}. {{ formatPeak(peak.start) }}</span>
                <span class="font-semibold tabular-nums text-slate-100">{{ formatCount(peak.total) }}</span>
              </li>
            </ol>
            <p v-else class="mt-3 text-xs text-slate-500">No fully analyzed periods with traffic yet.</p>
          </div>
        </div>
      </section>
    </template>
  </main>
</template>
