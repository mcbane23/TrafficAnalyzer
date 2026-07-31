<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Hls from 'hls.js';
import type { CameraEntry } from '../../types/camera';
import type { VehicleClass, VehicleDetection } from '../../types/analysis';
import { subscribeCameraAnalysis } from '../services/analysis';

const props = defineProps<{ camera: CameraEntry }>();

const videoRef = ref<HTMLVideoElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const error = ref<string | null>(null);
const usingAlternate = ref(false);
let hls: Hls | null = null;

// Bounding-box overlay: sourced from the per-camera analysis SSE stream
// (opening it is also what boosts that camera's sampling rate server-side).
// It's expected to lag the live video slightly (frame-grab + inference
// time) - an accepted tradeoff, not a bug.
const CLASS_COLORS: Record<VehicleClass, string> = {
  car: '#38bdf8',
  bus: '#f97316',
  truck: '#a855f7',
  tram: '#22c55e',
  motorcycle: '#eab308',
};
// Distinct colors cycled by tracked vehicle instance (trackId), so two
// same-class vehicles on screen at once are visually distinguishable and
// a single vehicle keeps the same color as it moves across frames.
const TRACK_COLOR_PALETTE = [
  '#38bdf8',
  '#f97316',
  '#a855f7',
  '#22c55e',
  '#eab308',
  '#ef4444',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#6366f1',
];

function colorForDetection(detection: VehicleDetection): string {
  if (detection.trackId != null) {
    return TRACK_COLOR_PALETTE[detection.trackId % TRACK_COLOR_PALETTE.length];
  }
  return CLASS_COLORS[detection.class];
}
let unsubscribeAnalysis: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let latestDetections: VehicleDetection[] = [];

function destroy() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  videoRef.value?.removeEventListener('error', handleNativeError);
}

/**
 * Loads a stream URL into the video element, preferring hls.js except on
 * browsers with native HLS support (Safari). Failures are reported via
 * `onFailure` rather than directly setting `error`, so the caller can
 * decide whether to fall back to `camera.alternateUrl` first.
 */
function loadSource(url: string, onFailure: (message: string) => void) {
  const video = videoRef.value;
  if (!video) return;

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS support (Safari) - no hls.js needed.
    video.addEventListener('error', handleNativeError);
    video.src = url;
    video.play().catch(() => undefined);
    return;
  }

  if (Hls.isSupported()) {
    hls = new Hls();
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        onFailure(`Stream error: ${data.details}`);
      }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => undefined);
    });
    return;
  }

  onFailure('HLS playback is not supported in this browser.');
}

function handleNativeError() {
  handleFailure('Stream error: failed to load video.');
}

/**
 * Called whenever the currently loaded stream fails. If the camera has a
 * configured `alternateUrl` and we haven't already switched to it, retry
 * once with the alternate before surfacing an error to the user.
 */
function handleFailure(message: string) {
  if (!usingAlternate.value && props.camera.alternateUrl) {
    usingAlternate.value = true;
    destroy();
    loadSource(props.camera.alternateUrl, (fallbackMessage) => {
      error.value = fallbackMessage;
    });
    return;
  }
  error.value = message;
}

function attach() {
  destroy();
  error.value = null;
  usingAlternate.value = false;

  if (props.camera.status !== 'active') {
    error.value = props.camera.lastError ?? 'This camera is currently marked inactive.';
    return;
  }

  if (props.camera.protocol !== 'HLS') {
    error.value = `Playback for protocol "${props.camera.protocol}" isn't supported yet.`;
    return;
  }

  loadSource(props.camera.url, handleFailure);
}

/**
 * Computes the actual on-screen rectangle occupied by the video's decoded
 * frame within its element's box. `<video>` preserves its intrinsic aspect
 * ratio by default (letterboxing/pillarboxing with black bars) rather than
 * stretching to fill the box, so when the box's aspect ratio (forced to
 * 16:9 by the `aspect-video` class) doesn't match the stream's actual
 * resolution, the rendered frame doesn't cover the full element - it's
 * centered within it. Detections are normalized fractions of the raw
 * frame, so they must be mapped onto this inner rectangle, not the full
 * canvas, or every box ends up offset from the visible video image.
 */
function getVideoContentRect(video: HTMLVideoElement, boxWidth: number, boxHeight: number) {
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  if (!videoWidth || !videoHeight || !boxWidth || !boxHeight) {
    return { x: 0, y: 0, width: boxWidth, height: boxHeight };
  }

  const videoAspect = videoWidth / videoHeight;
  const boxAspect = boxWidth / boxHeight;

  if (videoAspect > boxAspect) {
    // Video is relatively wider than its box - full width, letterboxed top/bottom.
    const width = boxWidth;
    const height = width / videoAspect;
    return { x: 0, y: (boxHeight - height) / 2, width, height };
  }

  // Video is relatively taller/narrower than its box - full height, pillarboxed left/right.
  const height = boxHeight;
  const width = height * videoAspect;
  return { x: (boxWidth - width) / 2, y: 0, width, height };
}

/** Redraws the bounding-box overlay to match the canvas' current pixel size and the latest known detections. */
function drawOverlay() {
  const canvas = canvasRef.value;
  const video = videoRef.value;
  if (!canvas || !video) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const content = getVideoContentRect(video, canvas.width, canvas.height);
  for (const detection of latestDetections) {
    const color = colorForDetection(detection);
    const boxX = content.x + detection.box.x * content.width;
    const boxY = content.y + detection.box.y * content.height;
    const boxW = detection.box.width * content.width;
    const boxH = detection.box.height * content.height;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    const label = detection.color ? `${detection.class} · ${detection.color}` : detection.class;
    ctx.font = '600 12px sans-serif';
    const labelWidth = ctx.measureText(label).width + 8;
    const labelY = Math.max(0, boxY - 16);
    ctx.fillStyle = color;
    ctx.fillRect(boxX, labelY, labelWidth, 16);
    ctx.fillStyle = '#0f172a';
    ctx.fillText(label, boxX + 4, labelY + 12);
  }
}

/** Keeps the overlay canvas' pixel size in sync with the video element's displayed (CSS) size. */
function resizeCanvas() {
  const canvas = canvasRef.value;
  const video = videoRef.value;
  if (!canvas || !video) return;
  canvas.width = video.clientWidth;
  canvas.height = video.clientHeight;
  drawOverlay();
}

/** Subscribes to the camera's analysis stream to keep the overlay's bounding boxes current. No-op for inactive cameras. */
function attachOverlay() {
  unsubscribeAnalysis?.();
  unsubscribeAnalysis = null;
  latestDetections = [];
  drawOverlay();

  if (props.camera.status !== 'active') return;

  unsubscribeAnalysis = subscribeCameraAnalysis(props.camera.id, (result) => {
    latestDetections = result.error ? [] : result.detections;
    drawOverlay();
  });
}

onMounted(() => {
  attach();
  attachOverlay();
  if (videoRef.value) {
    resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(videoRef.value);
    // The video's intrinsic resolution (used to compute the letterboxed
    // content rect) is only known once metadata loads - it doesn't
    // necessarily change the element's CSS box size, so ResizeObserver
    // alone won't always re-trigger a redraw when it becomes available.
    videoRef.value.addEventListener('loadedmetadata', drawOverlay);
  }
  resizeCanvas();
});
onBeforeUnmount(() => {
  destroy();
  unsubscribeAnalysis?.();
  resizeObserver?.disconnect();
  videoRef.value?.removeEventListener('loadedmetadata', drawOverlay);
});
watch(
  () => props.camera.id,
  () => {
    attach();
    attachOverlay();
  },
);
</script>

<template>
  <div class="overflow-hidden rounded-xl bg-black">
    <div class="relative">
      <video v-show="!error" ref="videoRef" class="aspect-video w-full" controls muted playsinline></video>
      <canvas v-show="!error" ref="canvasRef" class="pointer-events-none absolute inset-0 h-full w-full"></canvas>
    </div>
    <div
      v-if="usingAlternate && !error"
      class="bg-amber-500/90 px-3 py-1 text-center text-xs font-medium text-slate-900"
    >
      Primary feed unavailable - showing backup feed{{ camera.alternateSource ? ` (${camera.alternateSource})` : '' }}
    </div>
    <div v-if="error" class="flex aspect-video w-full items-center justify-center p-6 text-center text-sm text-slate-300">
      {{ error }}
    </div>
  </div>
</template>
