<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CameraEntry } from '../../types/camera';
import type { CameraAnalysisResult, StoredAnalysisResult, TrafficLevel } from '../../types/analysis';
import { fetchCameraHistory, subscribeCameraAnalysis } from '../services/analysis';

const props = defineProps<{ camera: CameraEntry }>();

const TRAFFIC_BADGE_STYLES: Record<TrafficLevel, string> = {
  light: 'bg-emerald-500/15 text-emerald-400',
  moderate: 'bg-amber-500/15 text-amber-400',
  heavy: 'bg-red-500/15 text-red-400',
};

const TRAFFIC_LABELS: Record<TrafficLevel, string> = {
  light: 'Light',
  moderate: 'Moderate',
  heavy: 'Heavy',
};

const OCCUPANCY_BAR_STYLES: Record<TrafficLevel, string> = {
  light: 'bg-emerald-500',
  moderate: 'bg-amber-500',
  heavy: 'bg-red-500',
};

const isActive = computed(() => props.camera.status === 'active');
const result = ref<CameraAnalysisResult | null>(null);
const history = ref<StoredAnalysisResult[]>([]);
const historyError = ref<string | null>(null);
const streamDisconnected = ref(false);

let unsubscribe: (() => void) | null = null;

const hasResultError = computed(() => Boolean(result.value?.error));
// No result yet, or the server's background model is still learning the scene
// (its zero count then says nothing about the road).
const isWarmingUp = computed(() => isActive.value && (!result.value || Boolean(result.value.warmingUp)));

/** Occupancy as a whole percentage, or null while the server's estimator is still learning the scene. */
const occupancyPct = computed(() => {
  const value = result.value?.occupancy;
  return value === undefined ? null : Math.round(value * 100);
});

const colorChips = computed(() => {
  if (!result.value) return [];
  return result.value.detections
    .map((detection, index) => ({ key: index, color: detection.color }))
    .filter((chip): chip is { key: number; color: string } => Boolean(chip.color));
});

/** Bars for the mini trend chart, scaled relative to the highest count currently in the window. */
const trendBars = computed(() => {
  if (history.value.length === 0) return [];
  const max = Math.max(1, ...history.value.map((entry) => entry.totalCount));
  return history.value.map((entry) => ({
    timestamp: entry.timestamp,
    count: entry.totalCount,
    heightPct: Math.max(6, Math.round((entry.totalCount / max) * 100)),
  }));
});

const trendDirection = computed<'up' | 'down' | 'flat' | null>(() => {
  if (history.value.length < 2) return null;
  const delta = history.value[history.value.length - 1].totalCount - history.value[0].totalCount;
  if (delta > 0) return 'up';
  if (delta < 0) return 'down';
  return 'flat';
});

async function loadHistory(cameraId: string) {
  historyError.value = null;
  try {
    history.value = await fetchCameraHistory(cameraId, 20);
  } catch (err) {
    historyError.value = err instanceof Error ? err.message : 'Failed to load traffic history.';
  }
}

function appendToTrend(latest: CameraAnalysisResult) {
  if (latest.error) return;
  const entry: StoredAnalysisResult = {
    cameraId: latest.cameraId,
    timestamp: latest.timestamp,
    totalCount: latest.totalCount,
    trafficLevel: latest.trafficLevel,
  };
  history.value = [...history.value, entry].slice(-20);
}

function connect(cameraId: string) {
  unsubscribe?.();
  unsubscribe = null;
  result.value = null;
  streamDisconnected.value = false;

  if (!isActive.value) return;

  unsubscribe = subscribeCameraAnalysis(
    cameraId,
    (incoming) => {
      result.value = incoming;
      streamDisconnected.value = false;
      appendToTrend(incoming);
    },
    () => {
      streamDisconnected.value = true;
    },
  );
}

function setup(cameraId: string) {
  history.value = [];
  connect(cameraId);
  loadHistory(cameraId);
}

onMounted(() => setup(props.camera.id));
watch(() => props.camera.id, (id) => setup(id));
onBeforeUnmount(() => unsubscribe?.());
</script>

<template>
  <div class="flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-sm">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold text-slate-100">Traffic analysis</h2>
      <span
        v-if="result && !hasResultError"
        class="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium"
        :class="TRAFFIC_BADGE_STYLES[result.trafficLevel]"
      >
        {{ TRAFFIC_LABELS[result.trafficLevel] }}
      </span>
    </div>

    <!-- Inactive camera: no analysis is attempted, so say so clearly rather than showing a stale/misleading count. -->
    <div v-if="!isActive" class="mt-6 flex flex-1 flex-col items-center justify-center text-center">
      <p class="text-sm font-medium text-slate-400">Camera offline</p>
      <p class="mt-1 text-xs text-slate-500">No traffic analysis is available while this camera is inactive.</p>
    </div>

    <!-- Warming up: no result yet, or the detector is still learning this camera's background. -->
    <div v-else-if="isWarmingUp" class="mt-6 flex flex-1 flex-col items-center justify-center text-center">
      <span class="h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-slate-300"></span>
      <p class="mt-3 text-sm font-medium text-slate-400">Analyzing traffic…</p>
      <p class="mt-1 text-xs text-slate-500">Learning the scene usually takes a few seconds after the stream connects.</p>
    </div>

    <!-- Frame capture / detection failed for the latest tick. -->
    <div v-else-if="hasResultError" class="mt-6 flex flex-1 flex-col items-center justify-center text-center">
      <p class="text-sm font-medium text-red-400">Analysis unavailable</p>
      <p class="mt-1 text-xs text-slate-500">{{ result?.error }}</p>
    </div>

    <template v-else-if="result">
      <div class="mt-4 flex items-baseline gap-2">
        <span class="text-3xl font-bold text-slate-100">{{ result.totalCount }}</span>
        <span class="text-sm text-slate-400">vehicle{{ result.totalCount === 1 ? '' : 's' }} detected</span>
      </div>

      <!--
        Occupancy is what the traffic badge above is actually derived from, so
        it's shown next to the count rather than hidden: the two can legitimately
        disagree - a road can read as busy while few individual vehicles are
        resolved at distance - and that looks like a bug unless the measurement
        driving the badge is visible.
      -->
      <div v-if="occupancyPct !== null" class="mt-3">
        <div class="flex items-baseline justify-between">
          <span class="text-xs font-medium text-slate-500">Road occupancy</span>
          <span class="text-xs font-medium text-slate-300">{{ occupancyPct }}%</span>
        </div>
        <div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
          <div class="h-full rounded-full" :class="OCCUPANCY_BAR_STYLES[result.trafficLevel]" :style="{ width: `${occupancyPct}%` }"></div>
        </div>
      </div>

      <div v-if="colorChips.length > 0" class="mt-4">
        <p class="text-xs font-medium text-slate-500">Detected colors</p>
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          <span
            v-for="chip in colorChips"
            :key="chip.key"
            class="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-300"
          >
            <span class="h-2.5 w-2.5 rounded-full border border-white/10" :style="{ backgroundColor: chip.color }"></span>
            {{ chip.color }}
          </span>
        </div>
      </div>

      <div class="mt-5 flex-1">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-slate-500">Recent trend</p>
          <span
            v-if="trendDirection"
            class="text-xs font-medium"
            :class="{
              'text-red-400': trendDirection === 'up',
              'text-emerald-400': trendDirection === 'down',
              'text-slate-500': trendDirection === 'flat',
            }"
          >
            {{ trendDirection === 'up' ? '▲ increasing' : trendDirection === 'down' ? '▼ decreasing' : '— steady' }}
          </span>
        </div>
        <p v-if="historyError" class="mt-2 text-xs text-red-400">{{ historyError }}</p>
        <div v-else-if="trendBars.length > 0" class="mt-2 flex h-16 items-end gap-0.5">
          <div
            v-for="(bar, index) in trendBars"
            :key="`${bar.timestamp}-${index}`"
            class="flex-1 rounded-sm bg-slate-600"
            :style="{ height: `${bar.heightPct}%` }"
            :title="`${bar.count} vehicle(s) at ${new Date(bar.timestamp).toLocaleTimeString()}`"
          ></div>
        </div>
        <p v-else class="mt-2 text-xs text-slate-500">Not enough history yet.</p>
      </div>

      <p v-if="streamDisconnected" class="mt-3 text-xs text-amber-400">Live updates disconnected - showing the last known result.</p>
    </template>
  </div>
</template>

