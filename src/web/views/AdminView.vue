<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { CaptureCounters, ServerMetrics } from '../../types/admin';
import { fetchRevalidationStatus, startRevalidation } from '../services/api';
import { fetchServerMetrics } from '../services/admin';
import Sparkline from '../components/charts/Sparkline.vue';
import AnalysisSwitches from '../components/AnalysisSwitches.vue';

// The server samples CPU every 5 s, so polling faster would only repeat the same reading.
const REFRESH_MS = 5_000;

const metrics = ref<ServerMetrics | null>(null);
const error = ref<string | null>(null);
let refreshHandle: ReturnType<typeof setInterval> | null = null;

async function load() {
  // Nobody is looking - skip the request rather than keep the server busy for a background tab.
  if (typeof document !== 'undefined' && document.hidden && metrics.value) return;
  try {
    metrics.value = await fetchServerMetrics();
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load server metrics.';
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
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

const fmt = (value: number | null | undefined, digits = 1, suffix = '') => (value == null ? '–' : `${value.toFixed(digits)}${suffix}`);

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
        <h1 class="text-2xl font-bold text-slate-100">Admin</h1>
        <p class="mt-1 text-sm text-slate-400">
          Server health and maintenance · refreshes every {{ REFRESH_MS / 1000 }} s
          <template v-if="metrics"> · {{ metrics.host.hostname }}</template>
        </p>
      </div>
    </div>

    <p v-if="error" class="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{{ error }}</p>
    <p v-if="!metrics && !error" class="mt-8 text-sm text-slate-400">Loading server metrics…</p>

    <template v-if="metrics">
      <!-- Load tiles -->
      <div class="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">Machine CPU</p>
          <p class="mt-1 text-2xl font-bold tabular-nums" :class="loadClass(latestCpu?.system ?? null)">{{ fmt(latestCpu?.system, 0, '%') }}</p>
          <Sparkline class="mt-2" :values="systemTrend" :max="100" color="#38bdf8" />
          <p class="mt-1 text-[11px] text-slate-500">All {{ metrics.host.cores }} cores, every process · last 10 min</p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">TrafficAnalyzer CPU</p>
          <p class="mt-1 text-2xl font-bold tabular-nums" :class="loadClass(serverCpuPercent)">{{ fmt(serverCpuPercent, 0, '%') }}</p>
          <Sparkline class="mt-2" :values="serverTrend" :max="100" color="#a78bfa" />
          <p class="mt-1 text-[11px] text-slate-500">
            Node {{ fmt(metrics.process.nodeCpu === null ? null : metrics.process.nodeCpu / 100, 2) }} cores ·
            ffmpeg {{ fmt(metrics.process.childrenCpu === null ? null : metrics.process.childrenCpu / 100, 2) }} cores
          </p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">Load average (1 / 5 / 15 min)</p>
          <p class="mt-1 text-2xl font-bold tabular-nums" :class="metrics.host.loadAverage[0] > cores ? 'text-amber-400' : 'text-slate-100'">
            {{ metrics.host.loadAverage[0].toFixed(2) }}
            <span class="text-base font-medium text-slate-500">/ {{ metrics.host.loadAverage[1].toFixed(2) }} / {{ metrics.host.loadAverage[2].toFixed(2) }}</span>
          </p>
          <p class="mt-3 text-[11px] text-slate-500">Above {{ cores }} (the core count) means work is waiting for a CPU.</p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">Event loop delay (p99)</p>
          <p class="mt-1 text-2xl font-bold tabular-nums" :class="(latestCpu?.eventLoopMs ?? 0) > 200 ? 'text-amber-400' : 'text-slate-100'">{{ fmt(latestCpu?.eventLoopMs, 0, ' ms') }}</p>
          <Sparkline class="mt-2" :values="loopTrend" color="#f59e0b" />
          <p class="mt-1 text-[11px] text-slate-500">How late the server answers requests and hands out frames.</p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">Memory used</p>
          <p class="mt-1 text-2xl font-bold tabular-nums" :class="loadClass(memoryUsedPercent)">{{ fmt(memoryUsedPercent, 0, '%') }}</p>
          <p class="mt-1 text-[11px] text-slate-500">
            {{ formatBytes(metrics.host.memory.availableBytes) }} free of {{ formatBytes(metrics.host.memory.totalBytes) }}<br />
            Node {{ formatBytes(metrics.process.rssBytes) }} · ffmpeg {{ formatBytes(metrics.process.childrenMemoryBytes) }}
          </p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">Analysis throughput</p>
          <p class="mt-1 text-2xl font-bold tabular-nums" :class="laggingCameras > 0 ? 'text-amber-400' : 'text-slate-100'">
            {{ fleetFps.toFixed(1) }}<span class="text-base font-medium text-slate-500"> fps</span>
          </p>
          <p class="mt-1 text-[11px] text-slate-500">
            {{ analysisCameras.length }} cameras × {{ metrics.analysis.fpsTarget }} fps target ·
            {{ laggingCameras }} behind
          </p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">ffmpeg processes</p>
          <p class="mt-1 text-2xl font-bold tabular-nums text-slate-100">{{ metrics.process.ffmpegProcesses ?? '–' }}</p>
          <p class="mt-1 text-[11px] text-slate-500">One per analyzed camera, plus one per camera with live boxes.</p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs text-slate-500">Uptime</p>
          <p class="mt-1 text-2xl font-bold tabular-nums text-slate-100">{{ formatDuration(metrics.process.uptimeSec) }}</p>
          <p class="mt-1 text-[11px] text-slate-500">Host up {{ formatDuration(metrics.host.uptimeSec) }}</p>
        </div>
      </div>

      <!-- Live overlay (YOLO) -->
      <section class="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="font-semibold text-slate-100">Live vehicle boxes (YOLO)</h2>
          <p class="text-xs text-slate-400">
            <template v-if="metrics.overlay.enabled">
              {{ metrics.host.gpu.model ?? `${metrics.host.gpu.device}, model not loaded yet` }}
              <template v-if="metrics.host.gpu.freqMhz !== null"> · GPU {{ metrics.host.gpu.freqMhz }} / {{ metrics.host.gpu.maxFreqMhz ?? '?' }} MHz</template>
              · up to {{ metrics.overlay.maxCameras }} cameras at once
            </template>
            <template v-else>Switched off (OVERLAY_DETECTOR=off)</template>
          </p>
        </div>
        <p v-if="metrics.overlay.enabled && metrics.overlay.cameras.length === 0" class="mt-3 text-sm text-slate-500">
          Idle - YOLO only runs while someone is watching a camera.
        </p>
        <div v-else-if="metrics.overlay.cameras.length > 0" class="mt-3 overflow-x-auto">
          <table class="w-full whitespace-nowrap text-left text-sm">
            <thead class="text-xs text-slate-500">
              <tr>
                <th class="py-1.5 pr-4 font-medium">Camera</th>
                <th class="py-1.5 pr-4 text-right font-medium">Viewers</th>
                <th class="py-1.5 pr-4 text-right font-medium">Frames/s</th>
                <th class="py-1.5 pr-4 text-right font-medium">Detection</th>
                <th class="py-1.5 pr-4 text-right font-medium">Boxes/frame</th>
                <th class="py-1.5 pr-4 text-right font-medium" title="Stream seconds analyzed per second - below 1x the boxes fall behind the picture">Stream speed</th>
                <th class="py-1.5 pr-4 text-right font-medium">Restarts</th>
                <th class="py-1.5 text-right font-medium" title="Frames skipped because the detector was still busy">Skipped</th>
              </tr>
            </thead>
            <tbody class="tabular-nums text-slate-200">
              <tr v-for="camera in metrics.overlay.cameras" :key="camera.cameraId" class="border-t border-slate-800">
                <td class="py-1.5 pr-4">
                  <router-link :to="`/cameras/${camera.cameraId}`" class="hover:text-sky-400">{{ camera.name }}</router-link>
                </td>
                <td class="py-1.5 pr-4 text-right">{{ camera.viewers }}</td>
                <td class="py-1.5 pr-4 text-right">{{ camera.fps.toFixed(1) }}</td>
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

      <!-- Which cameras are analyzed -->
      <AnalysisSwitches class="mt-6" @changed="load" />

      <!-- Fleet analysis -->
      <section class="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="font-semibold text-slate-100">Camera analysis (motion + tracking)</h2>
          <p class="text-xs text-slate-400">
            {{ metrics.analysis.threads > 0 ? `${metrics.analysis.threads} worker threads` : 'main thread' }} ·
            {{ metrics.analysis.activeJobs }} / {{ metrics.analysis.maxConcurrency }} frames in progress ·
            <span :class="metrics.analysis.queuedJobs > 0 ? 'text-amber-400' : ''">{{ metrics.analysis.queuedJobs }} waiting</span>
          </p>
        </div>
        <p class="mt-1 text-[11px] text-slate-500">Rates are over the last 15 s; slowest cameras first. Restarts, stalls and skipped frames count since the server started.</p>
        <p v-if="analysisCameras.length === 0" class="mt-3 text-sm text-slate-500">No cameras are being analyzed.</p>
        <div v-else class="mt-3 overflow-x-auto">
          <table class="w-full whitespace-nowrap text-left text-sm">
            <thead class="text-xs text-slate-500">
              <tr>
                <th class="py-1.5 pr-4 font-medium">Camera</th>
                <th class="py-1.5 pr-4 text-right font-medium">Frames/s</th>
                <th class="py-1.5 pr-4 text-right font-medium">Analysis</th>
                <th class="py-1.5 pr-4 text-right font-medium" title="Stream seconds analyzed per second - about 1x when keeping up with the live stream">Stream speed</th>
                <th class="py-1.5 pr-4 text-right font-medium">Last frame</th>
                <th class="py-1.5 pr-4 text-right font-medium" title="ffmpeg restarts after it exited or stalled">Restarts</th>
                <th class="py-1.5 pr-4 text-right font-medium" title="Runs killed because the stream stopped delivering frames">Stalls</th>
                <th class="py-1.5 pr-4 text-right font-medium" title="Frames thrown away because analysis was behind">Skipped</th>
                <th class="py-1.5 font-medium">Last error</th>
              </tr>
            </thead>
            <tbody class="tabular-nums text-slate-200">
              <tr v-for="camera in analysisCameras" :key="camera.cameraId" class="border-t border-slate-800">
                <td class="py-1.5 pr-4">
                  <router-link :to="`/cameras/${camera.cameraId}`" class="hover:text-sky-400">{{ camera.name }}</router-link>
                </td>
                <td class="py-1.5 pr-4 text-right" :class="fpsClass(camera.fps)">{{ camera.fps.toFixed(1) }}</td>
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
          <h2 class="font-semibold text-slate-100">Storage</h2>
          <dl class="mt-3 space-y-1.5 text-sm">
            <div v-for="db in metrics.storage" :key="db.name" class="flex justify-between gap-4">
              <dt class="text-slate-400">{{ db.name }} database</dt>
              <dd class="tabular-nums text-slate-200">{{ formatBytes(db.bytes) }}</dd>
            </div>
            <div v-if="metrics.host.disk" class="flex justify-between gap-4">
              <dt class="text-slate-400">Data volume free</dt>
              <dd class="tabular-nums" :class="loadClass(diskUsedPercent)">
                {{ formatBytes(metrics.host.disk.freeBytes) }} of {{ formatBytes(metrics.host.disk.totalBytes) }}
              </dd>
            </div>
          </dl>
        </section>

        <!-- Maintenance -->
        <section class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 class="font-semibold text-slate-100">Camera availability</h2>
          <p class="mt-1 text-xs text-slate-400">
            Re-probes every camera stream and updates which ones are active. When it finishes, analysis starts on cameras
            that came back and stops on ones that went offline.
          </p>
          <button
            type="button"
            :disabled="checking"
            class="mt-3 inline-flex items-center justify-center gap-2 rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            @click="runAvailabilityCheck"
          >
            <span v-if="checking" class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-900/30 border-t-slate-900"></span>
            {{ checking ? 'Checking availability…' : 'Check camera availability' }}
          </button>
          <p v-if="checking && checkProgress" class="mt-2 text-xs text-slate-400">
            {{ checkProgress.checked }} / {{ checkProgress.total }} checked ({{ checkProgress.active }} active)
          </p>
          <p v-else-if="lastCheck" class="mt-2 text-xs text-slate-400">
            Last check {{ new Date(lastCheck.finishedAt).toLocaleString() }}: {{ lastCheck.active }} of {{ lastCheck.total }} active
          </p>
          <p v-if="checkError" class="mt-2 text-xs text-red-400">{{ checkError }}</p>
        </section>
      </div>

      <!-- System info -->
      <p class="mt-6 text-[11px] text-slate-500">
        {{ metrics.host.cpuModel }} · {{ metrics.host.cores }} cores<template v-if="metrics.host.cpuLimit !== null"> (container limit {{ metrics.host.cpuLimit }})</template>
        · {{ metrics.host.platform }} · Node {{ metrics.process.nodeVersion }} · pid {{ metrics.process.pid }} · heap {{ formatBytes(metrics.process.heapUsedBytes) }}
      </p>
    </template>
  </main>
</template>
