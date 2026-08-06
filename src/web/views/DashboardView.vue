<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { CameraEntry } from '../../types/camera';
import type { CameraAnalysisOverview } from '../../types/analysis';
import { fetchCameras, fetchRevalidationStatus, startRevalidation } from '../services/api';
import { fetchLatestOverview, subscribeOverview } from '../services/analysis';
import CameraCard from '../components/CameraCard.vue';

const cameras = ref<CameraEntry[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

// Dashboard-wide traffic overview (count + Light/Moderate/Heavy badge per
// camera): one shared bootstrap call + one shared SSE connection for the
// whole dashboard, rather than every CameraCard opening its own stream.
const overviewByCameraId = shallowRef(new Map<string, CameraAnalysisOverview>());
let unsubscribeOverview: (() => void) | null = null;

const checking = ref(false);
const checkError = ref<string | null>(null);
const checkProgress = ref<{ checked: number; total: number; active: number } | null>(null);
let pollHandle: ReturnType<typeof setInterval> | null = null;

function stopPolling() {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

async function pollStatus() {
  try {
    const status = await fetchRevalidationStatus();
    checkProgress.value = { checked: status.checked, total: status.total, active: status.active };
    if (status.state === 'idle') {
      stopPolling();
      checking.value = false;
      checkError.value = status.error ?? null;
      cameras.value = await fetchCameras();
    }
  } catch (err) {
    stopPolling();
    checking.value = false;
    checkError.value = err instanceof Error ? err.message : 'Failed to check availability status.';
  }
}

async function runAvailabilityCheck() {
  if (checking.value) return;
  checking.value = true;
  checkError.value = null;
  checkProgress.value = null;
  try {
    await startRevalidation();
    stopPolling();
    pollHandle = setInterval(pollStatus, 1500);
  } catch (err) {
    checking.value = false;
    checkError.value = err instanceof Error ? err.message : 'Failed to start availability check.';
  }
}

onMounted(async () => {
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
    // Non-fatal: cards just show without a count/badge until the SSE stream delivers one.
  }

  unsubscribeOverview = subscribeOverview((entry) => {
    const map = new Map(overviewByCameraId.value);
    map.set(entry.cameraId, entry);
    overviewByCameraId.value = map;
  });
});

onBeforeUnmount(() => {
  stopPolling();
  unsubscribeOverview?.();
});

</script>

<template>
  <main class="mx-auto max-w-6xl px-4 py-8">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-slate-100">Belgrade Traffic Cameras</h1>
        <p class="mt-1 text-sm text-slate-400">{{ cameras.length }} camera(s) in the registry</p>
      </div>
      <div class="flex flex-col items-end gap-1">
        <button
          type="button"
          :disabled="checking"
          @click="runAvailabilityCheck"
          class="inline-flex items-center gap-2 rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 shadow-sm transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span v-if="checking" class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-900/30 border-t-slate-900"></span>
          {{ checking ? 'Checking availability…' : 'Check availability' }}
        </button>
        <p v-if="checking && checkProgress" class="text-xs text-slate-400">
          {{ checkProgress.checked }} / {{ checkProgress.total }} checked ({{ checkProgress.active }} active)
        </p>
        <p v-if="checkError" class="text-xs text-red-400">{{ checkError }}</p>
      </div>
    </div>

    <p v-if="loading" class="mt-8 text-sm text-slate-400">Loading cameras…</p>
    <p v-else-if="error" class="mt-8 text-sm text-red-400">{{ error }}</p>
    <div v-else class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <CameraCard v-for="camera in cameras" :key="camera.id" :camera="camera" :overview="overviewByCameraId.get(camera.id)" />
    </div>
  </main>
</template>
