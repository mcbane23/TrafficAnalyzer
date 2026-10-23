<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Hls from 'hls.js';
import type { CameraEntry } from '../../types/camera';
import type { BoundingBox, VehicleDetection } from '../../types/analysis';
import { fetchOverlayModel, subscribeCameraOverlay } from '../services/analysis';
import { planResume, reconnectDelayMs } from '../services/playerResume';
import { t } from '../i18n';

/**
 * `inView`: how many vehicle boxes belong on the picture on screen right now
 * (whether or not they are drawn), so a panel next to the player can show
 * the same count the viewer sees boxed - null while there is nothing to go on.
 */
const emit = defineEmits<{ inView: [count: number | null] }>();
let lastInView: number | null = null;
function reportInView(count: number | null) {
  if (count === lastInView) return;
  lastInView = count;
  emit('inView', count);
}

const props = withDefaults(
  defineProps<{
    camera: CameraEntry;
    showBoxes?: boolean;
    showTrails?: boolean;
    /** False plays the video only: no overlay stream, so the server never starts YOLO for it (the video wall). */
    overlay?: boolean;
  }>(),
  {
    showBoxes: true,
    showTrails: false,
    overlay: true,
  },
);

const containerRef = ref<HTMLDivElement | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const error = ref<string | null>(null);
const usingAlternate = ref(false);
let hls: Hls | null = null;
/**
 * Set while a failed stream is being reloaded (see `scheduleReconnect`): a
 * notice over the video says so instead of the error.
 */
const reconnecting = ref(false);
let reconnectAttempt = 0;
let reconnectHandle: ReturnType<typeof setTimeout> | null = null;
/** hls.js gets one `recoverMediaError` per load before a decode error counts as a failure. */
let mediaRecoveryTried = false;
/**
 * Where the vehicle boxes stand, for the notice over the video: `starting`
 * until the first overlay result covers the picture (the overlay only starts
 * when the camera is opened, so that takes up to ~30s), `ready` from then on,
 * and `unavailable` when the server refuses or keeps failing the overlay.
 */
const overlayState = ref<'starting' | 'ready' | 'unavailable'>('starting');

/**
 * Seconds since the boxes started coming, for the progress bar over the
 * video: it fills over the usual ~30 s and then waits near the end.
 */
const STARTUP_SECONDS = 30;
const startingSeconds = ref(0);
let startingHandle: ReturnType<typeof setInterval> | null = null;
const startingProgress = computed(() => Math.min(95, (startingSeconds.value / STARTUP_SECONDS) * 100));
function stopStartingClock() {
  if (startingHandle !== null) clearInterval(startingHandle);
  startingHandle = null;
}
function startStartingClock() {
  stopStartingClock();
  startingSeconds.value = 0;
  const startedAt = Date.now();
  startingHandle = setInterval(() => (startingSeconds.value = Math.round((Date.now() - startedAt) / 1000)), 1000);
}
/** Which model draws the boxes (e.g. "YOLO26s · GPU"), shown once they appear. */
const overlayModel = ref<string | null>(null);
watch(overlayState, (state) => {
  if (state !== 'starting') stopStartingClock();
  if (state === 'ready') {
    fetchOverlayModel()
      .then((model) => (overlayModel.value = model))
      .catch(() => undefined);
  }
});

// Bounding-box overlay. Boxes come from the appearance-model overlay stream
// (YOLO, run server-side only while this camera is watched - see
// LiveOverlayService). The overlay only begins when the camera is opened, and
// its first results are for a moment ~10s ahead of the picture (plus
// ffmpeg's start-up), so the video goes without boxes for up to half a
// minute; a notice over the video says so (`overlayState`). The fleet-wide
// motion analysis used to stand in meanwhile, but its boxes were too
// imprecise (Bane, 2026-10-21), so the player no longer draws them.
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
/** Overlay (YOLO) results by stream time, oldest first. */
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

type AnalysisMessage = { streamTime?: number; detections: VehicleDetection[]; error?: string };

/**
 * An overlay (YOLO) result. Its errors (e.g. the capture still opening) are
 * dropped while it starts, so they don't end the "starting" notice.
 */
function ingestOverlay(result: AnalysisMessage) {
  if (result.error && overlayState.value === 'starting') return;
  const buffer = synced;
  if (result.streamTime === undefined || !hls) {
    // No stream clock on this result, or none for the picture (native
    // player): arrival-time drawing (see the note at the top).
    if (!result.error) overlayState.value = 'ready';
    applyDetections(result.error ? [] : result.detections);
    return;
  }
  const entry: SyncedResult = { streamTime: result.streamTime, detections: result.error ? [] : result.detections };
  // Usually appended in order; a replayed batch may overlap what's already here.
  let i = buffer.length;
  while (i > 0 && streamDiff(buffer[i - 1].streamTime, entry.streamTime) > 0) i -= 1;
  if (i > 0 && Math.abs(streamDiff(buffer[i - 1].streamTime, entry.streamTime)) < 1e-3) buffer[i - 1] = entry;
  else buffer.splice(i, 0, entry);
  if (buffer.length > MAX_SYNCED_RESULTS) buffer.splice(0, buffer.length - MAX_SYNCED_RESULTS);
}

/** Drops results the playhead has long passed. */
function trimSynced(buffer: SyncedResult[], now: number) {
  let stale = 0;
  while (stale < buffer.length - 1 && streamDiff(now, buffer[stale].streamTime) > KEEP_BEHIND_SECONDS) stale += 1;
  if (stale > 0) buffer.splice(0, stale);
}

/**
 * The boxes for the picture at stream time `t`: interpolated between the
 * results either side of it. Null when no result covers `t` at all, as
 * opposed to a result with no vehicles in it.
 */
function boxesAt(buffer: SyncedResult[], t: number): Array<{ detection: VehicleDetection; box: BoundingBox }> | null {
  let i = buffer.length - 1;
  while (i >= 0 && streamDiff(buffer[i].streamTime, t) > 0) i -= 1;
  if (i < 0) return null;
  const before = buffer[i];
  if (streamDiff(t, before.streamTime) > MAX_HOLD_SECONDS) return null;
  const after = buffer[i + 1];
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
function trailAt(buffer: SyncedResult[], trackId: number, t: number): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (const entry of buffer) {
    const age = streamDiff(t, entry.streamTime);
    if (age < 0 || age > 8) continue;
    const d = entry.detections.find((x) => x.trackId === trackId);
    if (d) points.push({ x: d.box.x + d.box.width / 2, y: d.box.y + d.box.height / 2 });
  }
  return points;
}
let unsubscribeOverlay: (() => void) | null = null;
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
function loadSource(url: string, onFailure: (message: string, retryable?: boolean) => void) {
  const video = videoRef.value;
  if (!video) return;
  mediaRecoveryTried = false;

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
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecoveryTried && hls) {
        mediaRecoveryTried = true;
        hls.recoverMediaError();
        return;
      }
      onFailure(t('player.streamError', { details: data.details }));
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

  onFailure(t('player.unsupported'), false);
}

function handleNativeError() {
  handleFailure(t('player.loadFailed'));
}

/**
 * Called whenever the currently loaded stream fails. If the camera has a
 * configured `alternateUrl` and we haven't already switched to it, retry
 * once with the alternate; after that the stream is reloaded from the start
 * (see `scheduleReconnect`) rather than leaving the error on screen.
 */
function handleFailure(message: string, retryable = true) {
  if (retryable && !usingAlternate.value && props.camera.alternateUrl) {
    usingAlternate.value = true;
    destroy();
    loadSource(props.camera.alternateUrl, (fallbackMessage, fallbackRetryable = true) => {
      if (fallbackRetryable) scheduleReconnect();
      else error.value = fallbackMessage;
    });
    return;
  }
  if (retryable) scheduleReconnect();
  else error.value = message;
}

function cancelReconnect() {
  if (reconnectHandle !== null) clearTimeout(reconnectHandle);
  reconnectHandle = null;
  reconnecting.value = false;
  reconnectAttempt = 0;
}

/**
 * Reloads a failed stream after a growing wait (`reconnectDelayMs`), for as
 * long as the player is open. Nothing is tried while the page is hidden (a
 * sleeping phone has no network anyway); coming back to it, or the network
 * coming back, reconnects at once (see `reconnectNow`).
 */
function scheduleReconnect() {
  destroy();
  reconnecting.value = true;
  if (reconnectHandle !== null) clearTimeout(reconnectHandle);
  reconnectHandle = null;
  if (document.visibilityState === 'hidden') return;
  reconnectAttempt += 1;
  reconnectHandle = setTimeout(() => {
    reconnectHandle = null;
    if (document.visibilityState === 'hidden') return;
    load();
  }, reconnectDelayMs(reconnectAttempt));
}

/** Retries a failed stream right away, with the backoff started over. */
function reconnectNow() {
  if (!reconnecting.value) return;
  if (reconnectHandle !== null) clearTimeout(reconnectHandle);
  reconnectHandle = null;
  reconnectAttempt = 0;
  load();
}

/** The picture is moving again: the reconnect, if any, worked. */
function handlePlaying() {
  if (!reconnecting.value) return;
  cancelReconnect();
  // The video jumped ahead to the live picture: the boxes for it come from
  // the overlay's replay, as after a background tab.
  if (unsubscribeOverlay) {
    if (overlayState.value === 'ready') restartingOverlay();
    openOverlay();
  }
}

function attach() {
  cancelReconnect();
  load();
}

function load() {
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
    trimSynced(synced, streamTime);
    const covering = boxesAt(synced, streamTime);
    // The first result for the picture on screen ends the "starting" notice.
    if (covering !== null && overlayState.value === 'starting') overlayState.value = 'ready';
    const boxes = covering ?? [];
    reportInView(overlayState.value === 'ready' ? boxes.length : null);
    if (props.showTrails) {
      for (const { detection } of boxes) {
        if (detection.trackId == null) continue;
        drawTrail(ctx, trailAt(synced, detection.trackId, streamTime), content, colorForDetection(detection));
      }
    }
    if (!props.showBoxes) return;
    for (const { detection, box } of boxes) drawBox(ctx, box, content, colorForDetection(detection), labelForDetection(detection));
    return;
  }

  reportInView(lastDetectionsAt === null ? null : trackedBoxes.size + untrackedBoxes.length);
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

/** Subscribes to the camera's overlay (appearance-model) boxes. No-op for inactive cameras. */
function attachOverlay() {
  if (!props.overlay) return;
  unsubscribeOverlay?.();
  unsubscribeOverlay = null;
  overlayState.value = 'starting';
  overlayModel.value = null;
  startStartingClock();
  trackedBoxes.clear();
  trails.clear();
  untrackedBoxes = [];
  lastDetectionsAt = null;
  synced = [];
  reportInView(null);
  openOverlay();
}

/**
 * Opens the overlay stream, closing the previous one only once the new one is
 * subscribed, so the server never sees the camera without a viewer. Results
 * already received are kept: the server first replays its recent ones, which
 * `ingestOverlay` merges by stream time.
 */
function openOverlay() {
  if (props.camera.status !== 'active') {
    stopStartingClock();
    return;
  }
  const previous = unsubscribeOverlay;
  const unsubscribe = subscribeCameraOverlay(
    props.camera.id,
    ingestOverlay,
    () => {
      if (unsubscribeOverlay !== unsubscribe) return;
      unsubscribeOverlay = null;
      synced = [];
      trackedBoxes.clear();
      trails.clear();
      untrackedBoxes = [];
      overlayState.value = 'unavailable';
      reportInView(null);
    },
    () => {
      // Back after a drop: the notice shows until a result covers the picture
      // again, at once if the detector kept running, ~30 s if it restarted.
      if (unsubscribeOverlay === unsubscribe && overlayState.value === 'ready') restartingOverlay();
    },
  );
  unsubscribeOverlay = unsubscribe;
  previous?.();
}

/** Shows the "starting" notice again until boxes cover the picture once more. */
function restartingOverlay() {
  overlayState.value = 'starting';
  startStartingClock();
}

/** When the tab was hidden (performance.now()), or null while it is visible. */
let hiddenSince: number | null = null;

/** Brings the player back in step after the tab was in the background - see `planResume`. */
function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    hiddenSince = performance.now();
    return;
  }
  if (reconnecting.value) {
    hiddenSince = null;
    reconnectNow();
    return;
  }
  if (hiddenSince === null) return;
  const hiddenForMs = performance.now() - hiddenSince;
  hiddenSince = null;
  const video = videoRef.value;
  if (!video || error.value) return;
  const plan = planResume({
    hiddenForMs,
    paused: video.paused,
    currentTime: video.currentTime,
    liveSyncPosition: hls?.liveSyncPosition ?? null,
    targetDuration: hls?.latestLevelDetails?.targetduration ?? null,
  });
  if (plan.seekTo !== null) video.currentTime = plan.seekTo;
  if (plan.play) video.play().catch(() => undefined);
  if (plan.refreshOverlay && unsubscribeOverlay) {
    if (overlayState.value === 'ready') restartingOverlay();
    openOverlay();
  }
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
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('online', reconnectNow);
  videoRef.value?.addEventListener('playing', handlePlaying);
});
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('online', reconnectNow);
  videoRef.value?.removeEventListener('playing', handlePlaying);
  cancelReconnect();
  destroy();
  unsubscribeOverlay?.();
  stopStartingClock();
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
      <div
        v-if="!error && reconnecting"
        class="pointer-events-none absolute left-1/2 top-1/2 max-w-[90%] -translate-x-1/2 -translate-y-1/2 rounded-md bg-slate-900/85 px-3 py-2 text-center text-xs font-medium text-slate-200"
        role="status"
      >
        {{ t('player.reconnecting') }}
      </div>
      <div
        v-else-if="!error && showBoxes && camera.status === 'active' && overlayState === 'starting'"
        class="pointer-events-none absolute left-1/2 top-3 w-64 max-w-[90%] -translate-x-1/2 rounded-md bg-slate-900/85 px-3 py-2 text-xs font-medium text-slate-200"
        role="status"
      >
        <div class="flex items-center justify-between gap-3">
          <span>{{ startingSeconds < STARTUP_SECONDS ? t('player.starting') : t('player.startingLong') }}</span>
          <span class="tabular-nums text-slate-400">{{ startingSeconds }} s</span>
        </div>
        <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-700">
          <div class="h-full rounded-full bg-sky-400 transition-[width] duration-1000 ease-linear" :style="{ width: `${startingProgress}%` }"></div>
        </div>
      </div>
      <div
        v-else-if="!error && showBoxes && camera.status === 'active' && overlayState === 'unavailable'"
        class="pointer-events-none absolute left-1/2 top-3 max-w-[90%] -translate-x-1/2 rounded-md bg-slate-900/80 px-3 py-1.5 text-center text-xs font-medium text-slate-200"
      >
        {{ t('player.unavailable') }}
      </div>
      <span
        v-if="!error && showBoxes && overlayState === 'ready' && overlayModel"
        class="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-slate-300"
        :title="t('player.modelTitle')"
      >
        {{ overlayModel }}
      </span>
    </div>
    <div
      v-if="usingAlternate && !error"
      class="bg-amber-500/90 px-3 py-1 text-center text-xs font-medium text-slate-900"
    >
      {{ t('player.backup') }}{{ camera.alternateSource ? ` (${camera.alternateSource})` : '' }}
    </div>
    <div v-if="error" class="flex aspect-video w-full items-center justify-center p-6 text-center text-sm text-slate-300">
      {{ error }}
    </div>
  </div>
</template>
