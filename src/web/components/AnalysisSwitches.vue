<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AnalysisSettings, AnalysisSettingsResponse } from '../../types/admin';
import { fetchAnalysisSettings, saveAnalysisSettings } from '../services/admin';

/**
 * The Admin page's analysis settings: which cameras the fleet analysis runs
 * on (none until switched on - every analyzed camera keeps an ffmpeg
 * running), and the processing knobs. Everything applies as soon as it is
 * changed - the server starts/stops captures, restarts them on a new frame
 * rate, or loads the new model before it answers; no restart needed.
 */
const emit = defineEmits<{ changed: [] }>();

/** Measured per analyzed camera with the image's ffmpeg (see AGENTS.md). */
const MB_PER_CAMERA = 17;
const FPS_OPTIONS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
const CONFIDENCE_OPTIONS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5];
const MODEL_NOTES: Record<string, string> = {
  yolo26n: 'fastest, misses more distant cars',
  yolo26s: 'balanced',
  yolo26m: 'most accurate, ~3x slower',
};

const state = ref<AnalysisSettingsResponse | null>(null);
const saving = ref(false);
const error = ref<string | null>(null);

const activeCameras = computed(() => state.value?.cameras.filter((camera) => camera.active) ?? []);
const inactiveCount = computed(() => (state.value?.cameras.length ?? 0) - activeCameras.value.length);
const analyzedCount = computed(() => activeCameras.value.filter((camera) => camera.enabled).length);

async function load() {
  try {
    state.value = await fetchAnalysisSettings();
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load analysis settings.';
  }
}

async function save(change: Partial<AnalysisSettings>) {
  if (saving.value || !state.value) return;
  saving.value = true;
  try {
    state.value = await saveAnalysisSettings({ ...state.value.settings, ...change });
    error.value = null;
    emit('changed');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to save analysis settings.';
  } finally {
    saving.value = false;
  }
}

function setCamera(cameraId: string, enabled: boolean) {
  if (!state.value) return;
  const ids = new Set(state.value.settings.enabledCameras);
  if (enabled) ids.add(cameraId);
  else ids.delete(cameraId);
  save({ enabledCameras: Array.from(ids) });
}

/** Every active camera on or off; switched-on ids of cameras now offline are kept, so they resume if they come back. */
function setEveryCamera(enabled: boolean) {
  if (!state.value) return;
  const active = new Set(activeCameras.value.map((camera) => camera.id));
  const offline = state.value.settings.enabledCameras.filter((id) => !active.has(id));
  save({ enabledCameras: enabled ? [...offline, ...active] : offline });
}

/** A knob's select: '' means "the default", which is saved by leaving the field out. */
function setKnob(key: 'analysisFps' | 'overlayFps' | 'overlayConfidence' | 'overlayModel', raw: string) {
  if (!state.value) return;
  const settings: AnalysisSettings = { ...state.value.settings };
  if (raw === '') delete settings[key];
  else if (key === 'overlayModel') settings.overlayModel = raw;
  else settings[key] = Number(raw);
  save(settings);
}

const knobValue = (key: 'analysisFps' | 'overlayFps' | 'overlayConfidence' | 'overlayModel') => {
  const value = state.value?.settings[key];
  return value === undefined ? '' : String(value);
};

onMounted(load);
</script>

<template>
  <section class="rounded-xl border border-slate-800 bg-slate-900 p-4">
    <h2 class="font-semibold text-slate-100">Analysis settings</h2>
    <p class="mt-1 max-w-3xl text-xs text-slate-400">Changes apply immediately and are kept across restarts and updates.</p>

    <p v-if="error" class="mt-3 text-xs text-red-400">{{ error }}</p>
    <p v-if="!state && !error" class="mt-3 text-sm text-slate-500">Loading…</p>

    <template v-if="state">
      <!-- Processing knobs -->
      <div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label class="block text-sm">
          <span class="text-xs text-slate-500">Analysis frame rate</span>
          <select
            class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100 disabled:opacity-60"
            :value="knobValue('analysisFps')"
            :disabled="saving"
            @change="setKnob('analysisFps', ($event.target as HTMLSelectElement).value)"
          >
            <option value="">Default ({{ state.defaults.analysisFps }} fps)</option>
            <option v-for="fps in FPS_OPTIONS" :key="fps" :value="String(fps)">{{ fps }} fps</option>
          </select>
          <span class="mt-1 block text-[11px] text-slate-500">Per analyzed camera. Lower saves CPU; memory stays the same.</span>
        </label>

        <template v-if="state.overlay.enabled">
          <label class="block text-sm">
            <span class="text-xs text-slate-500">Live boxes frame rate</span>
            <select
              class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100 disabled:opacity-60"
              :value="knobValue('overlayFps')"
              :disabled="saving"
              @change="setKnob('overlayFps', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">Default ({{ state.defaults.overlayFps }} fps)</option>
              <option v-for="fps in FPS_OPTIONS" :key="fps" :value="String(fps)">{{ fps }} fps</option>
            </select>
            <span class="mt-1 block text-[11px] text-slate-500">YOLO on a watched camera. Higher is smoother, costs more.</span>
          </label>

          <label class="block text-sm">
            <span class="text-xs text-slate-500">YOLO model</span>
            <select
              class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100 disabled:opacity-60"
              :value="knobValue('overlayModel')"
              :disabled="saving || state.overlay.device === 'CPU'"
              @change="setKnob('overlayModel', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">Default ({{ state.defaults.overlayModel }})</option>
              <option v-for="model in state.overlay.models" :key="model" :value="model">
                {{ model }}{{ MODEL_NOTES[model] ? ` - ${MODEL_NOTES[model]}` : '' }}
              </option>
            </select>
            <span class="mt-1 block text-[11px] text-slate-500">
              <template v-if="state.overlay.device === 'CPU'">Only on a GPU (OVERLAY_DEVICE=GPU); the CPU runs yolo26n.</template>
              <template v-else>Runs on the {{ state.overlay.device }}. Switching loads the new model.</template>
            </span>
          </label>

          <label class="block text-sm">
            <span class="text-xs text-slate-500">Box confidence threshold</span>
            <select
              class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100 disabled:opacity-60"
              :value="knobValue('overlayConfidence')"
              :disabled="saving"
              @change="setKnob('overlayConfidence', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">Default ({{ state.defaults.overlayConfidence }})</option>
              <option v-for="value in CONFIDENCE_OPTIONS" :key="value" :value="String(value)">{{ value }}</option>
            </select>
            <span class="mt-1 block text-[11px] text-slate-500">Lower draws more boxes, with a few more false ones.</span>
          </label>
        </template>
        <p v-else class="text-xs text-slate-500 sm:col-span-3">Live YOLO boxes are switched off (OVERLAY_DETECTOR=off).</p>
      </div>

      <!-- Cameras -->
      <div class="mt-6 flex flex-wrap items-baseline justify-between gap-2 border-t border-slate-800 pt-4">
        <h3 class="text-sm font-semibold text-slate-100">Analyzed cameras</h3>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
          <span>{{ analyzedCount }} of {{ activeCameras.length }} active cameras · ~{{ analyzedCount * MB_PER_CAMERA }} MB for ffmpeg</span>
          <button type="button" class="text-sky-400 hover:text-sky-300 disabled:opacity-60" :disabled="saving" @click="setEveryCamera(true)">All on</button>
          <button type="button" class="text-sky-400 hover:text-sky-300 disabled:opacity-60" :disabled="saving" @click="setEveryCamera(false)">All off</button>
        </div>
      </div>
      <p class="mt-1 max-w-3xl text-xs text-slate-400">
        Statistics, dashboard badges and thumbnails come from cameras switched on here. Each one keeps an ffmpeg running (~{{ MB_PER_CAMERA }} MB of
        memory and part of a CPU core). A camera switched off is still analyzed while its page is open, and stops ~15 s after it is closed.
      </p>

      <ul class="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        <li v-for="camera in activeCameras" :key="camera.id">
          <label class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-slate-800/60">
            <span class="truncate text-slate-200" :title="camera.name">{{ camera.name }}</span>
            <input
              type="checkbox"
              role="switch"
              class="peer sr-only"
              :checked="camera.enabled"
              :disabled="saving"
              @change="setCamera(camera.id, ($event.target as HTMLInputElement).checked)"
            />
            <span
              class="relative h-5 w-9 shrink-0 rounded-full bg-slate-700 transition after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:bg-emerald-500 peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-sky-400 peer-disabled:opacity-60"
            ></span>
          </label>
        </li>
      </ul>
      <p v-if="inactiveCount > 0" class="mt-2 text-[11px] text-slate-500">
        Offline cameras are never analyzed, so {{ inactiveCount }} {{ inactiveCount === 1 ? 'is' : 'are' }} not listed.
      </p>
    </template>
  </section>
</template>
