<script setup lang="ts">
import { computed } from 'vue';
import type { CameraEntry } from '../../types/camera';

const props = defineProps<{ camera: CameraEntry }>();

const isActive = computed(() => props.camera.status === 'active');

const locationLabel = computed(() => {
  const { location } = props.camera;
  if (location.address) return location.address;
  if (location.lat != null && location.lon != null) return `${location.lat}, ${location.lon}`;
  return 'Unknown location';
});

const lastVerifiedLabel = computed(() => {
  if (!props.camera.lastVerifiedAt) return 'never';
  return new Date(props.camera.lastVerifiedAt).toLocaleString();
});
</script>

<template>
  <router-link
    :to="`/cameras/${camera.id}`"
    class="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md hover:border-slate-300"
    :class="{ 'opacity-60': !isActive }"
  >
    <div class="flex items-start justify-between gap-2">
      <h3 class="font-semibold text-slate-900">{{ camera.name }}</h3>
      <span
        class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
        :class="isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'"
      >
        {{ camera.status }}
      </span>
    </div>
    <p class="mt-1 truncate text-sm text-slate-500">{{ locationLabel }}</p>
    <dl class="mt-3 grid grid-cols-2 gap-y-1 text-xs">
      <dt class="font-medium text-slate-400">Source</dt>
      <dd class="truncate text-right text-slate-600">{{ camera.source }}</dd>
      <dt class="font-medium text-slate-400">Protocol</dt>
      <dd class="text-right text-slate-600">{{ camera.protocol }}</dd>
      <dt class="font-medium text-slate-400">Resolution</dt>
      <dd class="text-right text-slate-600">{{ camera.resolution ?? 'unknown' }}</dd>
      <dt class="font-medium text-slate-400">Last verified</dt>
      <dd class="text-right text-slate-600">{{ lastVerifiedLabel }}</dd>
    </dl>
  </router-link>
</template>
