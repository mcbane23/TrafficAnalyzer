<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Bar, Line } from 'vue-chartjs';
import type { ChartData, ChartOptions } from 'chart.js';
import type { CameraEntry } from '../../types/camera';
import type { CameraStats, StatsSummary } from '../../types/stats';
import { fetchCameras } from '../services/api';
import { fetchCameraStats, fetchStatsSummary } from '../services/stats';
import { rankedCameras } from '../services/statsRanking';
import { RANGES, formatCount, useStatsRange } from '../composables/trafficUi';
import { formatBucketLabel } from '../components/charts/chartSetup';
import { t } from '../i18n';

const range = useStatsRange();
const cameras = ref<CameraEntry[]>([]);
const summary = ref<StatsSummary | null>(null);
const error = ref<string | null>(null);

/** Cameras drawn in the comparison chart; defaults to the three busiest. */
const MAX_COMPARED = 5;
const selected = ref<string[]>([]);
const compared = ref<CameraStats[]>([]);

// Distinguishable series colors for up to MAX_COMPARED cameras.
const SERIES_COLORS = ['#38bdf8', '#f97316', '#a78bfa', '#22c55e', '#f43f5e'];

const nameById = computed(() => new Map(cameras.value.map((c) => [c.id, c.name])));
const rangeLabel = computed(() => RANGES.find((r) => r.value === range.value)?.label ?? range.value);

const ranked = computed(() => rankedCameras(summary.value?.cameras ?? [], nameById.value));

const rankingHeight = computed(() => `${Math.max(160, ranked.value.length * 28 + 60)}px`);

const rankingData = computed<ChartData<'bar'>>(() => ({
  labels: ranked.value.map((c) => nameById.value.get(c.cameraId) ?? c.cameraId),
  datasets: [
    { label: t('chart.cars'), data: ranked.value.map((c) => c.car), backgroundColor: '#38bdf8', stack: 's' },
    { label: t('chart.largeApprox'), data: ranked.value.map((c) => c.large), backgroundColor: '#f59e0b', stack: 's' },
  ],
}));

const rankingOptions: ChartOptions<'bar'> = {
  indexAxis: 'y',
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  scales: {
    x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
    y: { stacked: true, grid: { display: false } },
  },
  plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } } },
};

const comparisonData = computed<ChartData<'line'>>(() => {
  const first = compared.value[0];
  return {
    labels: first ? first.buckets.map((b) => formatBucketLabel(b.start, first.bucket, first.range, first.timeZone)) : [],
    datasets: compared.value.map((stats, i) => ({
      label: nameById.value.get(stats.cameraId) ?? stats.cameraId,
      // Mostly-unanalyzed buckets break the line instead of dipping it towards zero.
      data: stats.buckets.map((b) => (b.coverage < 0.5 ? null : b.total)),
      borderColor: SERIES_COLORS[i % SERIES_COLORS.length],
      backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length],
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.3,
      spanGaps: false,
    })),
  };
});

const comparisonOptions = computed<ChartOptions<'line'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  interaction: { mode: 'index', intersect: false },
  scales: {
    x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } },
    y: { beginAtZero: true, title: { display: true, text: t('chart.perBucket') }, ticks: { precision: 0 } },
  },
  plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } } },
}));

function toggle(cameraId: string) {
  if (selected.value.includes(cameraId)) selected.value = selected.value.filter((id) => id !== cameraId);
  else if (selected.value.length < MAX_COMPARED) selected.value = [...selected.value, cameraId];
}

async function loadSummary() {
  try {
    summary.value = await fetchStatsSummary(range.value);
    error.value = null;
    if (selected.value.length === 0) selected.value = ranked.value.slice(0, 3).map((c) => c.cameraId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('stats.loadFailed');
  }
}

async function loadCompared() {
  const ids = [...selected.value];
  const results = await Promise.allSettled(ids.map((id) => fetchCameraStats(id, range.value)));
  compared.value = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

onMounted(async () => {
  try {
    cameras.value = await fetchCameras();
  } catch {
    // Names fall back to ids.
  }
  await loadSummary();
});
watch(range, async () => {
  await loadSummary();
  await loadCompared();
});
watch(selected, loadCompared);
</script>

<template>
  <main class="mx-auto max-w-7xl px-4 py-6">
    <h1 class="text-2xl font-bold text-slate-100">{{ t('stats.title') }}</h1>
    <p class="mt-1 text-sm text-slate-400">
      {{ t('stats.subtitle', { range: rangeLabel }) }}
      <template v-if="summary"> · {{ t('stats.total', { count: formatCount(summary.totals.total) }) }}</template>
    </p>
    <p v-if="error" class="mt-6 text-sm text-red-400">{{ error }}</p>

    <section class="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 class="text-base font-semibold text-slate-100">{{ t('stats.busiest') }}</h2>
      <p v-if="summary && ranked.length === 0" class="mt-3 text-sm text-slate-500">{{ t('stats.noVehicles') }}</p>
      <div v-else-if="summary" class="mt-4" :style="{ height: rankingHeight }">
        <Bar :data="rankingData" :options="rankingOptions" />
      </div>
      <p v-else class="mt-3 text-sm text-slate-500">{{ t('cam.loadingShort') }}</p>
    </section>

    <section class="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-5">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-base font-semibold text-slate-100">{{ t('stats.compare') }}</h2>
        <p class="text-xs text-slate-500">{{ t('stats.pick', { max: MAX_COMPARED }) }}</p>
      </div>
      <div class="mt-3 flex flex-wrap gap-1.5">
        <button
          v-for="camera in cameras.filter((c) => c.status === 'active')"
          :key="camera.id"
          type="button"
          class="rounded-full border px-2.5 py-0.5 text-xs transition"
          :class="
            selected.includes(camera.id)
              ? 'border-transparent text-slate-950'
              : 'border-slate-700 text-slate-400 hover:text-slate-200 disabled:opacity-40'
          "
          :style="selected.includes(camera.id) ? { backgroundColor: SERIES_COLORS[selected.indexOf(camera.id)] } : {}"
          :disabled="!selected.includes(camera.id) && selected.length >= MAX_COMPARED"
          @click="toggle(camera.id)"
        >
          {{ camera.name }}
        </button>
      </div>
      <div v-if="compared.length" class="mt-4 h-80">
        <Line :data="comparisonData" :options="comparisonOptions" />
      </div>
      <p v-else class="mt-4 text-sm text-slate-500">{{ t('stats.select') }}</p>
    </section>
  </main>
</template>
