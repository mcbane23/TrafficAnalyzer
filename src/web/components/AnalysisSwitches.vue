<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AnalysisSettings, AnalysisSettingsResponse } from '../../types/admin';
import { fetchAnalysisSettings, saveAnalysisSettings } from '../services/admin';
import { withKnob, type Knob } from '../services/analysisKnobs';
import { t, tDynamic } from '../i18n';

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
/** Days to keep individual passages; 0 is "forever". */
const RETENTION_OPTIONS = [7, 30, 90, 365, 0];
const modelNote = (model: string) => tDynamic(`settings.model.${model}`, '');
const retentionLabel = (days: number) => (days === 0 ? t('settings.retentionForever') : t('settings.retentionDays', { days }));

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
    error.value = err instanceof Error ? err.message : t('settings.loadFailed');
  }
}

/** Saves the whole settings object - a field left out goes back to its default. */
async function save(next: AnalysisSettings) {
  if (saving.value || !state.value) return;
  saving.value = true;
  try {
    state.value = await saveAnalysisSettings(next);
    error.value = null;
    emit('changed');
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('settings.saveFailed');
  } finally {
    saving.value = false;
  }
}

function setCamera(cameraId: string, enabled: boolean) {
  if (!state.value) return;
  const ids = new Set(state.value.settings.enabledCameras);
  if (enabled) ids.add(cameraId);
  else ids.delete(cameraId);
  save({ ...state.value.settings, enabledCameras: Array.from(ids) });
}

/** Every active camera on or off; switched-on ids of cameras now offline are kept, so they resume if they come back. */
function setEveryCamera(enabled: boolean) {
  if (!state.value) return;
  const active = new Set(activeCameras.value.map((camera) => camera.id));
  const offline = state.value.settings.enabledCameras.filter((id) => !active.has(id));
  save({ ...state.value.settings, enabledCameras: enabled ? [...offline, ...active] : offline });
}

/** A knob's select: '' means "the default", which is saved by leaving the field out. */
function setKnob(key: Knob, raw: string) {
  if (!state.value) return;
  save(withKnob(state.value.settings, key, raw));
}

const knobValue = (key: Knob) => {
  const value = state.value?.settings[key];
  return value === undefined ? '' : String(value);
};

onMounted(load);
</script>

<template>
  <section class="rounded-xl border border-slate-800 bg-slate-900 p-4">
    <h2 class="font-semibold text-slate-100">{{ t('settings.title') }}</h2>
    <p class="mt-1 max-w-3xl text-xs text-slate-400">{{ t('settings.note') }}</p>

    <p v-if="error" class="mt-3 text-xs text-red-400">{{ error }}</p>
    <p v-if="!state && !error" class="mt-3 text-sm text-slate-500">{{ t('settings.loading') }}</p>

    <template v-if="state">
      <!-- Processing knobs -->
      <div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label class="block text-sm">
          <span class="text-xs text-slate-500">{{ t('settings.analysisFps') }}</span>
          <select
            class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100 disabled:opacity-60"
            :value="knobValue('analysisFps')"
            :disabled="saving"
            @change="setKnob('analysisFps', ($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('settings.default', { value: `${state.defaults.analysisFps} fps` }) }}</option>
            <option v-for="fps in FPS_OPTIONS" :key="fps" :value="String(fps)">{{ fps }} fps</option>
          </select>
          <span class="mt-1 block text-[11px] text-slate-500">{{ t('settings.analysisFpsNote') }}</span>
        </label>

        <template v-if="state.overlay.enabled">
          <label class="block text-sm">
            <span class="text-xs text-slate-500">{{ t('settings.overlayFps') }}</span>
            <select
              class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100 disabled:opacity-60"
              :value="knobValue('overlayFps')"
              :disabled="saving"
              @change="setKnob('overlayFps', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ t('settings.default', { value: `${state.defaults.overlayFps} fps` }) }}</option>
              <option v-for="fps in FPS_OPTIONS" :key="fps" :value="String(fps)">{{ fps }} fps</option>
            </select>
            <span class="mt-1 block text-[11px] text-slate-500">{{ t('settings.overlayFpsNote') }}</span>
          </label>

          <label class="block text-sm">
            <span class="text-xs text-slate-500">{{ t('settings.model') }}</span>
            <select
              class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100 disabled:opacity-60"
              :value="knobValue('overlayModel')"
              :disabled="saving || state.overlay.device === 'CPU'"
              @change="setKnob('overlayModel', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ t('settings.default', { value: state.defaults.overlayModel }) }}</option>
              <option v-for="model in state.overlay.models" :key="model" :value="model">
                {{ model }}{{ modelNote(model) ? ` - ${modelNote(model)}` : '' }}
              </option>
            </select>
            <span class="mt-1 block text-[11px] text-slate-500">
              <template v-if="state.overlay.device === 'CPU'">{{ t('settings.modelCpu') }}</template>
              <template v-else>{{ t('settings.modelGpu', { device: state.overlay.device }) }}</template>
            </span>
          </label>

          <label class="block text-sm">
            <span class="text-xs text-slate-500">{{ t('settings.confidence') }}</span>
            <select
              class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100 disabled:opacity-60"
              :value="knobValue('overlayConfidence')"
              :disabled="saving"
              @change="setKnob('overlayConfidence', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ t('settings.default', { value: state.defaults.overlayConfidence }) }}</option>
              <option v-for="value in CONFIDENCE_OPTIONS" :key="value" :value="String(value)">{{ value }}</option>
            </select>
            <span class="mt-1 block text-[11px] text-slate-500">{{ t('settings.confidenceNote') }}</span>
          </label>
        </template>
        <p v-else class="text-xs text-slate-500 sm:col-span-3">{{ t('settings.overlayOff') }}</p>

        <label class="block text-sm">
          <span class="text-xs text-slate-500">{{ t('settings.retention') }}</span>
          <select
            id="passage-retention"
            class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-slate-100 disabled:opacity-60"
            :value="knobValue('passageRetentionDays')"
            :disabled="saving"
            @change="setKnob('passageRetentionDays', ($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('settings.default', { value: retentionLabel(state.defaults.passageRetentionDays) }) }}</option>
            <option v-for="days in RETENTION_OPTIONS" :key="days" :value="String(days)">{{ retentionLabel(days) }}</option>
          </select>
          <span class="mt-1 block text-[11px] text-slate-500">{{ t('settings.retentionNote') }}</span>
        </label>
      </div>

      <!-- Cameras -->
      <div class="mt-6 flex flex-wrap items-baseline justify-between gap-2 border-t border-slate-800 pt-4">
        <h3 class="text-sm font-semibold text-slate-100">{{ t('settings.cameras') }}</h3>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
          <span>{{ t('settings.camerasCount', { on: analyzedCount, active: activeCameras.length, mb: analyzedCount * MB_PER_CAMERA }) }}</span>
          <button type="button" class="text-sky-400 hover:text-sky-300 disabled:opacity-60" :disabled="saving" @click="setEveryCamera(true)">{{ t('settings.allOn') }}</button>
          <button type="button" class="text-sky-400 hover:text-sky-300 disabled:opacity-60" :disabled="saving" @click="setEveryCamera(false)">{{ t('settings.allOff') }}</button>
        </div>
      </div>
      <p class="mt-1 max-w-3xl text-xs text-slate-400">
        {{ t('settings.camerasNote', { mb: MB_PER_CAMERA }) }}
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
        {{ t('settings.offlineHidden', { count: inactiveCount }) }}
      </p>
    </template>
  </section>
</template>
