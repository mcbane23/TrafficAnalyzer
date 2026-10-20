<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Hls from 'hls.js';
import type { CameraEntry } from '../../types/camera';
import type { BoundingBox, VehicleDetection } from '../../types/analysis';
import { fetchRecentAnalysis, subscribeCameraAnalysis, subscribeCameraOverlay } from '../services/analysis';

const props = withDefaults(defineProps<{ camera: CameraEntry; showBoxes?: boolean; showTrails?: boolean }>(), {
  showBoxes: true,
  showTrails: false,
});

const containerRef = ref<HTMLDivElement | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const error = ref<string | null>(null);
const usingAlternate = ref(false);
let hls: Hls | null = null;

// Bounding-box overlay. Boxes come from the appearance-model overlay stream
// (YOLO, run server-side only while this camera is watched - see
// LiveOverlayService), falling back to the fleet-wide motion analysis when
// that is unavailable.
//
// Boxes are drawn *in sync with the picture*, not when they arrive. Every
// result carries `streamTime`, the source stream's own presentation time of
// the frame it was computed from, and hls.js reports the same clock for the
// frame on screen (see `currentStreamTime`). The server's capture runs about
// one HLS segment ahead of this player, so results arrive before their
// picture, wait in `synced`, and are drawn when the video reaches them -
// interpolated between the two results either side of the current frame.
// Drawing results as they arrived put every box several seconds away from
// its vehicle, by an amount that changed each time either side reconnected.
// Without a stream clock (Safari's native player, or results lacking
// `streamTime`) boxes fall back to that arrival-time drawing.
//
// Boxes are colored by tracked instance (trackId), cycling through this
// palette so two vehicles on screen at once are visually distinguishable and
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
/** Fallback for a detection with no trackId - only possible from a non-tracking test fake, never from the live pipeline. */
const DEFAULT_COLOR = TRACK_COLOR_PALETTE[0];

function colorForDetection(detection: VehicleDetection): string {
  if (detection.trackId != null) {
    return TRACK_COLOR_PALETTE[detection.trackId % TRACK_COLOR_PALETTE.length];
  }
  return DEFAULT_COLOR;
}

const CLASS_LABELS: Record<VehicleDetection['class'], string> = {
  vehicle: 'Vehicle',
  car: 'Car',
  motorcycle: 'Motorcycle',
  bus: 'Bus',
  truck: 'Truck',
};

/** The vehicle type where the detector knows it (the overlay model does, motion detection doesn't). */
function labelForDetection(detection: VehicleDetection): string {
  return CLASS_LABELS[detection.class] ?? 'Vehicle';
}

/** MPEG-TS timestamps are 33-bit 90kHz counters: they wrap every ~26.5 hours. */
const PTS_WRAP_SECONDS = 2 ** 33 / 90_000;

/** `a - b` in stream seconds, taking the shorter way round the PTS wrap. */
function streamDiff(a: number, b: number): number {
  const d = (((a - b) % PTS_WRAP_SECONDS) + PTS_WRAP_SECONDS) % PTS_WRAP_SECONDS;
  return d > PTS_WRAP_SECONDS / 2 ? d - PTS_WRAP_SECONDS : d;
}

/** A result waiting for (or being drawn at) its moment in the video. */
interface SyncedResult {
  streamTime: number;
  detections: VehicleDetection[];
}
/** Results by stream time, oldest first. */
let synced: SyncedResult[] = [];
/**
 * How long one result is still drawn after its frame when the next one is
 * missing. A slow host drops frames when the detector can't keep up, so
 * results can be a second or more apart; beyond this, nothing is known
 * about the picture.
 */
const MAX_HOLD_SECONDS = 2;
/** Two results further apart than this are not interpolated between. */
const MAX_INTERPOLATION_GAP_SECONDS = 2;
/** Results older than this (behind the playhead) are dropped. */
const KEEP_BEHIND_SECONDS = 10;
const MAX_SYNCED_RESULTS = 600;

/** Stream-time offset of each hls.js discontinuity sequence: raw PTS (s) = media time + offset. */
const ptsOffsetByCc = new Map<number, number>();
let playingCc: number | null = null;
let lastPtsOffset: number | null = null;

/** The source-stream presentation time of the frame on screen, or null without hls.js / before it knows. */
function currentStreamTime(video: HTMLVideoElement): number | null {
  const offset = (playingCc !== null ? ptsOffsetByCc.get(playingCc) : undefined) ?? lastPtsOffset;
  if (offset == null) return null;
  return video.currentTime + offset;
}

function ingest(result: { streamTime?: number; detections: VehicleDetection[]; error?: string }) {
  if (result.streamTime === undefined || !hls) {
    // No stream clock on this result, or none for the picture (native
    // player): arrival-time drawing (see the note at the top).
    applyDetections(result.error ? [] : result.detections);
    return;
  }
  const entry: SyncedResult = { streamTime: result.streamTime, detections: result.error ? [] : result.detections };
  // Usually appended in order; a replayed batch may overlap what's already here.
  let i = synced.length;
  while (i > 0 && streamDiff(synced[i - 1].streamTime, entry.streamTime) > 0) i -= 1;
  if (i > 0 && Math.abs(streamDiff(synced[i - 1].streamTime, entry.streamTime)) < 1e-3) synced[i - 1] = entry;
  else synced.splice(i, 0, entry);
  if (synced.length > MAX_SYNCED_RESULTS) synced.splice(0, synced.length - MAX_SYNCED_RESULTS);
}

/** Drops results the playhead has long passed. */
function trimSynced(now: number) {
  let stale = 0;
  while (stale < synced.length - 1 && streamDiff(now, synced[stale].streamTime) > KEEP_BEHIND_SECONDS) stale += 1;
  if (stale > 0) synced.splice(0, stale);
}

/** The boxes for the picture at stream time `t`: interpolated between the results either side of it. */
function boxesAt(t: number): Array<{ detection: VehicleDetection; box: BoundingBox }> {
  let i = synced.length - 1;
  while (i >= 0 && streamDiff(synced[i].streamTime, t) > 0) i -= 1;
  if (i < 0) return [];
  const before = synced[i];
  if (streamDiff(t, before.streamTime) > MAX_HOLD_SECONDS) return [];
  const after = synced[i + 1];
  const gap = after ? streamDiff(after.streamTime, before.streamTime) : Infinity;
  const fraction = gap > 0 && gap <= MAX_INTERPOLATION_GAP_SECONDS ? streamDiff(t, before.streamTime) / gap : null;

  return before.detections.map((detection) => {
    const next = fraction !== null && detection.trackId != null ? after.detections.find((d) => d.trackId === detection.trackId) : undefined;
    if (!next || fraction === null) return { detection, box: detection.box };
    const a = detection.box;
    const b = next.box;
    return {
      detection,
      box: {
        x: lerp(a.x, b.x, fraction),
        y: lerp(a.y, b.y, fraction),
        width: lerp(a.width, b.width, fraction),
        height: lerp(a.height, b.height, fraction),
      },
    };
  });
}

/** Box centres of one track over the last few seconds up to `t`, for the trail overlay. */
function trailAt(trackId: number, t: number): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (const entry of synced) {
    const age = streamDiff(t, entry.streamTime);
    if (age < 0 || age > 8) continue;
    const d = entry.detections.find((x) => x.trackId === trackId);
    if (d) points.push({ x: d.box.x + d.box.width / 2, y: d.box.y + d.box.height / 2 });
  }
  return points;
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
/** Recent box centres per track (normalized), for the optional motion-trail overlay. */
const trails = new Map<number, Array<{ x: number; y: number }>>();
const MAX_TRAIL_POINTS = 24;
/** Detections without a `trackId` (only possible from a non-tracking test fake), drawn as-is. */
let untrackedBoxes: VehicleDetection[] = [];

let lastDetectionsAt: number | null = null;
// The interpolation window is measured from how long the *previous* update
// actually took to arrive, not assumed - frames are analyzed at the
// server's capture fps (default 3), and an occasional dropped or delayed
// frame stretches that gap.
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
    const trail = trails.get(detection.trackId) ?? [];
    trail.push({ x: detection.box.x + detection.box.width / 2, y: detection.box.y + detection.box.height / 2 });
    if (trail.length > MAX_TRAIL_POINTS) trail.shift();
    trails.set(detection.trackId, trail);
  }

  for (const trackId of Array.from(trackedBoxes.keys())) {
    if (!seenTrackIds.has(trackId)) {
      trackedBoxes.delete(trackId);
      trails.delete(trackId);
    }
  }
}

function destroy() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  ptsOffsetByCc.clear();
  playingCc = null;
  lastPtsOffset = null;
  videoRef.value?.removeEventListener('error', handleNativeError);
}

/**
 * Loads a stream URL into the video element with hls.js wherever Media
 * Source Extensions exist, and the browser's native HLS player only where
 * they don't (iOS Safari). hls.js comes first on purpose: newer desktop
 * browsers also answer `canPlayType('application/vnd.apple.mpegurl')`, and
 * their native player was seen failing on every one of these camera
 * streams with a bare "failed to load video" while the same URLs played in
 * hls.js. Failures are reported via
 * `onFailure` rather than directly setting `error`, so the caller can
 * decide whether to fall back to `camera.alternateUrl` first.
 */
function loadSource(url: string, onFailure: (message: string) => void) {
  const video = videoRef.value;
  if (!video) return;

  if (Hls.isSupported()) {
    hls = new Hls({
      // Three target durations behind the end of the playlist (~30s on these
      // 10s-segment streams). The server's analysis capture joins one segment
      // nearer the edge (FrameGrabber's LIVE_START_INDEX), so the results for
      // each picture are already here, buffered, when it is shown. Playing
      // closer to the edge than the analysis would leave the boxes nothing
      // to draw. maxLiveSyncPlaybackRate closes a drift with a subtle
      // speed-up rather than a seek.
      liveSyncDurationCount: 3,
      maxLiveSyncPlaybackRate: 1.2,
    });
    // The stream clock for the overlay: hls.js maps each discontinuity
    // sequence's PTS onto media time with its own base (raw = media + base).
    hls.on(Hls.Events.INIT_PTS_FOUND, (_event, data) => {
      if (data.id !== 'main') return;
      const offset = data.initPTS / data.timescale;
      ptsOffsetByCc.set(data.frag.cc, offset);
      lastPtsOffset = offset;
    });
    hls.on(Hls.Events.FRAG_CHANGED, (_event, data) => {
      playingCc = data.frag.cc;
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

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // No MSE (iOS Safari) - fall back to the browser's own HLS player.
    video.addEventListener('error', handleNativeError);
    video.src = url;
    video.play().catch(() => undefined);
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

  const streamTime = synced.length > 0 ? currentStreamTime(video) : null;
  if (streamTime !== null) {
    trimSynced(streamTime);
    const boxes = boxesAt(streamTime);
    if (props.showTrails) {
      for (const { detection } of boxes) {
        if (detection.trackId == null) continue;
        drawTrail(ctx, trailAt(detection.trackId, streamTime), content, colorForDetection(detection));
      }
    }
    if (!props.showBoxes) return;
    for (const { detection, box } of boxes) drawBox(ctx, box, content, colorForDetection(detection), labelForDetection(detection));
    return;
  }

  if (props.showTrails) {
    for (const [trackId, trail] of trails) {
      const entry = trackedBoxes.get(trackId);
      if (entry) drawTrail(ctx, trail, content, entry.color);
    }
  }
  if (!props.showBoxes) return;
  for (const entry of trackedBoxes.values()) {
    drawBox(ctx, interpolatedBox(entry, now), content, entry.color, entry.label);
  }
  for (const detection of untrackedBoxes) {
    drawBox(ctx, detection.box, content, colorForDetection(detection), labelForDetection(detection));
  }
}

function drawTrail(ctx: CanvasRenderingContext2D, trail: Array<{ x: number; y: number }>, content: ReturnType<typeof getVideoContentRect>, color: string) {
  if (trail.length < 2) return;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 2;
  ctx.beginPath();
  trail.forEach((point, i) => {
    const px = content.x + point.x * content.width;
    const py = content.y + point.y * content.height;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.globalAlpha = 1;
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

/**
 * Subscribes to the camera's overlay boxes: the appearance-model stream
 * first, the motion-analysis stream if that's unavailable. No-op for
 * inactive cameras.
 */
function attachOverlay() {
  unsubscribeAnalysis?.();
  unsubscribeAnalysis = null;
  trackedBoxes.clear();
  trails.clear();
  untrackedBoxes = [];
  lastDetectionsAt = null;
  synced = [];

  if (props.camera.status !== 'active') return;

  const cameraId = props.camera.id;
  unsubscribeAnalysis = subscribeCameraOverlay(cameraId, ingest, () => {
    if (props.camera.id !== cameraId) return;
    synced = [];
    const unsubscribeMotion = subscribeCameraAnalysis(cameraId, ingest);
    unsubscribeAnalysis = unsubscribeMotion;
    // The picture on screen is older than the frame the server is analyzing
    // now - fetch the results already produced for it.
    fetchRecentAnalysis(cameraId)
      .then((recent) => {
        if (unsubscribeAnalysis === unsubscribeMotion) recent.forEach(ingest);
      })
      .catch(() => undefined);
  });
}

/** Fullscreens the video together with its overlay (the native video control would leave the canvas behind). */
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
  else containerRef.value?.requestFullscreen().catch(() => undefined);
}

defineExpose({ toggleFullscreen });

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
    <div ref="containerRef" class="relative bg-black">
      <video v-show="!error" ref="videoRef" class="aspect-video h-full w-full" muted autoplay playsinline></video>
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
