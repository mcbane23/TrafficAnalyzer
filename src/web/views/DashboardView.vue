<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { CameraEntry } from '../../types/camera';
import { fetchCameras } from '../services/api';
import CameraCard from '../components/CameraCard.vue';

const cameras = ref<CameraEntry[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    cameras.value = await fetchCameras();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load cameras.';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <main class="mx-auto max-w-6xl px-4 py-8">
    <h1 class="text-2xl font-bold text-slate-900">Belgrade Traffic Cameras</h1>
    <p class="mt-1 text-sm text-slate-500">{{ cameras.length }} camera(s) in the registry</p>

    <p v-if="loading" class="mt-8 text-sm text-slate-500">Loading cameras…</p>
    <p v-else-if="error" class="mt-8 text-sm text-red-600">{{ error }}</p>
    <div v-else class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <CameraCard v-for="camera in cameras" :key="camera.id" :camera="camera" />
    </div>
  </main>
</template>
