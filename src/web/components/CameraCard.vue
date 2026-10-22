<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
// Type only: hls.js (~540 KB) is loaded on the first hover preview, not with the dashboard.
import type Hls from 'hls.js';
import type { CameraEntry } from '../../types/camera';
import type { CameraAnalysisOverview } from '../../types/analysis';
import type { CameraSummary, StatsRange } from '../../types/stats';
import { cameraSnapshotUrl } from '../services/stats';
import { RANGES, TRAFFIC_BADGE_STYLES, TRAFFIC_LABELS, formatCount } from '../composables/trafficUi';
import Sparkline from './charts/Sparkline.vue';
import { t } from '../i18n';

const props = defineProps<{
  camera: CameraEntry;
  /** Whether the Admin page switches this camera's analysis on; without it there are no counts or badge to show. */
  analyzed: boolean;
  overview?: CameraAnalysisOverview;
  summary?: CameraSummary;
  range: StatsRange;
  layout: 'grid' | 'list';
  /** Bumped by the dashboard to refresh every card's thumbnail together. */
  snapshotTick: number;
}>();

const isActive = computed(() => props.camera.status === 'active');
const hasTrafficData = computed(() => Boolean(props.overview) && !props.overview?.error);
const feedError = computed(() => (isActive.value ? props.overview?.error : undefined));
const analysisOff = computed(() => isActive.value && !props.analyzed);
/** A camera switched off has counted nothing, so its zero would read as an empty road. */
const passedLabel = computed(() => (props.summary && !(analysisOff.value && props.summary.total === 0) ? formatCount(props.summary.total) : '–'));
const rangeLabel = computed(() => RANGES.find((r) => r.value === props.range)?.label ?? props.range);

const locationLabel = computed(() => {
  const { location } = props.camera;
  if (location.address) return location.address;
  if (location.lat != null && location.lon != null) return `${location.lat}, ${location.lon}`;
  return t('card.unknownLocation');
});

const snapshotFailed = ref(false);
const snapshotSrc = computed(() => cameraSnapshotUrl(props.camera.id, props.snapshotTick));
watch(
  () => props.snapshotTick,
  () => (snapshotFailed.value = false),
);

// Live preview only while hovered: a still thumbnail per card replaces the
// old always-on video per card, which opened ~20 HLS streams at once
// against the same small upstream relays and made a chunk of them fail.
const previewVideo = ref<HTMLVideoElement | null>(null);
const previewing = ref(false);
let hls: Hls | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
const canPreview = computed(() => isActive.value && props.camera.protocol === 'HLS');

function startPreview() {
  if (!canPreview.value || previewing.value) return;
  // A short delay so sweeping the mouse across the grid doesn't open a stream per card passed over.
  hoverTimer = setTimeout(async () => {
    hoverTimer = null;
    previewing.value = true;
    const { default: Hls } = await import('hls.js');
    // The pointer may have left while the library loaded.
    if (!previewing.value) return;
    requestAnimationFrame(() => {
      const video = previewVideo.value;
      if (!video || !previewing.value) return;
      // hls.js first, native only without MSE (iOS Safari) - see StreamPlayer's loadSource.
      if (Hls.isSupported()) {
        hls = new Hls({ liveSyncDurationCount: 2 });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) stopPreview();
        });
        hls.loadSource(props.camera.url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => undefined));
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = props.camera.url;
        video.play().catch(() => undefined);
      }
    });
  }, 400);
}

function stopPreview() {
  if (hoverTimer !== null) clearTimeout(hoverTimer);
  hoverTimer = null;
  hls?.destroy();
  hls = null;
  if (previewVideo.value) {
    previewVideo.value.removeAttribute('src');
    previewVideo.value.load();
  }
  previewing.value = false;
}

onBeforeUnmount(stopPreview);
</script>

<template>
  <!-- Grid layout: thumbnail card. -->
  <router-link
    v-if="layout === 'grid'"
    :to="{ path: `/cameras/${camera.id}`, query: { range } }"
    class="group block overflow-hidden rounded-xl border border-slate-800 bg-slate-900 transition hover:border-slate-600"
    :class="{ 'opacity-60': !isActive }"
    @mouseenter="startPreview"
    @mouseleave="stopPreview"
  >
    <div class="relative aspect-video bg-slate-950">
      <video v-if="previewing" ref="previewVideo" class="absolute inset-0 h-full w-full object-cover" muted playsinline></video>
      <img
        v-else-if="isActive && !snapshotFailed"
        :src="snapshotSrc"
        :alt="t('card.latestFrame', { name: camera.name })"
        class="absolute inset-0 h-full w-full object-cover"
        loading="lazy"
        @error="snapshotFailed = true"
      />
      <div v-else class="flex h-full items-center justify-center text-xs text-slate-500">
        {{ isActive ? t('card.noFrame') : t('card.offline') }}
      </div>
      <span
        v-if="hasTrafficData"
        class="absolute left-2 top-2 rounded-full px-2 py-0.5 text-xs font-medium backdrop-blur"
        :class="TRAFFIC_BADGE_STYLES[overview!.trafficLevel]"
      >
        {{ TRAFFIC_LABELS[overview!.trafficLevel] }}
      </span>
      <span v-if="feedError" class="absolute left-2 top-2 rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-300 backdrop-blur" :title="feedError">
        {{ t('card.feedError') }}
      </span>
      <span
        v-else-if="analysisOff && !hasTrafficData"
        class="absolute left-2 top-2 rounded-full bg-slate-900/80 px-2 py-0.5 text-xs font-medium text-slate-300 backdrop-blur"
        :title="t('card.analysisOffTitle')"
      >
        {{ t('card.analysisOff') }}
      </span>
      <span v-if="canPreview && !previewing" class="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-slate-300 opacity-0 transition group-hover:opacity-100">
        {{ t('card.livePreview') }}
      </span>
    </div>

    <div class="p-4">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h3 class="truncate font-semibold text-slate-100">{{ camera.name }}</h3>
          <p class="truncate text-xs text-slate-400">{{ locationLabel }}</p>
        </div>
        <div class="shrink-0 text-right">
          <p class="text-lg font-semibold tabular-nums" :class="passedLabel === '–' ? 'text-slate-500' : 'text-slate-100'">{{ passedLabel }}</p>
          <p class="text-[11px] text-slate-500">{{ t('card.passed', { range: rangeLabel }) }}</p>
        </div>
      </div>
      <div class="mt-3">
        <Sparkline v-if="summary && !analysisOff" :values="summary.sparkline" />
        <div v-else class="h-7"></div>
        <div class="mt-1 flex justify-between text-[10px] text-slate-500">
          <span>{{ t('card.dayAgo') }}</span>
          <span v-if="hasTrafficData">{{ t('card.inView', { count: overview!.totalCount }) }}</span>
          <span>{{ t('card.now') }}</span>
        </div>
      </div>
    </div>
  </router-link>

  <!-- List layout: one compact row. -->
  <router-link
    v-else
    :to="{ path: `/cameras/${camera.id}`, query: { range } }"
    class="grid grid-cols-[1fr_auto] items-center gap-4 rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 transition hover:border-slate-600 sm:grid-cols-[minmax(0,2fr)_6rem_minmax(0,1fr)_5rem]"
    :class="{ 'opacity-60': !isActive }"
  >
    <div class="min-w-0">
      <p class="truncate font-medium text-slate-100">{{ camera.name }}</p>
      <p class="truncate text-xs text-slate-400">{{ locationLabel }}</p>
    </div>
    <div class="hidden sm:block">
      <span v-if="!isActive" class="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{{ t('dash.filter.offline') }}</span>
      <span v-else-if="feedError" class="rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-300" :title="feedError">{{ t('card.feedError') }}</span>
      <span v-else-if="analysisOff && !hasTrafficData" class="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400" :title="t('card.analysisOffTitle')">{{ t('card.analysisOff') }}</span>
      <span v-else-if="hasTrafficData" class="rounded-full px-2 py-0.5 text-xs font-medium" :class="TRAFFIC_BADGE_STYLES[overview!.trafficLevel]">
        {{ TRAFFIC_LABELS[overview!.trafficLevel] }}
      </span>
    </div>
    <div class="hidden sm:block">
      <Sparkline v-if="summary && !analysisOff" :values="summary.sparkline" :height="22" />
    </div>
    <p class="text-right font-semibold tabular-nums" :class="passedLabel === '–' ? 'text-slate-500' : 'text-slate-100'">{{ passedLabel }}</p>
  </router-link>
</template>
