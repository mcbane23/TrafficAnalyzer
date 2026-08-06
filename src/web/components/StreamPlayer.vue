<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Hls from 'hls.js';
import type { CameraEntry } from '../../types/camera';
import type { BoundingBox, VehicleDetection } from '../../types/analysis';
import { subscribeCameraAnalysis } from '../services/analysis';

const props = defineProps<{ camera: CameraEntry }>();

const videoRef = ref<HTMLVideoElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const error = ref<string | null>(null);
const usingAlternate = ref(false);
let hls: Hls | null = null;

// Bounding-box overlay: sourced from the per-camera analysis SSE stream
// (opening it is also what boosts that camera's sampling rate server-side).
// It's expected to lag the live video somewhat (frame-grab + inference time,
// plus hls.js's own live-edge buffering below) - an accepted tradeoff, not a
// bug. What is fixed here is that boxes used to only ever *snap* to each new
// server update rather than moving continuously between them - see
// `applyDetections`/`interpolatedBox` below.
//
// Detection no longer classifies vehicle type (see MotionDetector), so
// there's nothing to color by class any more - every box is colored purely
// by tracked instance (trackId), cycling through this palette so two
// vehicles on screen at once are visually distinguishable and a single
// vehicle keeps the same color as it moves across frames.
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
/** Fallback for a detection with no trackId - only possible from a non-tracking test fake, never from the live pipeline. */
const DEFAULT_COLOR = TRACK_COLOR_PALETTE[0];

function colorForDetection(detection: VehicleDetection): string {
  if (detection.trackId != null) {
    return TRACK_COLOR_PALETTE[detection.trackId % TRACK_COLOR_PALETTE.length];
  }
  return DEFAULT_COLOR;
}

/** There's no vehicle type to label a box with any more (see MotionDetector) - a best-effort color name if one was estimated, otherwise a generic "Vehicle". */
function labelForDetection(detection: VehicleDetection): string {
  return detection.color ?? 'Vehicle';
}
let unsubscribeAnalysis: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let animationFrameHandle: number | null = null;

/**
 * One tracked vehicle's box animation: it eases from wherever it visually
 * was (`from`) towards the server's newly reported position (`to`) over
 * `durationMs`, rather than jumping straight there.
 */
interface AnimatedBox {
  color: string;
  label: string;
  from: BoundingBox;
  to: BoundingBox;
  startedAt: number;
  durationMs: number;
}

/** Boxes with a stable `trackId`, animated smoothly between updates. */
const trackedBoxes = new Map<number, AnimatedBox>();
/** Detections without a `trackId` (only possible from a non-tracking test fake), drawn as-is. */
let untrackedBoxes: VehicleDetection[] = [];

let lastDetectionsAt: number | null = null;
// The interpolation window is measured from how long the *previous* update
// actually took to arrive, not assumed - a boosted tick is dominated by
// tiled detection, which measures 360-750ms depending on camera resolution
// (see docs/models.md), nowhere near the nominal 500ms sampling interval.
// Guessing wrong in either direction looks worse than not animating at all:
// too short and boxes sit motionless waiting for the next update; too long
// and a vehicle appears to glide for a full second after already having
// stopped. Clamped so a brief network hiccup can't stretch one legitimate
// gap into a multi-second slow-motion glide, and so two updates arriving in
// quick succession still get a perceptible, non-instant transition.
const MIN_INTERP_MS = 150;
const MAX_INTERP_MS = 700;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function interpolatedBox(entry: AnimatedBox, now: number): BoundingBox {
  const t = easeOutCubic(Math.min(1, (now - entry.startedAt) / entry.durationMs));
  return {
    x: lerp(entry.from.x, entry.to.x, t),
    y: lerp(entry.from.y, entry.to.y, t),
    width: lerp(entry.from.width, entry.to.width, t),
    height: lerp(entry.from.height, entry.to.height, t),
  };
}

/**
 * Records a fresh set of detections as new animation targets, rather than
 * replacing the drawn state outright.
 *
 * A track already being drawn continues from wherever it currently is
 * (its live-interpolated position, not its old target) so a detection
 * arriving mid-animation redirects smoothly instead of snapping back to
 * re-start a step. A vehicle absent from this update is dropped
 * immediately, not faded out - `VehicleTracker` only ever emits detections
 * actually present in the current tick, so "missing" means "genuinely left
 * the frame," and animating a fade for it would draw a box over something
 * that is no longer there.
 */
function applyDetections(detections: VehicleDetection[]) {
  const now = performance.now();
  const gapMs = lastDetectionsAt === null ? MIN_INTERP_MS : now - lastDetectionsAt;
  const durationMs = Math.min(MAX_INTERP_MS, Math.max(MIN_INTERP_MS, gapMs));
  lastDetectionsAt = now;

  const seenTrackIds = new Set<number>();
  untrackedBoxes = [];

  for (const detection of detections) {
    if (detection.trackId == null) {
      untrackedBoxes.push(detection);
      continue;
    }
    seenTrackIds.add(detection.trackId);
    const color = colorForDetection(detection);
    const label = labelForDetection(detection);
    const existing = trackedBoxes.get(detection.trackId);
    // Continue from the box's current on-screen position, not its previous
    // target, so a redirect mid-animation doesn't visibly snap backwards
    // before heading to the new target.
    const from = existing ? interpolatedBox(existing, now) : detection.box;
    trackedBoxes.set(detection.trackId, { color, label, from, to: detection.box, startedAt: now, durationMs });
  }

  for (const trackId of Array.from(trackedBoxes.keys())) {
    if (!seenTrackIds.has(trackId)) trackedBoxes.delete(trackId);
  }
}

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
    hls = new Hls({
      // hls.js defaults to staying 3 segments behind the live edge before it
      // even starts playing, purely to absorb network jitter. Our ffmpeg
      // capture has no such deliberate buffer - it decodes continuously and
      // hands back whatever frame it most recently finished with - so with
      // the default the *video* trails noticeably further behind real time
      // than the *detections* do, and the two end up depicting different
      // moments: not just "a bit late" but visibly the wrong moment for the
      // traffic actually on screen. Tightening the target narrows that gap.
      // maxLiveSyncPlaybackRate lets it close any remaining gap with a subtle
      // speed-up rather than a jarring seek/stutter when it briefly falls
      // behind - the standard low-latency-HLS pairing for this option.
      liveSyncDurationCount: 2,
      maxLiveSyncPlaybackRate: 1.2,
    });
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

/** Draws one box + label, in canvas pixel space. */
function drawBox(ctx: CanvasRenderingContext2D, box: BoundingBox, content: ReturnType<typeof getVideoContentRect>, color: string, label: string) {
  const boxX = content.x + box.x * content.width;
  const boxY = content.y + box.y * content.height;
  const boxW = box.width * content.width;
  const boxH = box.height * content.height;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(boxX, boxY, boxW, boxH);

  ctx.font = '600 12px sans-serif';
  const labelWidth = ctx.measureText(label).width + 8;
  const labelY = Math.max(0, boxY - 16);
  ctx.fillStyle = color;
  ctx.fillRect(boxX, labelY, labelWidth, 16);
  ctx.fillStyle = '#0f172a';
  ctx.fillText(label, boxX + 4, labelY + 12);
}

/**
 * Redraws the overlay for the current instant: each tracked box at its
 * current point along its from->to animation, plus any untracked boxes
 * as-is. Called every animation frame (see `animationLoop`) rather than
 * only when a new server result arrives, so a box in the middle of easing
 * towards its target is actually visible moving, not just at its two
 * endpoints.
 */
function drawOverlay() {
  const canvas = canvasRef.value;
  const video = videoRef.value;
  if (!canvas || !video) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const content = getVideoContentRect(video, canvas.width, canvas.height);
  const now = performance.now();

  for (const entry of trackedBoxes.values()) {
    drawBox(ctx, interpolatedBox(entry, now), content, entry.color, entry.label);
  }
  for (const detection of untrackedBoxes) {
    drawBox(ctx, detection.box, content, colorForDetection(detection), labelForDetection(detection));
  }
}

/** Keeps the overlay canvas' pixel size in sync with the video element's displayed (CSS) size. */
function resizeCanvas() {
  const canvas = canvasRef.value;
  const video = videoRef.value;
  if (!canvas || !video) return;
  canvas.width = video.clientWidth;
  canvas.height = video.clientHeight;
}

/** Runs continuously from mount to unmount, independent of when server updates actually arrive - this is what makes box motion look continuous rather than stepwise. */
function animationLoop() {
  drawOverlay();
  animationFrameHandle = requestAnimationFrame(animationLoop);
}

/** Subscribes to the camera's analysis stream to keep the overlay's bounding boxes current. No-op for inactive cameras. */
function attachOverlay() {
  unsubscribeAnalysis?.();
  unsubscribeAnalysis = null;
  trackedBoxes.clear();
  untrackedBoxes = [];
  lastDetectionsAt = null;

  if (props.camera.status !== 'active') return;

  unsubscribeAnalysis = subscribeCameraAnalysis(props.camera.id, (result) => {
    applyDetections(result.error ? [] : result.detections);
  });
}

onMounted(() => {
  attach();
  attachOverlay();
  if (videoRef.value) {
    resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(videoRef.value);
  }
  resizeCanvas();
  animationFrameHandle = requestAnimationFrame(animationLoop);
});
onBeforeUnmount(() => {
  destroy();
  unsubscribeAnalysis?.();
  resizeObserver?.disconnect();
  if (animationFrameHandle !== null) cancelAnimationFrame(animationFrameHandle);
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
