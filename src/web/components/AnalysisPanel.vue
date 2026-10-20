<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CameraEntry } from '../../types/camera';
import type { CameraAnalysisResult } from '../../types/analysis';
import type { LiveCounts, PassageCounts } from '../../types/stats';
import { subscribeCameraAnalysis } from '../services/analysis';
import { fetchLiveCounts } from '../services/stats';
import { DIRECTION_COLORS, TRAFFIC_BADGE_STYLES, TRAFFIC_BAR_STYLES, TRAFFIC_LABELS, formatCount } from '../composables/trafficUi';

/**
 * The "Now" panel on a camera's page: what the camera sees this instant
 * (from the per-frame SSE stream) and how many vehicles have passed
 * recently (polled from the stats API - passages land once per vehicle, so
 * a few seconds' delay is invisible next to a 5-minute window).
 */
const props = defineProps<{ camera: CameraEntry; directionLabels: { a: string; b: string } }>();

const LIVE_POLL_MS = 5000;

const isActive = computed(() => props.camera.status === 'active');
const result = ref<CameraAnalysisResult | null>(null);
const streamDisconnected = ref(false);
const live = ref<LiveCounts | null>(null);

let unsubscribe: (() => void) | null = null;
let pollHandle: ReturnType<typeof setInterval> | null = null;

const hasResultError = computed(() => Boolean(result.value?.error));
// No result yet, or the server's background model is still learning the scene
// (its zero count then says nothing about the road).
const isWarmingUp = computed(() => isActive.value && (!result.value || Boolean(result.value.warmingUp)));

/** Occupancy as a whole percentage, or null while the server's estimator is still learning the scene. */
const occupancyPct = computed(() => {
  const value = result.value?.occupancy;
  return value === undefined ? null : Math.round(value * 100);
});

const counters = computed<Array<{ label: string; counts: PassageCounts }>>(() =>
  live.value
    ? [
        { label: 'Last 5 min', counts: live.value.last5m },
        { label: 'Last hour', counts: live.value.last1h },
        { label: 'Today', counts: live.value.today },
      ]
    : [],
);

function share(part: number, total: number): string {
  return total > 0 ? `${(part / total) * 100}%` : '0%';
}

async function refreshLive(cameraId: string) {
  try {
    live.value = await fetchLiveCounts(cameraId);
  } catch {
    // Keep the last counts; the next poll retries.
  }
}

function stop() {
  unsubscribe?.();
  unsubscribe = null;
  if (pollHandle !== null) clearInterval(pollHandle);
  pollHandle = null;
}

function setup(cameraId: string) {
  stop();
  result.value = null;
  live.value = null;
  streamDisconnected.value = false;
  if (!isActive.value) return;

  unsubscribe = subscribeCameraAnalysis(
    cameraId,
    (incoming) => {
      result.value = incoming;
      streamDisconnected.value = false;
    },
    () => {
      streamDisconnected.value = true;
    },
  );
  refreshLive(cameraId);
  pollHandle = setInterval(() => refreshLive(cameraId), LIVE_POLL_MS);
}

onMounted(() => setup(props.camera.id));
watch(() => props.camera.id, (id) => setup(id));
onBeforeUnmount(stop);
</script>

<template>
  <div class="flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900 p-5">
    <div class="flex items-center justify-between gap-2">
      <h2 class="text-sm font-semibold text-slate-100">Now</h2>
      <span
        v-if="result && !hasResultError && !isWarmingUp"
        class="shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium"
        :class="TRAFFIC_BADGE_STYLES[result.trafficLevel]"
      >
        {{ TRAFFIC_LABELS[result.trafficLevel] }} traffic
      </span>
    </div>

    <!-- Inactive camera: no analysis is attempted, so say so clearly rather than showing a stale/misleading count. -->
    <div v-if="!isActive" class="mt-6 flex flex-1 flex-col items-center justify-center text-center">
      <p class="text-sm font-medium text-slate-400">Camera offline</p>
      <p class="mt-1 text-xs text-slate-500">No traffic analysis is available while this camera is inactive.</p>
    </div>

    <template v-else>
      <div v-if="isWarmingUp" class="mt-4 flex items-center gap-3">
        <span class="h-4 w-4 animate-spin rounded-full border-2 border-slate-700 border-t-slate-300"></span>
        <p class="text-xs text-slate-400">Learning the scene - usually a few seconds after the stream connects.</p>
      </div>

      <div v-else-if="hasResultError" class="mt-4 rounded-lg bg-red-500/10 p-3">
        <p class="text-sm font-medium text-red-400">Analysis unavailable</p>
        <p class="mt-0.5 text-xs text-slate-400">{{ result?.error }}</p>
      </div>

      <template v-else-if="result">
        <div class="mt-4 grid grid-cols-2 gap-3">
          <div>
            <p class="text-xs text-slate-500">In view</p>
            <p class="text-3xl font-bold tabular-nums text-slate-100">{{ result.totalCount }}</p>
          </div>
          <div>
            <p class="text-xs text-slate-500">Road occupancy</p>
            <p class="text-3xl font-bold tabular-nums text-slate-100">{{ occupancyPct === null ? '–' : `${occupancyPct}%` }}</p>
          </div>
        </div>
        <!--
          Occupancy is what the traffic badge is derived from, so it's shown
          next to the count: the two can legitimately disagree (a busy road with
          few vehicles resolved at distance), which looks like a bug unless the
          measurement driving the badge is visible.
        -->
        <div v-if="occupancyPct !== null" class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
          <div class="h-full rounded-full" :class="TRAFFIC_BAR_STYLES[result.trafficLevel]" :style="{ width: `${occupancyPct}%` }"></div>
        </div>
      </template>

      <div class="mt-6 border-t border-slate-800 pt-4">
        <p class="text-xs font-medium uppercase tracking-wide text-slate-500">Vehicles passed</p>
        <p v-if="!live" class="mt-2 text-xs text-slate-500">Loading counts…</p>
        <ul v-else class="mt-3 space-y-4">
          <li v-for="counter in counters" :key="counter.label">
            <div class="flex items-baseline justify-between">
              <span class="text-sm text-slate-400">{{ counter.label }}</span>
              <span class="text-2xl font-semibold tabular-nums text-slate-100">{{ formatCount(counter.counts.total) }}</span>
            </div>
            <div class="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-800" :title="`${directionLabels.a}: ${counter.counts.a}, ${directionLabels.b}: ${counter.counts.b}, unclear: ${counter.counts.unknown}`">
              <div :style="{ width: share(counter.counts.a, counter.counts.total), backgroundColor: DIRECTION_COLORS.a }"></div>
              <div :style="{ width: share(counter.counts.b, counter.counts.total), backgroundColor: DIRECTION_COLORS.b }"></div>
              <div :style="{ width: share(counter.counts.unknown, counter.counts.total), backgroundColor: DIRECTION_COLORS.unknown }"></div>
            </div>
            <div class="mt-1 flex flex-wrap justify-between gap-x-3 text-[11px] text-slate-500">
              <span><span :style="{ color: DIRECTION_COLORS.a }">●</span> {{ directionLabels.a }} {{ counter.counts.a }}</span>
              <span><span :style="{ color: DIRECTION_COLORS.b }">●</span> {{ directionLabels.b }} {{ counter.counts.b }}</span>
              <span title="Approximate, from vehicle size">{{ counter.counts.large }} large*</span>
            </div>
          </li>
        </ul>
        <p class="mt-4 text-[11px] leading-snug text-slate-500">
          * Bus/truck-sized, estimated from box size - approximate. Directions are learned from how traffic moves on this camera.
        </p>
      </div>

      <p v-if="streamDisconnected" class="mt-3 text-xs text-amber-400">Live updates disconnected - showing the last known result.</p>
    </template>
  </div>
</template>
