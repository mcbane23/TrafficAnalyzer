<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { CameraEntry } from '../../types/camera';
import { fetchCameraById } from '../services/api';
import StreamPlayer from '../components/StreamPlayer.vue';
import AnalysisPanel from '../components/AnalysisPanel.vue';

const route = useRoute();
const camera = ref<CameraEntry | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

async function load(id: string) {
  loading.value = true;
  error.value = null;
  try {
    camera.value = await fetchCameraById(id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load camera.';
  } finally {
    loading.value = false;
  }
}

onMounted(() => load(route.params.id as string));
watch(
  () => route.params.id,
  (id) => load(id as string),
);
</script>

<template>
  <main class="mx-auto max-w-6xl px-4 py-8">
    <router-link to="/" class="text-sm font-medium text-slate-400 hover:text-slate-200">&larr; Back to dashboard</router-link>

    <p v-if="loading" class="mt-8 text-sm text-slate-400">Loading camera…</p>
    <p v-else-if="error" class="mt-8 text-sm text-red-400">{{ error }}</p>
    <template v-else-if="camera">
      <h1 class="mt-2 text-2xl font-bold text-slate-100">{{ camera.name }}</h1>
      <p class="mt-1 text-sm text-slate-400">{{ camera.location.address ?? `${camera.location.lat}, ${camera.location.lon}` }}</p>

      <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div class="lg:col-span-2">
          <StreamPlayer :camera="camera" />
        </div>
        <AnalysisPanel :camera="camera" />
      </div>
    </template>
  </main>
</template>
