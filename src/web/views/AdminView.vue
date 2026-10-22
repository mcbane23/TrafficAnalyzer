<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { CaptureCounters, ServerMetrics } from '../../types/admin';
import { fetchRevalidationStatus, startRevalidation } from '../services/api';
import { fetchServerMetrics } from '../services/admin';
import Sparkline from '../components/charts/Sparkline.vue';
import AnalysisSwitches from '../components/AnalysisSwitches.vue';
import CameraManager from '../components/CameraManager.vue';
import { formatNumber, intlLocale, t, tDynamic } from '../i18n';

// The server samples CPU every 5 s, so polling faster would only repeat the same reading.
const REFRESH_MS = 5_000;

const metrics = ref<ServerMetrics | null>(null);
const error = ref<string | null>(null);
/** Bumped when the camera list changes, so the analysis switches reload it. */
const camerasVersion = ref(0);
let refreshHandle: ReturnType<typeof setInterval> | null = null;

async function load() {
  // Nobody is looking - skip the request rather than keep the server busy for a background tab.
  if (typeof document !== 'undefined' && document.hidden && metrics.value) return;
  try {
    metrics.value = await fetchServerMetrics();
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('admin.loadFailed');
  }
}

const latestCpu = computed(() => metrics.value?.cpu.at(-1) ?? null);
const cores = computed(() => metrics.value?.host.cores ?? 1);
/** This server's CPU (Node + ffmpeg) as a share of the whole machine, so it reads on the same 0-100 scale as machine CPU. */
const serverCpuPercent = computed(() => (latestCpu.value?.process == null ? null : latestCpu.value.process / cores.value));
const systemTrend = computed(() => metrics.value?.cpu.map((s) => s.system) ?? []);
const serverTrend = computed(() => metrics.value?.cpu.map((s) => (s.process === null ? null : s.process / cores.value)) ?? []);
const loopTrend = computed(() => metrics.value?.cpu.map((s) => s.eventLoopMs) ?? []);

const memoryUsedPercent = computed(() => {
  const memory = metrics.value?.host.memory;
  return memory ? (1 - memory.availableBytes / memory.totalBytes) * 100 : null;
});

const diskUsedPercent = computed(() => {
  const disk = metrics.value?.host.disk;
  return disk ? (1 - disk.freeBytes / disk.totalBytes) * 100 : null;
});

const analysisCameras = computed(() => {
  const list = metrics.value?.analysis.cameras ?? [];
  return [...list].sort((a, b) => a.fps - b.fps || a.name.localeCompare(b.name));
});

const fleetFps = computed(() => analysisCameras.value.reduce((sum, c) => sum + c.fps, 0));
const laggingCameras = computed(() => {
  const target = metrics.value?.analysis.fpsTarget ?? 3;
  return analysisCameras.value.filter((c) => c.fps < target * 0.7).length;
});

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${formatNumber(value, { maximumFractionDigits: value >= 100 || unit === 0 ? 0 : 1, minimumFractionDigits: value >= 100 || unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

const fmt = (value: number | null | undefined, digits = 1, suffix = '') =>
  value == null ? '–' : `${formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${suffix}`;

/** Red/amber/plain for a 0-100 load figure. */
function loadClass(percent: number | null): string {
  if (percent === null) return 'text-slate-100';
  if (percent >= 85) return 'text-red-400';
  if (percent >= 65) return 'text-amber-400';
  return 'text-slate-100';
}

/** Stream seconds per wall second: ~1 is keeping up with the live picture, lower means falling behind. */
function ratioClass(ratio: number | null): string {
  if (ratio === null) return 'text-slate-500';
  if (ratio < 0.7) return 'text-red-400';
  if (ratio < 0.9) return 'text-amber-400';
  return 'text-slate-200';
}

function fpsClass(fps: number): string {
  const target = metrics.value?.analysis.fpsTarget ?? 3;
  if (fps === 0) return 'text-red-400';
  if (fps < target * 0.7) return 'text-amber-400';
  return 'text-slate-200';
}

/** How long ago a capture last decoded a frame, relative to when the server built this snapshot. */
function frameAge(capture: CaptureCounters | null): string {
  if (!capture?.lastFrameAt || !metrics.value) return '–';
  const seconds = Math.max(0, (Date.parse(metrics.value.generatedAt) - Date.parse(capture.lastFrameAt)) / 1000);
  return seconds < 60 ? `${Math.round(seconds)} s` : formatDuration(seconds);
}

const restarts = (capture: CaptureCounters | null) => (capture ? Math.max(0, capture.starts - 1) : null);

// Availability check: the same ffprobe pass as the CLI, run in the background on the server.
const checking = ref(false);
const checkError = ref<string | null>(null);
const checkProgress = ref<{ checked: number; total: number; active: number } | null>(null);
const lastCheck = ref<{ finishedAt: string; active: number; total: number } | null>(null);
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
      if (status.finishedAt) lastCheck.value = { finishedAt: status.finishedAt, active: status.active, total: status.total };
    } else if (!pollHandle) {
      // A run started elsewhere (another tab, the CLI's web twin) - follow it.
      checking.value = true;
      pollHandle = setInterval(pollStatus, 1500);
    }
  } catch (err) {
    stopPolling();
    checking.value = false;
    checkError.value = err instanceof Error ? err.message : t('admin.checkStatusFailed');
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
    checkError.value = err instanceof Error ? err.message : t('admin.checkFailed');
  }
}

onMounted(() => {
  load();
  refreshHandle = setInterval(load, REFRESH_MS);
  pollStatus();
});

onBeforeUnmount(() => {
  stopPolling();
  if (refreshHandle !== null) clearInterval(refreshHandle);
});
</script>

<template>
  <main class="mx-auto max-w-7xl px-4 py-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-slate-100">{{ t('nav.admin') }}</h1>
        <p class="mt-1 text-sm text-slate-400">
          {{ t('admin.subtitle', { seconds: REFRESH_MS / 1000 }) }}
          <template v-if="metrics"> · {{ metrics.host.hostname }}</template>
        </p>
      </div>
    </div>

    <p v-if="error" class="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{{ error }}</p>
    <p v-if="!metrics && !error" class="mt-8 text-sm text-slate-400">{{ t('admin.loading') }}</p>

    <template v-if="metrics">
      <!-- Load tiles -->
      <div class="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">{{ t('admin.cpu') }}</p>
          <p class="mt-1 text-2xl font-bold tabular-nums" :class="loadClass(latestCpu?.system ?? null)">{{ fmt(latestCpu?.system, 0, '%') }}</p>
          <Sparkline class="mt-2" :values="systemTrend" :max="100" color="#38bdf8" />
          <p class="mt-1 text-[11px] text-slate-500">{{ t('admin.cpuNote', { cores: metrics.host.cores }) }}</p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">{{ t('admin.appCpu') }}</p>
          <p class="mt-1 text-2xl font-bold tabular-nums" :class="loadClass(serverCpuPercent)">{{ fmt(serverCpuPercent, 0, '%') }}</p>
          <Sparkline class="mt-2" :values="serverTrend" :max="100" color="#a78bfa" />
          <p class="mt-1 text-[11px] text-slate-500">
            {{
              t('admin.appCpuNote', {
                node: fmt(metrics.process.nodeCpu === null ? null : metrics.process.nodeCpu / 100, 2),
                ffmpeg: fmt(metrics.process.childrenCpu === null ? null : metrics.process.childrenCpu / 100, 2),
              })
            }}
          </p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">{{ t('admin.load') }}</p>
          <p class="mt-1 text-2xl font-bold tabular-nums" :class="metrics.host.loadAverage[0] > cores ? 'text-amber-400' : 'text-slate-100'">
            {{ fmt(metrics.host.loadAverage[0], 2) }}
            <span class="text-base font-medium text-slate-500">/ {{ fmt(metrics.host.loadAverage[1], 2) }} / {{ fmt(metrics.host.loadAverage[2], 2) }}</span>
          </p>
          <p class="mt-3 text-[11px] text-slate-500">{{ t('admin.loadNote', { cores }) }}</p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">{{ t('admin.loop') }}</p>
          <p class="mt-1 text-2xl font-bold tabular-nums" :class="(latestCpu?.eventLoopMs ?? 0) > 200 ? 'text-amber-400' : 'text-slate-100'">{{ fmt(latestCpu?.eventLoopMs, 0, ' ms') }}</p>
          <Sparkline class="mt-2" :values="loopTrend" color="#f59e0b" />
          <p class="mt-1 text-[11px] text-slate-500">{{ t('admin.loopNote') }}</p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">{{ t('admin.memory') }}</p>
          <p class="mt-1 text-2xl font-bold tabular-nums" :class="loadClass(memoryUsedPercent)">{{ fmt(memoryUsedPercent, 0, '%') }}</p>
          <p class="mt-1 text-[11px] text-slate-500">
            {{ t('admin.memoryNote', { free: formatBytes(metrics.host.memory.availableBytes), total: formatBytes(metrics.host.memory.totalBytes) }) }}<br />
            Node {{ formatBytes(metrics.process.rssBytes) }} · ffmpeg {{ formatBytes(metrics.process.childrenMemoryBytes) }}
          </p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">{{ t('admin.throughput') }}</p>
          <p class="mt-1 text-2xl font-bold tabular-nums" :class="laggingCameras > 0 ? 'text-amber-400' : 'text-slate-100'">
            {{ fmt(fleetFps, 1) }}<span class="text-base font-medium text-slate-500"> fps</span>
          </p>
          <p class="mt-1 text-[11px] text-slate-500">
            {{ t('admin.throughputNote', { cameras: analysisCameras.length, fps: metrics.analysis.fpsTarget, behind: laggingCameras }) }}
          </p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">{{ t('admin.ffmpeg') }}</p>
          <p class="mt-1 text-2xl font-bold tabular-nums text-slate-100">{{ metrics.process.ffmpegProcesses ?? '–' }}</p>
          <p class="mt-1 text-[11px] text-slate-500">{{ t('admin.ffmpegNote') }}</p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">{{ t('admin.uptime') }}</p>
          <p class="mt-1 text-2xl font-bold tabular-nums text-slate-100">{{ formatDuration(metrics.process.uptimeSec) }}</p>
          <p class="mt-1 text-[11px] text-slate-500">{{ t('admin.hostUptime', { uptime: formatDuration(metrics.host.uptimeSec) }) }}</p>
        </div>
      </div>

      <!-- Live overlay (YOLO) -->
      <section class="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="font-semibold text-slate-100">{{ t('admin.overlay') }}</h2>
          <p class="text-xs text-slate-400">
            <template v-if="metrics.overlay.enabled">
              {{ metrics.host.gpu.model ?? t('admin.overlayModelPending', { device: metrics.host.gpu.device }) }}
              <template v-if="metrics.host.gpu.freqMhz !== null"> · GPU {{ metrics.host.gpu.freqMhz }} / {{ metrics.host.gpu.maxFreqMhz ?? '?' }} MHz</template>
              · {{ t('admin.overlayMax', { count: metrics.overlay.maxCameras }) }}
            </template>
            <template v-else>{{ t('admin.overlayOff') }}</template>
          </p>
        </div>
        <p v-if="metrics.overlay.enabled && metrics.overlay.cameras.length === 0" class="mt-3 text-sm text-slate-500">
          {{ t('admin.overlayIdle') }}
        </p>
        <div v-else-if="metrics.overlay.cameras.length > 0" class="mt-3 overflow-x-auto">
          <table class="w-full whitespace-nowrap text-left text-sm">
            <thead class="text-xs text-slate-500">
              <tr>
                <th class="py-1.5 pr-4 font-medium">{{ t('admin.col.camera') }}</th>
                <th class="py-1.5 pr-4 text-right font-medium">{{ t('admin.col.viewers') }}</th>
                <th class="py-1.5 pr-4 text-right font-medium">{{ t('admin.col.fps') }}</th>
                <th class="py-1.5 pr-4 text-right font-medium">{{ t('admin.col.detection') }}</th>
                <th class="py-1.5 pr-4 text-right font-medium">{{ t('admin.col.boxes') }}</th>
                <th class="py-1.5 pr-4 text-right font-medium" :title="t('admin.col.speedOverlayTitle')">{{ t('admin.col.speed') }}</th>
                <th class="py-1.5 pr-4 text-right font-medium" :title="t('admin.col.restartsTitle')">{{ t('admin.col.restarts') }}</th>
                <th class="py-1.5 text-right font-medium" :title="t('admin.col.skippedOverlayTitle')">{{ t('admin.col.skipped') }}</th>
              </tr>
            </thead>
            <tbody class="tabular-nums text-slate-200">
              <tr v-for="camera in metrics.overlay.cameras" :key="camera.cameraId" class="border-t border-slate-800">
                <td class="py-1.5 pr-4">
                  <router-link :to="`/cameras/${camera.cameraId}`" class="hover:text-sky-400">{{ camera.name }}</router-link>
                </td>
                <td class="py-1.5 pr-4 text-right">{{ camera.viewers }}</td>
                <td class="py-1.5 pr-4 text-right">{{ fmt(camera.fps, 1) }}</td>
                <td class="py-1.5 pr-4 text-right">{{ fmt(camera.avgMs, 0, ' ms') }}</td>
                <td class="py-1.5 pr-4 text-right">{{ fmt(camera.vehiclesPerFrame, 1) }}</td>
                <td class="py-1.5 pr-4 text-right" :class="ratioClass(camera.streamRatio)">{{ fmt(camera.streamRatio, 2, '×') }}</td>
                <td class="py-1.5 pr-4 text-right">{{ restarts(camera.capture) ?? '–' }}</td>
                <td class="py-1.5 text-right">{{ camera.capture?.dropped ?? '–' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Which cameras are analyzed, frame rates, YOLO model -->
      <AnalysisSwitches :key="camerasVersion" class="mt-6" @changed="load" />

      <CameraManager class="mt-6" @changed="camerasVersion++" />

      <section class="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div class="max-w-3xl">
          <h2 class="font-semibold text-slate-100">{{ t('check.title') }}</h2>
          <p class="mt-1 text-xs text-slate-400">{{ t('check.adminNote') }}</p>
        </div>
        <router-link to="/admin/accuracy" class="rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-white">{{ t('check.openTool') }}</router-link>
      </section>

      <!-- Fleet analysis -->
      <section class="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="font-semibold text-slate-100">{{ t('admin.fleet') }}</h2>
          <p class="text-xs text-slate-400">
            {{ metrics.analysis.threads > 0 ? t('admin.workers', { count: metrics.analysis.threads }) : t('admin.mainThread') }} ·
            {{ t('admin.inProgress', { active: metrics.analysis.activeJobs, max: metrics.analysis.maxConcurrency }) }} ·
            <span :class="metrics.analysis.queuedJobs > 0 ? 'text-amber-400' : ''">{{ t('admin.waiting', { count: metrics.analysis.queuedJobs }) }}</span>
          </p>
        </div>
        <p class="mt-1 text-[11px] text-slate-500">{{ t('admin.fleetNote') }}</p>
        <p v-if="analysisCameras.length === 0" class="mt-3 text-sm text-slate-500">{{ t('admin.fleetEmpty') }}</p>
        <div v-else class="mt-3 overflow-x-auto">
          <table class="w-full whitespace-nowrap text-left text-sm">
            <thead class="text-xs text-slate-500">
              <tr>
                <th class="py-1.5 pr-4 font-medium">{{ t('admin.col.camera') }}</th>
                <th class="py-1.5 pr-4 text-right font-medium">{{ t('admin.col.fps') }}</th>
                <th class="py-1.5 pr-4 text-right font-medium">{{ t('admin.col.analysis') }}</th>
                <th class="py-1.5 pr-4 text-right font-medium" :title="t('admin.col.speedTitle')">{{ t('admin.col.speed') }}</th>
                <th class="py-1.5 pr-4 text-right font-medium">{{ t('admin.col.lastFrame') }}</th>
                <th class="py-1.5 pr-4 text-right font-medium" :title="t('admin.col.restartsTitle')">{{ t('admin.col.restarts') }}</th>
                <th class="py-1.5 pr-4 text-right font-medium" :title="t('admin.col.stallsTitle')">{{ t('admin.col.stalls') }}</th>
                <th class="py-1.5 pr-4 text-right font-medium" :title="t('admin.col.skippedTitle')">{{ t('admin.col.skipped') }}</th>
                <th class="py-1.5 font-medium">{{ t('admin.col.lastError') }}</th>
              </tr>
            </thead>
            <tbody class="tabular-nums text-slate-200">
              <tr v-for="camera in analysisCameras" :key="camera.cameraId" class="border-t border-slate-800">
                <td class="py-1.5 pr-4">
                  <router-link :to="`/cameras/${camera.cameraId}`" class="hover:text-sky-400">{{ camera.name }}</router-link>
                  <span v-if="camera.capture?.shared" class="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300" :title="t('admin.sharedTitle')">{{ t('admin.shared') }}</span>
                </td>
                <td class="py-1.5 pr-4 text-right" :class="fpsClass(camera.fps)">{{ fmt(camera.fps, 1) }}</td>
                <td class="py-1.5 pr-4 text-right">{{ fmt(camera.avgMs, 0, ' ms') }}</td>
                <td class="py-1.5 pr-4 text-right" :class="ratioClass(camera.streamRatio)">{{ fmt(camera.streamRatio, 2, '×') }}</td>
                <td class="py-1.5 pr-4 text-right">{{ frameAge(camera.capture) }}</td>
                <td class="py-1.5 pr-4 text-right">{{ restarts(camera.capture) ?? '–' }}</td>
                <td class="py-1.5 pr-4 text-right" :class="(camera.capture?.stalls ?? 0) > 0 ? 'text-amber-400' : ''">{{ camera.capture?.stalls ?? '–' }}</td>
                <td class="py-1.5 pr-4 text-right">{{ camera.capture?.dropped ?? '–' }}</td>
                <td class="max-w-[16rem] truncate py-1.5 text-xs text-slate-400" :title="camera.capture?.lastError ?? ''">{{ camera.capture?.lastError ?? '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="mt-6 grid gap-4 lg:grid-cols-2">
        <!-- Storage -->
        <section class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 class="font-semibold text-slate-100">{{ t('admin.storage') }}</h2>
          <dl class="mt-3 space-y-1.5 text-sm">
            <div v-for="db in metrics.storage" :key="db.name" class="flex justify-between gap-4">
              <dt class="text-slate-400">{{ t('admin.db', { name: tDynamic(`admin.db.${db.name}`, db.name) }) }}</dt>
              <dd class="tabular-nums text-slate-200">{{ formatBytes(db.bytes) }}</dd>
            </div>
            <div v-if="metrics.host.disk" class="flex justify-between gap-4">
              <dt class="text-slate-400">{{ t('admin.diskFree') }}</dt>
              <dd class="tabular-nums" :class="loadClass(diskUsedPercent)">
                {{ t('admin.of', { a: formatBytes(metrics.host.disk.freeBytes), b: formatBytes(metrics.host.disk.totalBytes) }) }}
              </dd>
            </div>
          </dl>
        </section>

        <!-- Maintenance -->
        <section class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 class="font-semibold text-slate-100">{{ t('admin.availability') }}</h2>
          <p class="mt-1 text-xs text-slate-400">
            {{ t('admin.availabilityNote') }}
          </p>
          <button
            type="button"
            :disabled="checking"
            class="mt-3 inline-flex items-center justify-center gap-2 rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            @click="runAvailabilityCheck"
          >
            <span v-if="checking" class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-900/30 border-t-slate-900"></span>
            {{ checking ? t('admin.checking') : t('admin.check') }}
          </button>
          <p v-if="checking && checkProgress" class="mt-2 text-xs text-slate-400">
            {{ t('admin.checkProgress', { checked: checkProgress.checked, total: checkProgress.total, active: checkProgress.active }) }}
          </p>
          <p v-else-if="lastCheck" class="mt-2 text-xs text-slate-400">
            {{ t('admin.lastCheck', { when: new Date(lastCheck.finishedAt).toLocaleString(intlLocale()), active: lastCheck.active, total: lastCheck.total }) }}
          </p>
          <p v-if="checkError" class="mt-2 text-xs text-red-400">{{ checkError }}</p>
        </section>
      </div>

      <!-- System info -->
      <p class="mt-6 text-[11px] text-slate-500">
        {{ t('admin.system', { cpu: metrics.host.cpuModel, cores: metrics.host.cores }) }}<template v-if="metrics.host.cpuLimit !== null">{{ t('admin.cpuLimit', { limit: metrics.host.cpuLimit }) }}</template>
        · {{ metrics.host.platform }} · Node {{ metrics.process.nodeVersion }} · pid {{ metrics.process.pid }} · heap {{ formatBytes(metrics.process.heapUsedBytes) }}
      </p>
    </template>
  </main>
</template>
