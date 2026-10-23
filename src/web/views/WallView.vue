<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { CameraEntry } from '../../types/camera';
import StreamPlayer from '../components/StreamPlayer.vue';
import AppIcon from '../components/AppIcon.vue';
import { fetchCameras } from '../services/api';
import { WALL_SLOTS, wallCameras } from '../services/wallLayout';
import { favoriteIds } from '../composables/favorites';
import { t } from '../i18n';

// The wall shows video only: no boxes, so the server runs no YOLO for it.
const STORAGE_KEY = 'wall-cameras';

const cameras = ref<CameraEntry[]>([]);
const slots = ref<Array<string | null>>(Array(WALL_SLOTS).fill(null));
const error = ref<string | null>(null);
const wall = ref<HTMLElement | null>(null);
const fullscreen = ref(false);

const byId = computed(() => new Map(cameras.value.map((c) => [c.id, c])));
const choices = computed(() => cameras.value.filter((c) => c.status === 'active'));

function readSaved(): Array<string | null> | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return Array.isArray(saved) ? saved.map((id) => (typeof id === 'string' ? id : null)) : null;
  } catch {
    return null;
  }
}

function choose(index: number, id: string) {
  const next = [...slots.value];
  next[index] = id || null;
  slots.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable - the choice lasts until the page is left.
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
  else wall.value?.requestFullscreen().catch(() => undefined);
}
const onFullscreenChange = () => (fullscreen.value = document.fullscreenElement === wall.value);

onMounted(async () => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
  try {
    cameras.value = await fetchCameras();
    slots.value = wallCameras(readSaved(), cameras.value, favoriteIds.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
});
onBeforeUnmount(() => document.removeEventListener('fullscreenchange', onFullscreenChange));
</script>

<template>
  <main class="mx-auto max-w-7xl px-4 py-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-slate-100">{{ t('wall.title') }}</h1>
        <p class="mt-1 text-sm text-slate-400">{{ t('wall.subtitle') }}</p>
      </div>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-500 hover:text-slate-100"
        @click="toggleFullscreen"
      >
        <AppIcon name="fullscreen" :size="15" />{{ t('cam.fullscreen') }}
      </button>
    </div>
    <p v-if="error" class="mt-4 text-sm text-red-300">{{ error }}</p>

    <section
      ref="wall"
      class="mt-4 grid grid-cols-1 gap-2 bg-slate-950 sm:grid-cols-2"
      :class="fullscreen ? 'h-screen content-center gap-1 p-1' : ''"
      :aria-label="t('wall.title')"
    >
      <div v-for="(id, index) in slots" :key="index" class="group relative overflow-hidden rounded-lg bg-black">
        <StreamPlayer v-if="id && byId.get(id)" :key="id" :camera="byId.get(id)!" :overlay="false" :show-boxes="false" />
        <div v-else class="flex aspect-video items-center justify-center text-sm text-slate-500">{{ t('wall.empty') }}</div>
        <div class="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent p-2">
          <span v-if="id && byId.get(id)" class="truncate text-sm font-medium text-white">{{ byId.get(id)!.name }}</span>
          <select
            class="ml-auto max-w-[55%] rounded bg-slate-900/90 px-1.5 py-0.5 text-xs text-slate-200 opacity-100 focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
            :value="id ?? ''"
            :aria-label="t('wall.pick', { n: index + 1 })"
            @change="choose(index, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('wall.none') }}</option>
            <option v-for="camera in choices" :key="camera.id" :value="camera.id">{{ camera.name }}</option>
          </select>
        </div>
      </div>
    </section>
  </main>
</template>
