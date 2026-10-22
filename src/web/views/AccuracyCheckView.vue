<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { AccuracyCheck, AccuracyCheckSummary, DirectionCounts, ManualCount } from '../../types/accuracy';
import { countError, countEvents } from '../../types/accuracy';
import type { CameraEntry } from '../../types/camera';
import type { PassageDirection } from '../../types/stats';
import {
  accuracyClipUrl,
  fetchAccuracyCheck,
  fetchAccuracyChecks,
  fetchAdminCameras,
  saveManualCount,
  startAccuracyCheck,
} from '../services/admin';
import { directionLabels } from '../composables/trafficUi';
import { formatNumber, intlLocale, t } from '../i18n';

/**
 * The counting-accuracy check (Admin): record a few minutes of a camera,
 * then count the vehicles on the recording by hand while the app counts the
 * same recording with its live analysis, and compare. Without an id it lists
 * past checks and starts new ones; with one it shows that check.
 */
const props = defineProps<{ id?: string }>();
const router = useRouter();

const POLL_MS = 2_000;

// --- List and start --------------------------------------------------------

const checks = ref<AccuracyCheckSummary[] | null>(null);
const durations = ref<number[]>([300]);
const cameras = ref<CameraEntry[]>([]);
const cameraId = ref('');
const durationSec = ref(300);
const starting = ref(false);
const listError = ref<string | null>(null);

const usableCameras = computed(() => cameras.value.filter((camera) => camera.status === 'active' && !camera.hidden));
const runningSummary = computed(() => checks.value?.find((c) => c.state === 'recording' || c.state === 'analyzing') ?? null);

async function loadList() {
  try {
    const response = await fetchAccuracyChecks();
    checks.value = response.checks;
    durations.value = response.durations;
    listError.value = null;
  } catch (err) {
    listError.value = err instanceof Error ? err.message : t('check.loadFailed');
  }
}

async function loadCameras() {
  try {
    cameras.value = await fetchAdminCameras();
    if (!cameraId.value) cameraId.value = usableCameras.value[0]?.id ?? '';
  } catch (err) {
    listError.value = err instanceof Error ? err.message : t('check.loadFailed');
  }
}

async function start() {
  if (!cameraId.value || starting.value) return;
  starting.value = true;
  try {
    const check = await startAccuracyCheck(cameraId.value, durationSec.value);
    router.push({ name: 'admin-accuracy-check', params: { id: check.id } });
  } catch (err) {
    listError.value = err instanceof Error ? err.message : t('check.startFailed');
  } finally {
    starting.value = false;
  }
}

// --- One check -------------------------------------------------------------

const check = ref<AccuracyCheck | null>(null);
const checkError = ref<string | null>(null);
let pollHandle: ReturnType<typeof setTimeout> | null = null;

async function loadCheck(id: string) {
  try {
    const loaded = await fetchAccuracyCheck(id);
    if (props.id !== id) return;
    const becameReady = check.value?.state !== 'ready' && loaded.state === 'ready';
    check.value = loaded;
    checkError.value = null;
    if (becameReady || !clicksLoadedFor) restoreClicks(loaded);
  } catch (err) {
    checkError.value = err instanceof Error ? err.message : t('check.loadFailed');
  }
  if (props.id === id && (check.value?.state === 'recording' || check.value?.state === 'analyzing')) {
    pollHandle = setTimeout(() => loadCheck(id), POLL_MS);
  }
}

const labels = computed(() => directionLabels({ directions: check.value?.directions } as CameraEntry, check.value?.axis));
const fmtTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** Seconds left in the current step, from its progress and the clip length. */
const remaining = computed(() => {
  const c = check.value;
  if (!c || c.state !== 'recording') return null;
  return Math.max(0, Math.round((1 - c.progress) * (c.warmupSec + c.durationSec)));
});

// Counting: each click is a vehicle at the clip's current time. Kept in the browser as a draft until saved.
const video = ref<HTMLVideoElement | null>(null);
const clicks = ref<ManualCount[]>([]);
const counting = ref(false);
const saving = ref(false);
const currentTime = ref(0);
const videoFailed = ref(false);
let clicksLoadedFor: string | null = null;

const draftKey = (id: string) => `accuracy-draft:${id}`;

function restoreClicks(c: AccuracyCheck) {
  clicksLoadedFor = c.id;
  let draft: ManualCount[] | null = null;
  try {
    const raw = localStorage.getItem(draftKey(c.id));
    draft = raw ? (JSON.parse(raw) as ManualCount[]) : null;
  } catch {
    draft = null;
  }
  clicks.value = draft ?? c.manual ?? [];
  counting.value = !c.manual || !!draft;
}

function storeDraft() {
  if (!check.value) return;
  try {
    localStorage.setItem(draftKey(check.value.id), JSON.stringify(clicks.value));
  } catch {
    // Private mode or full storage: the count just isn't kept over a reload.
  }
}

function count(direction: PassageDirection | null) {
  const v = video.value;
  if (!v || !check.value || !counting.value) return;
  clicks.value = [...clicks.value, { t: Math.round(v.currentTime * 100) / 100, direction }];
  storeDraft();
}

function undo() {
  if (!counting.value) return;
  clicks.value = clicks.value.slice(0, -1);
  storeDraft();
}

function restartCount() {
  clicks.value = [];
  counting.value = true;
  storeDraft();
  if (video.value && check.value) {
    video.value.currentTime = check.value.countFrom;
    video.value.pause();
  }
}

async function finish() {
  const c = check.value;
  if (!c || saving.value) return;
  saving.value = true;
  try {
    check.value = await saveManualCount(c.id, clicks.value);
    clicks.value = check.value.manual ?? [];
    counting.value = false;
    video.value?.pause();
    try {
      localStorage.removeItem(draftKey(c.id));
    } catch {
      // Nothing kept to remove.
    }
  } catch (err) {
    checkError.value = err instanceof Error ? err.message : t('check.saveFailed');
  } finally {
    saving.value = false;
  }
}

function onLoadedMetadata() {
  const v = video.value;
  if (v && check.value && v.currentTime < check.value.countFrom && !clicks.value.length) v.currentTime = check.value.countFrom;
}

function seek(seconds: number) {
  if (video.value) video.value.currentTime = seconds;
}

function onKey(event: KeyboardEvent) {
  if (!check.value || check.value.state !== 'ready' || !video.value) return;
  const target = event.target as HTMLElement | null;
  if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
  const key = event.key.toLowerCase();
  if (key === 'a') count('A');
  else if (key === 'b') count('B');
  else if (key === 'x') count(null);
  else if (key === 'z' || key === 'backspace') undo();
  else if (key === ' ') {
    if (video.value.paused) video.value.play();
    else video.value.pause();
  } else return;
  event.preventDefault();
}

const inWindow = computed(() => {
  const c = check.value;
  return !!c && currentTime.value >= c.countFrom && currentTime.value < c.countTo;
});

const mine = computed(() => (check.value ? countEvents(clicks.value, check.value.countFrom, check.value.countTo) : null));
const app = computed(() => (check.value ? countEvents(check.value.passages, check.value.countFrom, check.value.countTo) : null));

const resultRows = computed(() => {
  if (!mine.value || !app.value) return [];
  const row = (label: string, key: keyof DirectionCounts) => ({
    label,
    mine: mine.value![key],
    app: app.value![key],
    error: countError(app.value![key], mine.value![key]),
  });
  return [row(t('check.total'), 'total'), row(`A: ${labels.value.a}`, 'a'), row(`B: ${labels.value.b}`, 'b')];
});

/** Both counts per minute of the compared stretch, to find where they part. */
const minuteRows = computed(() => {
  const c = check.value;
  if (!c) return [];
  const rows: Array<{ from: number; to: number; mine: number; app: number }> = [];
  for (let from = c.countFrom; from < c.countTo; from += 60) {
    const to = Math.min(c.countTo, from + 60);
    rows.push({ from, to, mine: countEvents(clicks.value, from, to).total, app: countEvents(c.passages, from, to).total });
  }
  return rows;
});

const timelineEnd = computed(() => (check.value ? check.value.warmupSec + check.value.durationSec : 1));
const timelineX = (seconds: number) => `${(seconds / timelineEnd.value) * 100}%`;

function onTimelineClick(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  seek(((event.clientX - rect.left) / rect.width) * timelineEnd.value);
}

function formatError(error: number | null): string {
  if (error === null) return '–';
  const pct = Math.round(error * 100);
  return `${pct > 0 ? '+' : ''}${formatNumber(pct)} %`;
}

function errorClass(error: number | null): string {
  if (error === null) return 'text-slate-400';
  const abs = Math.abs(error);
  return abs <= 0.1 ? 'text-emerald-400' : abs <= 0.25 ? 'text-amber-300' : 'text-red-400';
}

function summaryError(summary: AccuracyCheckSummary): number | null {
  return summary.app && summary.manual ? countError(summary.app.total, summary.manual.total) : null;
}

function stateLabel(state: AccuracyCheck['state']): string {
  return t(`check.state.${state}`);
}

function stop() {
  if (pollHandle !== null) clearTimeout(pollHandle);
  pollHandle = null;
}

watch(
  () => props.id,
  (id) => {
    stop();
    check.value = null;
    clicksLoadedFor = null;
    clicks.value = [];
    if (id) loadCheck(id);
    else {
      loadList();
      loadCameras();
    }
  },
  { immediate: true },
);

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => {
  stop();
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <main class="mx-auto max-w-7xl px-4 py-6">
    <router-link to="/admin" class="text-xs text-sky-400 hover:text-sky-300">← {{ t('check.backToAdmin') }}</router-link>
    <h1 class="mt-1 text-xl font-semibold text-slate-100">{{ t('check.title') }}</h1>

    <!-- List and start -->
    <template v-if="!id">
      <p class="mt-1 max-w-3xl text-sm text-slate-400">{{ t('check.intro') }}</p>
      <p v-if="listError" class="mt-3 text-sm text-red-400">{{ listError }}</p>

      <section class="mt-5 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h2 class="font-semibold text-slate-100">{{ t('check.newTitle') }}</h2>
        <div v-if="runningSummary" class="mt-2 text-sm text-slate-300">
          {{ t('check.alreadyRunning', { camera: runningSummary.cameraName }) }}
          <router-link :to="{ name: 'admin-accuracy-check', params: { id: runningSummary.id } }" class="text-sky-400 hover:text-sky-300">{{ t('check.open') }}</router-link>
        </div>
        <form v-else class="mt-3 flex flex-wrap items-end gap-3" @submit.prevent="start">
          <label class="block text-xs text-slate-500">{{ t('check.camera') }}
            <select v-model="cameraId" class="mt-1 block min-w-56 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100">
              <option v-for="camera in usableCameras" :key="camera.id" :value="camera.id">{{ camera.name }}</option>
            </select>
          </label>
          <label class="block text-xs text-slate-500">{{ t('check.duration') }}
            <select v-model.number="durationSec" class="mt-1 block rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100">
              <option v-for="seconds in [...durations].sort((a, b) => a - b)" :key="seconds" :value="seconds">{{ t('check.minutes', { n: seconds / 60 }) }}</option>
            </select>
          </label>
          <button type="submit" class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-60" :disabled="starting || !cameraId">
            {{ t('check.start') }}
          </button>
        </form>
        <p class="mt-2 text-xs text-slate-500">{{ t('check.startNote') }}</p>
      </section>

      <section class="mt-5 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h2 class="font-semibold text-slate-100">{{ t('check.history') }}</h2>
        <p v-if="checks && !checks.length" class="mt-2 text-sm text-slate-500">{{ t('check.none') }}</p>
        <div v-else-if="checks" class="mt-3 overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="text-xs text-slate-500">
              <tr>
                <th class="py-1 pr-3 font-normal">{{ t('check.col.when') }}</th>
                <th class="py-1 pr-3 font-normal">{{ t('check.camera') }}</th>
                <th class="py-1 pr-3 text-right font-normal">{{ t('check.you') }}</th>
                <th class="py-1 pr-3 text-right font-normal">{{ t('check.app') }}</th>
                <th class="py-1 pr-3 text-right font-normal">{{ t('check.difference') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800">
              <tr v-for="summary in checks" :key="summary.id">
                <td class="whitespace-nowrap py-1.5 pr-3 text-slate-400">{{ new Date(summary.createdAt).toLocaleString(intlLocale(), { dateStyle: 'short', timeStyle: 'short' }) }}</td>
                <td class="py-1.5 pr-3 text-slate-200">{{ summary.cameraName }} <span class="text-xs text-slate-500">· {{ t('check.minutes', { n: summary.durationSec / 60 }) }}</span></td>
                <template v-if="summary.state === 'ready'">
                  <td class="py-1.5 pr-3 text-right tabular-nums text-slate-200">{{ summary.manual?.total ?? '–' }}</td>
                  <td class="py-1.5 pr-3 text-right tabular-nums text-slate-200">{{ summary.app?.total ?? '–' }}</td>
                  <td class="py-1.5 pr-3 text-right tabular-nums" :class="errorClass(summaryError(summary))">{{ formatError(summaryError(summary)) }}</td>
                </template>
                <td v-else colspan="3" class="py-1.5 pr-3 text-right text-xs" :class="summary.state === 'failed' ? 'text-red-400' : 'text-slate-400'">{{ stateLabel(summary.state) }}</td>
                <td class="py-1.5 text-right">
                  <router-link :to="{ name: 'admin-accuracy-check', params: { id: summary.id } }" class="text-xs text-sky-400 hover:text-sky-300">
                    {{ summary.state === 'ready' && !summary.manual ? t('check.countIt') : t('check.open') }}
                  </router-link>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- One check -->
    <template v-else>
      <p v-if="checkError" class="mt-3 text-sm text-red-400">{{ checkError }}</p>
      <p v-if="!check && !checkError" class="mt-3 text-sm text-slate-500">{{ t('check.loading') }}</p>

      <template v-if="check">
        <p class="mt-1 text-sm text-slate-400">
          {{ check.cameraName }} · {{ new Date(check.createdAt).toLocaleString(intlLocale(), { dateStyle: 'short', timeStyle: 'short' }) }} · {{ t('check.minutes', { n: check.durationSec / 60 }) }}
        </p>

        <section v-if="check.state === 'recording' || check.state === 'analyzing'" class="mt-5 rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h2 class="font-semibold text-slate-100">{{ stateLabel(check.state) }}…</h2>
          <div class="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
            <div class="h-full rounded-full bg-sky-500 transition-all" :style="{ width: `${Math.round(check.progress * 100)}%` }"></div>
          </div>
          <p class="mt-2 text-xs text-slate-400">
            <template v-if="remaining !== null">{{ t('check.recordingNote', { left: fmtTime(remaining) }) }}</template>
            <template v-else>{{ t('check.analyzingNote') }}</template>
          </p>
        </section>

        <section v-else-if="check.state === 'failed'" class="mt-5 rounded-xl border border-red-900/60 bg-red-950/30 p-4 text-sm">
          <h2 class="font-semibold text-red-300">{{ t('check.failed') }}</h2>
          <p class="mt-1 text-red-200/80">{{ check.error }}</p>
        </section>

        <template v-else>
          <p v-if="!check.hasClip" class="mt-4 text-sm text-slate-400">{{ t('check.clipDeleted') }}</p>

          <div class="mt-4 grid gap-4 lg:grid-cols-[1fr_20rem]">
            <div v-if="check.hasClip">
              <video
                ref="video"
                :src="accuracyClipUrl(check.id)"
                controls
                muted
                playsinline
                preload="auto"
                class="max-h-[70vh] w-full rounded-lg bg-black"
                @loadedmetadata="onLoadedMetadata"
                @error="videoFailed = true"
                @timeupdate="currentTime = ($event.target as HTMLVideoElement).currentTime"
              ></video>

              <p v-if="videoFailed" class="mt-2 text-xs text-red-400">{{ t('check.videoFailed') }}</p>

              <!-- Timeline: the app's vehicles above, yours below; click to jump there. -->
              <div class="relative mt-2 h-10 cursor-pointer rounded bg-slate-900" :title="t('check.timelineTitle')" @click="onTimelineClick">
                <div class="absolute inset-y-0 left-0 bg-slate-800/80" :style="{ width: timelineX(check.countFrom) }"></div>
                <div class="absolute inset-y-0 right-0 bg-slate-800/80" :style="{ left: timelineX(check.countTo) }"></div>
                <span v-for="(p, i) in check.passages" :key="`a${i}`" class="absolute top-1 h-3 w-0.5 bg-sky-400" :style="{ left: timelineX(p.t) }"></span>
                <span v-for="(c, i) in clicks" :key="`m${i}`" class="absolute bottom-1 h-3 w-0.5 bg-amber-300" :style="{ left: timelineX(c.t) }"></span>
                <span class="absolute inset-y-0 w-0.5 bg-white/80" :style="{ left: timelineX(currentTime) }"></span>
              </div>
              <div class="mt-1 flex justify-between text-[11px] text-slate-500">
                <span><span class="text-sky-400">▮</span> {{ t('check.app') }} · <span class="text-amber-300">▮</span> {{ t('check.you') }}</span>
                <span>{{ fmtTime(currentTime) }} / {{ fmtTime(timelineEnd) }}</span>
              </div>
            </div>

            <div class="space-y-4">
              <!-- Counting -->
              <section v-if="counting && check.hasClip" class="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <h2 class="font-semibold text-slate-100">{{ t('check.countTitle') }}</h2>
                <p class="mt-1 text-xs text-slate-400">{{ t('check.countNote', { from: fmtTime(check.countFrom), to: fmtTime(check.countTo) }) }}</p>
                <p v-if="!inWindow" class="mt-2 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
                  {{ currentTime < check.countFrom ? t('check.beforeWindow', { from: fmtTime(check.countFrom) }) : t('check.afterWindow') }}
                </p>
                <div class="mt-3 grid grid-cols-2 gap-2">
                  <button type="button" class="rounded-lg bg-sky-600 px-3 py-4 text-left font-medium text-white hover:bg-sky-500 active:scale-[0.98]" @click="count('A')">
                    <span class="block text-xs font-normal text-sky-100">A · {{ t('check.key', { key: 'A' }) }}</span>{{ labels.a }}
                  </button>
                  <button type="button" class="rounded-lg bg-violet-600 px-3 py-4 text-left font-medium text-white hover:bg-violet-500 active:scale-[0.98]" @click="count('B')">
                    <span class="block text-xs font-normal text-violet-100">B · {{ t('check.key', { key: 'B' }) }}</span>{{ labels.b }}
                  </button>
                </div>
                <div class="mt-2 flex gap-2 text-xs">
                  <button type="button" class="flex-1 rounded-md bg-slate-800 px-2 py-1.5 text-slate-200 hover:bg-slate-700" @click="count(null)">{{ t('check.unknownDirection') }}</button>
                  <button type="button" class="flex-1 rounded-md bg-slate-800 px-2 py-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-50" :disabled="!clicks.length" @click="undo">{{ t('check.undo') }}</button>
                </div>
                <p class="mt-3 text-sm text-slate-300">
                  {{ t('check.counted', { total: mine?.total ?? 0, a: mine?.a ?? 0, b: mine?.b ?? 0 }) }}
                </p>
                <p class="mt-1 text-[11px] text-slate-500">{{ t('check.keysNote') }}</p>
                <button type="button" class="mt-3 w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-60" :disabled="saving" @click="finish">
                  {{ t('check.finish') }}
                </button>
              </section>

              <!-- Results -->
              <section v-else-if="check.manual" class="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <h2 class="font-semibold text-slate-100">{{ t('check.resultTitle') }}</h2>
                <table class="mt-3 w-full text-sm">
                  <thead class="text-xs text-slate-500">
                    <tr>
                      <th class="py-1 text-left font-normal"></th>
                      <th class="py-1 text-right font-normal">{{ t('check.you') }}</th>
                      <th class="py-1 text-right font-normal">{{ t('check.app') }}</th>
                      <th class="py-1 text-right font-normal">{{ t('check.difference') }}</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-800">
                    <tr v-for="row in resultRows" :key="row.label">
                      <td class="py-1.5 pr-2 text-slate-300">{{ row.label }}</td>
                      <td class="py-1.5 text-right tabular-nums text-slate-100">{{ row.mine }}</td>
                      <td class="py-1.5 text-right tabular-nums text-slate-100">{{ row.app }}</td>
                      <td class="py-1.5 text-right tabular-nums" :class="errorClass(row.error)">{{ formatError(row.error) }}</td>
                    </tr>
                  </tbody>
                </table>
                <p class="mt-2 text-[11px] text-slate-500">{{ t('check.resultNote') }}</p>
                <button v-if="check.hasClip" type="button" class="mt-3 text-xs text-sky-400 hover:text-sky-300" @click="restartCount">{{ t('check.recount') }}</button>
              </section>
            </div>
          </div>

          <!-- Per minute -->
          <section v-if="check.manual && !counting" class="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-4">
            <h2 class="font-semibold text-slate-100">{{ t('check.perMinute') }}</h2>
            <p class="mt-1 text-xs text-slate-400">{{ t('check.perMinuteNote') }}</p>
            <table class="mt-3 w-full max-w-lg text-sm">
              <thead class="text-xs text-slate-500">
                <tr>
                  <th class="py-1 text-left font-normal">{{ t('check.col.clip') }}</th>
                  <th class="py-1 text-right font-normal">{{ t('check.you') }}</th>
                  <th class="py-1 text-right font-normal">{{ t('check.app') }}</th>
                  <th class="py-1 text-right font-normal">{{ t('check.difference') }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-800">
                <tr v-for="row in minuteRows" :key="row.from" class="cursor-pointer hover:bg-slate-800/50" @click="seek(row.from)">
                  <td class="py-1 text-slate-400">{{ fmtTime(row.from) }}–{{ fmtTime(row.to) }}</td>
                  <td class="py-1 text-right tabular-nums text-slate-200">{{ row.mine }}</td>
                  <td class="py-1 text-right tabular-nums text-slate-200">{{ row.app }}</td>
                  <td class="py-1 text-right tabular-nums" :class="row.app === row.mine ? 'text-slate-500' : 'text-amber-300'">{{ row.app - row.mine > 0 ? '+' : '' }}{{ row.app - row.mine }}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </template>
      </template>
    </template>
  </main>
</template>
