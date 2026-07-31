<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Hls from 'hls.js';
import type { CameraEntry } from '../../types/camera';
import type { CameraAnalysisOverview, TrafficLevel } from '../../types/analysis';

const props = defineProps<{ camera: CameraEntry; overview?: CameraAnalysisOverview }>();

const TRAFFIC_BADGE_STYLES: Record<TrafficLevel, string> = {
  light: 'bg-emerald-100 text-emerald-700',
  moderate: 'bg-amber-100 text-amber-700',
  heavy: 'bg-red-100 text-red-700',
};

const TRAFFIC_LABELS: Record<TrafficLevel, string> = {
  light: 'Light',
  moderate: 'Moderate',
  heavy: 'Heavy',
};

const hasTrafficData = computed(() => Boolean(props.overview) && !props.overview?.error);

const isActive = computed(() => props.camera.status === 'active');
// Preview playback reuses the same HLS-only support StreamPlayer has;
// other protocols/inactive cameras fall back to a placeholder instead.
const canPreview = computed(() => isActive.value && props.camera.protocol === 'HLS');

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

const previewVideo = ref<HTMLVideoElement | null>(null);
const previewError = ref(false);
let hls: Hls | null = null;
let observer: IntersectionObserver | null = null;
let triedAlternate = false;

function loadPreview(url: string) {
  const video = previewVideo.value;
  if (!video) return;

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS support (Safari) - no hls.js needed.
    video.addEventListener('error', handlePreviewFailure);
    video.src = url;
    video.play().catch(() => undefined);
    return;
  }

  if (Hls.isSupported()) {
    hls = new Hls();
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) handlePreviewFailure();
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => undefined);
    });
    return;
  }

  previewError.value = true;
}

/**
 * If the primary preview fails and the camera has an `alternateUrl`,
 * retry once with the alternate before giving up and showing the
 * "Preview unavailable" placeholder.
 */
function handlePreviewFailure() {
  if (!triedAlternate && props.camera.alternateUrl) {
    triedAlternate = true;
    hls?.destroy();
    hls = null;
    previewVideo.value?.removeEventListener('error', handlePreviewFailure);
    loadPreview(props.camera.alternateUrl);
    return;
  }
  previewError.value = true;
}

function attachPreview() {
  if (!previewVideo.value || !canPreview.value) return;
  loadPreview(props.camera.url);
}

onMounted(() => {
  if (!canPreview.value || !previewVideo.value) return;

  // Only start streaming once the card actually scrolls into view, so a
  // dashboard listing many cameras doesn't open dozens of streams at once.
  observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      attachPreview();
      observer?.disconnect();
      observer = null;
    },
    { rootMargin: '200px' },
  );
  observer.observe(previewVideo.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  hls?.destroy();
  previewVideo.value?.removeEventListener('error', handlePreviewFailure);
});
</script>

<template>
  <router-link
    :to="`/cameras/${camera.id}`"
    class="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md hover:border-slate-300"
    :class="{ 'opacity-60': !isActive }"
  >
    <div class="-mx-4 -mt-4 mb-3 aspect-video overflow-hidden rounded-t-xl bg-slate-900">
      <video
        v-if="canPreview && !previewError"
        ref="previewVideo"
        class="h-full w-full object-cover"
        muted
        autoplay
        playsinline
      ></video>
      <div v-else class="flex h-full w-full items-center justify-center px-2 text-center text-xs text-slate-400">
        {{ isActive ? 'Preview unavailable' : 'Camera offline' }}
      </div>
    </div>

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

    <div v-if="isActive" class="mt-3 flex items-center justify-between gap-2">
      <span v-if="hasTrafficData" class="text-sm font-medium text-slate-700">
        {{ overview!.totalCount }} vehicle{{ overview!.totalCount === 1 ? '' : 's' }}
      </span>
      <span v-else class="text-xs text-slate-400">Analyzing…</span>
      <span
        v-if="hasTrafficData"
        class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
        :class="TRAFFIC_BADGE_STYLES[overview!.trafficLevel]"
      >
        {{ TRAFFIC_LABELS[overview!.trafficLevel] }}
      </span>
    </div>

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
