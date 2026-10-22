<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AnalysisSettingsResponse } from '../../types/admin';
import { fetchAnalysisSettings, saveAnalysisSettings } from '../services/admin';

/**
 * The Admin page's analysis switches: the fleet analysis as a whole, and
 * each camera on its own. Every analyzed camera keeps an ffmpeg running, so
 * these are what to turn down on a smaller server. A switch applies as soon
 * as it is flipped - the server stops or starts that camera's capture
 * before it answers, no restart needed.
 */
const emit = defineEmits<{ changed: [] }>();

/** Measured per analyzed camera with the image's ffmpeg (see AGENTS.md). */
const MB_PER_CAMERA = 17;

const settings = ref<AnalysisSettingsResponse | null>(null);
const saving = ref(false);
const error = ref<string | null>(null);

const activeCameras = computed(() => settings.value?.cameras.filter((camera) => camera.active) ?? []);
const inactiveCameras = computed(() => settings.value?.cameras.filter((camera) => !camera.active) ?? []);
const analyzedCount = computed(() => (settings.value?.enabled ? activeCameras.value.filter((camera) => camera.enabled).length : 0));

async function load() {
  try {
    settings.value = await fetchAnalysisSettings();
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load analysis settings.';
  }
}

async function save(next: { enabled: boolean; disabledCameras: string[] }) {
  if (saving.value) return;
  saving.value = true;
  try {
    settings.value = await saveAnalysisSettings(next);
    error.value = null;
    emit('changed');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to save analysis settings.';
  } finally {
    saving.value = false;
  }
}

function setAll(enabled: boolean) {
  if (settings.value) save({ enabled, disabledCameras: settings.value.disabledCameras });
}

function setCamera(cameraId: string, enabled: boolean) {
  if (!settings.value) return;
  const disabled = new Set(settings.value.disabledCameras);
  if (enabled) disabled.delete(cameraId);
  else disabled.add(cameraId);
  save({ enabled: settings.value.enabled, disabledCameras: Array.from(disabled) });
}

/** Every active camera at once, keeping the global switch as it is. */
function setEveryCamera(enabled: boolean) {
  if (!settings.value) return;
  const others = settings.value.disabledCameras.filter((id) => !activeCameras.value.some((camera) => camera.id === id));
  save({ enabled: settings.value.enabled, disabledCameras: enabled ? others : [...others, ...activeCameras.value.map((camera) => camera.id)] });
}

onMounted(load);
</script>

<template>
  <section class="rounded-xl border border-slate-800 bg-slate-900 p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="font-semibold text-slate-100">Analyzed cameras</h2>
        <p class="mt-1 max-w-2xl text-xs text-slate-400">
          Each analyzed camera keeps an ffmpeg running (~{{ MB_PER_CAMERA }} MB of memory and part of a CPU core). A camera switched off
          gets no statistics, dashboard badge or thumbnail; its live view and boxes still work. Changes apply immediately.
        </p>
      </div>
      <label v-if="settings" class="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
        <input
          type="checkbox"
          role="switch"
          class="peer sr-only"
          :checked="settings.enabled"
          :disabled="saving"
          @change="setAll(($event.target as HTMLInputElement).checked)"
        />
        <span
          class="relative h-5 w-9 rounded-full bg-slate-700 transition after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:bg-emerald-500 peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-sky-400 peer-disabled:opacity-60"
        ></span>
        Traffic analysis {{ settings.enabled ? 'on' : 'off' }}
      </label>
    </div>

    <p v-if="error" class="mt-3 text-xs text-red-400">{{ error }}</p>
    <p v-if="!settings && !error" class="mt-3 text-sm text-slate-500">Loading…</p>

    <template v-if="settings">
      <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
        <span>
          {{ analyzedCount }} of {{ activeCameras.length }} active cameras analyzed · ~{{ analyzedCount * MB_PER_CAMERA }} MB for ffmpeg
        </span>
        <template v-if="settings.enabled">
          <button type="button" class="text-sky-400 hover:text-sky-300 disabled:opacity-60" :disabled="saving" @click="setEveryCamera(true)">All on</button>
          <button type="button" class="text-sky-400 hover:text-sky-300 disabled:opacity-60" :disabled="saving" @click="setEveryCamera(false)">All off</button>
        </template>
      </div>

      <ul class="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3" :class="settings.enabled ? '' : 'opacity-50'">
        <li v-for="camera in activeCameras" :key="camera.id">
          <label class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-slate-800/60">
            <span class="truncate text-slate-200" :title="camera.name">{{ camera.name }}</span>
            <input
              type="checkbox"
              role="switch"
              class="peer sr-only"
              :checked="camera.enabled"
              :disabled="saving || !settings.enabled"
              @change="setCamera(camera.id, ($event.target as HTMLInputElement).checked)"
            />
            <span
              class="relative h-5 w-9 shrink-0 rounded-full bg-slate-700 transition after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:bg-emerald-500 peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-sky-400 peer-disabled:opacity-60"
            ></span>
          </label>
        </li>
      </ul>
      <p v-if="inactiveCameras.length > 0" class="mt-2 text-[11px] text-slate-500">
        Offline cameras are never analyzed, so {{ inactiveCameras.length }} {{ inactiveCameras.length === 1 ? 'is' : 'are' }} not listed.
      </p>
    </template>
  </section>
</template>
