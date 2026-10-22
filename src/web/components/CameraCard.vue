<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
// Type only: hls.js (~540 KB) is loaded on the first hover preview, not with the dashboard.
import type Hls from 'hls.js';
import type { CameraEntry } from '../../types/camera';
import type { CameraAnalysisOverview } from '../../types/analysis';
import type { CameraSummary, StatsRange } from '../../types/stats';
import { cameraSnapshotUrl } from '../services/stats';
import { RANGES, TRAFFIC_BAR_STYLES, TRAFFIC_LABELS, formatAge, formatCount } from '../composables/trafficUi';
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
  /** When the thumbnail was captured (ISO), if known. */
  snapshotAt?: string;
  /** The dashboard's clock (ms), ticking so the thumbnail's age stays current. */
  now: number;
}>();

const isActive = computed(() => props.camera.status === 'active');
const hasTrafficData = computed(() => Boolean(props.overview) && !props.overview?.error);
const feedError = computed(() => (isActive.value ? props.overview?.error : undefined));
const analysisOff = computed(() => isActive.value && !props.analyzed);
/** A camera switched off has counted nothing, so its zero would read as an empty road. */
const passedLabel = computed(() => (props.summary && !(analysisOff.value && props.summary.total === 0) ? formatCount(props.summary.total) : '–'));
/**
 * The camera's state as one chip, always in the same place: off the network,
 * feed failing, analysis off, waiting for its first result, or live with its
 * traffic level (also the color of the stripe along the card's edge).
 */
const status = computed(() => {
  if (!isActive.value) return { label: t('card.offline'), chip: 'bg-slate-800/90 text-slate-300', dot: 'bg-slate-500', title: '' };
  if (feedError.value) return { label: t('card.feedError'), chip: 'bg-red-950/85 text-red-200', dot: 'bg-red-400', title: feedError.value };
  if (hasTrafficData.value) {
    const level = props.overview!.trafficLevel;
    return { label: t('card.live', { level: TRAFFIC_LABELS[level] }), chip: 'bg-slate-900/80 text-slate-100', dot: TRAFFIC_BAR_STYLES[level], title: '' };
  }
  if (analysisOff.value) return { label: t('card.analysisOff'), chip: 'bg-slate-900/80 text-slate-300', dot: 'bg-slate-500', title: t('card.analysisOffTitle') };
  return { label: t('card.waiting'), chip: 'bg-slate-900/80 text-slate-300', dot: 'bg-sky-400', title: '' };
});
const stripe = computed(() => (hasTrafficData.value ? TRAFFIC_BAR_STYLES[props.overview!.trafficLevel] : 'bg-transparent'));
const snapshotAge = computed(() => (props.snapshotAt && !snapshotFailed.value ? formatAge(props.now - Date.parse(props.snapshotAt)) : null));

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
    class="group relative block overflow-hidden rounded-xl border border-slate-800 bg-slate-900 transition hover:border-slate-600"
    :class="{ 'opacity-60': !isActive }"
    @mouseenter="startPreview"
    @mouseleave="stopPreview"
  >
    <span class="absolute inset-y-0 left-0 z-10 w-1" :class="stripe" aria-hidden="true"></span>
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
      <span class="absolute left-2 top-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium backdrop-blur" :class="status.chip" :title="status.title">
        <span class="h-1.5 w-1.5 rounded-full" :class="status.dot"></span>
        {{ status.label }}
      </span>
      <span v-if="snapshotAge && !previewing" class="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-300" :title="t('card.snapshotAgeTitle')">
        {{ snapshotAge }}
      </span>
      <span v-if="canPreview && !previewing" class="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-slate-300 opacity-0 transition group-hover:opacity-100">
        {{ t('card.livePreview') }}
      </span>
    </div>

    <div class="p-4">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h3 class="line-clamp-2 font-semibold leading-snug text-slate-100" :title="camera.name">{{ camera.name }}</h3>
          <p class="mt-0.5 truncate text-xs text-slate-400">{{ locationLabel }}</p>
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

  <!-- List layout: one compact row with a small thumbnail. -->
  <router-link
    v-else
    :to="{ path: `/cameras/${camera.id}`, query: { range } }"
    class="relative grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-3 overflow-hidden rounded-lg border border-slate-800 bg-slate-900 py-2 pl-3 pr-4 transition hover:border-slate-600 sm:grid-cols-[6rem_minmax(0,2fr)_10rem_minmax(0,1fr)_5rem] sm:gap-4"
    :class="{ 'opacity-60': !isActive }"
  >
    <span class="absolute inset-y-0 left-0 w-1" :class="stripe" aria-hidden="true"></span>
    <div class="relative aspect-video overflow-hidden rounded bg-slate-950">
      <img
        v-if="isActive && !snapshotFailed"
        :src="snapshotSrc"
        alt=""
        class="absolute inset-0 h-full w-full object-cover"
        loading="lazy"
        @error="snapshotFailed = true"
      />
      <span v-if="snapshotAge" class="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[9px] tabular-nums text-slate-300">{{ snapshotAge }}</span>
    </div>
    <div class="min-w-0">
      <p class="line-clamp-2 font-medium leading-snug text-slate-100" :title="camera.name">{{ camera.name }}</p>
      <p class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-slate-400 sm:hidden" :title="status.title">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="status.dot"></span>
        <span class="truncate">{{ status.label }}</span>
      </p>
      <p class="hidden truncate text-xs text-slate-400 sm:block">{{ locationLabel }}</p>
    </div>
    <div class="hidden sm:block">
      <span class="inline-flex items-center gap-1.5 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300" :title="status.title">
        <span class="h-1.5 w-1.5 rounded-full" :class="status.dot"></span>
        {{ status.label }}
      </span>
    </div>
    <div class="hidden sm:block">
      <Sparkline v-if="summary && !analysisOff" :values="summary.sparkline" :height="22" />
    </div>
    <p class="text-right font-semibold tabular-nums" :class="passedLabel === '–' ? 'text-slate-500' : 'text-slate-100'">{{ passedLabel }}</p>
  </router-link>
</template>
