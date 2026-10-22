import { CameraEntry } from '../types/camera';
import { CameraSource } from '../server/cameraService';
import { CameraAnalysisOverview, CameraAnalysisResult, StoredAnalysisResult } from '../types/analysis';
import { FrameCapture, GrabFrameResult } from './frameGrabber';
import { CameraAnalyzer } from './cameraAnalyzer';
import { VideoFrame, encodeJpeg } from './videoFrame';
import { ThroughputWindow } from './throughputWindow';
import { CameraAnalysisMetrics } from '../types/admin';

/** Narrow seam over FrameGrabber so tests can inject a fake without spawning ffmpeg. */
export interface FrameGrabberLike {
  /** A continuously-decoding, self-reconnecting capture of one camera. The caller must close it. */
  openCapture(camera: CameraEntry): FrameCapture;
}

/**
 * Narrow seam over `CameraAnalyzer` - everything that turns one camera's
 * frame into one result, including all of that camera's learned state.
 */
export interface CameraAnalyzerLike {
  analyze(frame: VideoFrame, timestamp: string): Promise<CameraAnalysisResult>;
  /** The result for a frame that never arrived - the analyzer owns this camera's result shape either way. */
  errorResult(timestamp: string, error: string): CameraAnalysisResult;
  dispose(): void;
}

/** Narrow seam over TrafficHistoryStore. */
export interface TrafficHistoryStoreLike {
  record(result: StoredAnalysisResult): void;
  getLatestForAllCameras(): StoredAnalysisResult[];
  getHistory(cameraId: string, options?: { sinceIso?: string; limit?: number }): StoredAnalysisResult[];
}

/**
 * Narrow seam over timers so scheduling can be driven deterministically in
 * tests instead of relying on real wall-clock delays.
 */
export interface AnalysisScheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: AnalysisScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface TrafficAnalysisServiceOptions {
  /**
   * Max number of frames being analyzed at once, across all cameras.
   * Defaults to 6. Each camera only ever has one frame in flight (its loop
   * waits for the analysis before taking the next frame), so this bounds
   * CPU when many cameras' frames land together; a camera waiting on a slot
   * just lets its capture queue up (and eventually drop) frames meanwhile.
   */
  maxConcurrency?: number;
  /**
   * How often (ms) a camera's history row is written. Defaults to 10000.
   * Analysis runs at several frames per second on every active camera, and
   * a row per frame would grow the database by millions of rows a day for
   * no extra information - each row instead holds the mean vehicle count
   * over its window.
   */
  historyIntervalMs?: number;
  /**
   * Minimum spacing (ms) between dashboard overview updates for one camera.
   * Defaults to 2000. A changed traffic level or error state is always sent
   * straight away; this only stops an unchanged badge from being re-sent at
   * frame rate to every open dashboard.
   */
  overviewIntervalMs?: number;
  /**
   * Builds one camera's analyzer. A factory, not a shared instance: an
   * analyzer holds that camera's background model, tracks and learned
   * roadway, all of which describe a single fixed viewpoint and are
   * meaningless shared across cameras. Defaults to a real `CameraAnalyzer`.
   */
  createAnalyzer?: (cameraId: string, camera: CameraEntry) => CameraAnalyzerLike;
  /**
   * Called with every usable result - not errors, not warm-up frames - on
   * every frame, including its `finishedTracks`. This is the hook for
   * consumers that need every frame's output rather than the throttled
   * history, e.g. persisting vehicle passages.
   */
  onResult?: (result: CameraAnalysisResult) => void;
  /**
   * Minimum spacing (ms, by capture time) between refreshes of a camera's
   * JPEG thumbnail (`getLatestFrame`). Defaults to 2000. Frames arrive as
   * raw video, so a thumbnail costs a JPEG encode; doing that for every
   * analyzed frame would put back much of the per-frame cost raw capture
   * removed, for an image nobody looks at more than every few seconds.
   */
  thumbnailIntervalMs?: number;
  /**
   * How much of each camera's recent per-frame results (ms, by capture time)
   * is kept for `getRecentResults`. Defaults to 45000. A viewer's player runs
   * some way behind the analysis capture, so the results for the picture it
   * is about to show were produced before it connected - see
   * `getRecentResults`.
   */
  recentResultsMs?: number;
  /**
   * Cameras to analyze, as switched on on the Admin page (see
   * `applySettings`); active cameras outside it are skipped. Each analyzed
   * camera keeps an ffmpeg capture running (~17 MB of memory and a share of
   * a CPU core), so the user picks them - none by default. Unset analyzes
   * every active camera (tests, and callers without an Admin page).
   */
  enabledCameras?: string[];
  /** Encodes a thumbnail. Defaults to `encodeJpeg`. */
  encodeThumbnail?: (frame: VideoFrame) => Promise<Buffer>;
  now?: () => Date;
  scheduler?: AnalysisScheduler;
}

type ResultSubscriber = (result: CameraAnalysisResult) => void;
type OverviewSubscriber = (overview: CameraAnalysisOverview) => void;

/**
 * Everything this service tracks about one camera, including the analyzer
 * holding that camera's learned state and the capture feeding it. One
 * record per camera, created in `start()` or `reload()` and dropped in
 * `stop()` or `reload()` - there is deliberately no second map keyed by
 * camera id with a different lifetime.
 */
interface CameraState {
  camera: CameraEntry;
  analyzer: CameraAnalyzerLike;
  /** Open for as long as the service runs; null only before this camera's staggered start. */
  capture: FrameCapture | null;
  startHandle: unknown;
  /** Counts accumulated since the last history row. */
  historyWindow: { startedAt: number; counts: number[]; lastResult: CameraAnalysisResult | null };
  lastOverviewAt: number;
  /** Most recently encoded thumbnail (JPEG) - served as the camera's still image. */
  latestFrame: { buffer: Buffer; capturedAt: string } | null;
  /** Capture time (ms) of the frame the latest thumbnail encode was started from. */
  thumbnailStartedAt: number;
  /** This camera's results from the last `recentResultsMs`, oldest first - see `getRecentResults`. */
  recentResults: CameraAnalysisResult[];
  /** Analyzed frames and failed captures over the last few seconds, for `getMetrics`. */
  throughput: ThroughputWindow;
  errors: ThroughputWindow;
}

const DEFAULTS = {
  maxConcurrency: 6,
  historyIntervalMs: 10_000,
  overviewIntervalMs: 2_000,
  thumbnailIntervalMs: 2_000,
  recentResultsMs: 45_000,
};

/**
 * Spacing between each active camera's capture starting on `start()`.
 * Without it every camera spawns ffmpeg against its stream at the same
 * instant - observed in practice to make a chunk of that first batch fail
 * purely from the burst (process-launch contention, and several cameras
 * sharing the same small upstream relay all connecting at once).
 */
const STARTUP_STAGGER_STEP_MS = 400;

/** How long a camera analyzed only for its viewers keeps running after the last one leaves. */
const VIEWER_LINGER_MS = 15_000;

/** How far back the Admin page's per-camera rates look. */
const METRICS_WINDOW_MS = 15_000;

/**
 * TrafficAnalysisService is the central orchestrator for the vehicle
 * traffic analysis feature.
 *
 * Every camera whose registry `status` is `active` is analyzed
 * continuously for as long as the service runs: one long-lived,
 * self-reconnecting `FrameCapture` per camera (see `FrameGrabber`), and a
 * loop that takes each decoded frame, runs it through that camera's
 * `CameraAnalyzer`, and fans the result out. Continuous analysis is what
 * makes tracking - and so counting vehicles rather than blobs - possible at
 * all: a tracker needs consecutive frames, and a background model needs a
 * few seconds of footage before it can see anything. (The previous design
 * analyzed one frame per camera at startup, which never got past the
 * detector's warm-up, so every dashboard count was a structural zero.)
 *
 * Results go three ways, at three rates:
 * - detail-page subscribers get every frame's full result, live;
 * - dashboard overview subscribers get a lightweight update when a camera's
 *   badge or error state changes, otherwise at most every
 *   `overviewIntervalMs`;
 * - history gets one row per camera per `historyIntervalMs`, holding the
 *   mean count over that window.
 * Error and warm-up results are published to live viewers (who need to know
 * the feed is broken or still settling) but never persisted - their zeroed
 * counts describe the pipeline, not the road.
 *
 * What this service deliberately does *not* know is how a frame becomes a
 * result - that is `CameraAnalyzer`. `FrameGrabber`, the analyzer factory,
 * `TrafficHistoryStore` and the scheduler/clock are all injected as narrow
 * interfaces, so this orchestration can be unit tested without real
 * capture, detection or timers.
 */
export class TrafficAnalysisService {
  private readonly options: {
    maxConcurrency: number;
    historyIntervalMs: number;
    overviewIntervalMs: number;
    createAnalyzer: (cameraId: string, camera: CameraEntry) => CameraAnalyzerLike;
    onResult: ((result: CameraAnalysisResult) => void) | null;
    thumbnailIntervalMs: number;
    recentResultsMs: number;
    encodeThumbnail: (frame: VideoFrame) => Promise<Buffer>;
    now: () => Date;
    scheduler: AnalysisScheduler;
  };

  private readonly cameraStates = new Map<string, CameraState>();
  private readonly resultSubscribers = new Map<string, Set<ResultSubscriber>>();
  private readonly overviewSubscribers = new Set<OverviewSubscriber>();
  private readonly latestOverview = new Map<string, CameraAnalysisOverview>();
  private readonly loops = new Set<Promise<void>>();
  private enabledCameras: Set<string> | null;
  /**
   * Active cameras the settings leave out. One of them is still analyzed
   * while its camera page is open (see `subscribeCameraDetail`).
   */
  private readonly excluded = new Map<string, CameraEntry>();
  /** Pending stops of left-out cameras whose last viewer just left. */
  private readonly viewerLinger = new Map<string, unknown>();

  private running = false;
  private activeJobs = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly source: CameraSource,
    private readonly frameGrabber: FrameGrabberLike,
    private readonly historyStore: TrafficHistoryStoreLike,
    options: TrafficAnalysisServiceOptions = {},
  ) {
    this.options = {
      maxConcurrency: options.maxConcurrency ?? DEFAULTS.maxConcurrency,
      historyIntervalMs: options.historyIntervalMs ?? DEFAULTS.historyIntervalMs,
      overviewIntervalMs: options.overviewIntervalMs ?? DEFAULTS.overviewIntervalMs,
      createAnalyzer:
        options.createAnalyzer ??
        ((cameraId, camera) => new CameraAnalyzer(cameraId, { ignoreZones: camera.ignoreZones?.map((zone) => zone.points) })),
      onResult: options.onResult ?? null,
      thumbnailIntervalMs: options.thumbnailIntervalMs ?? DEFAULTS.thumbnailIntervalMs,
      recentResultsMs: options.recentResultsMs ?? DEFAULTS.recentResultsMs,
      encodeThumbnail: options.encodeThumbnail ?? ((frame) => encodeJpeg(frame)),
      now: options.now ?? (() => new Date()),
      scheduler: options.scheduler ?? defaultScheduler,
    };

    this.enabledCameras = options.enabledCameras ? new Set(options.enabledCameras) : null;

    for (const result of this.historyStore.getLatestForAllCameras()) {
      this.latestOverview.set(result.cameraId, {
        cameraId: result.cameraId,
        timestamp: result.timestamp,
        totalCount: result.totalCount,
        trafficLevel: result.trafficLevel,
      });
    }
  }

  /**
   * Loads the camera registry and starts continuous analysis of every active
   * camera the settings leave in, staggered.
   * Inactive cameras are skipped entirely.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const entries = await this.source.load();
    this.selectCameras(entries).forEach((camera, index) => this.addCamera(camera, index * STARTUP_STAGGER_STEP_MS));
  }

  /**
   * Changes which cameras are analyzed (the Admin page's switches) and
   * applies it straight away, like `reload()`: cameras switched off stop,
   * cameras switched on start, the rest keep running.
   */
  async setEnabledCameras(cameraIds: string[]): Promise<{ started: string[]; stopped: string[] }> {
    this.enabledCameras = new Set(cameraIds);
    return this.reload();
  }

  /**
   * The active cameras to analyze, in registry order: those the settings
   * switch on, plus any left-out one that is being watched (or was until a
   * moment ago); records the left-out ones.
   */
  private selectCameras(entries: CameraEntry[]): CameraEntry[] {
    this.excluded.clear();
    const selected: CameraEntry[] = [];
    for (const camera of entries) {
      if (camera.status !== 'active') continue;
      const switchedOn = !this.enabledCameras || this.enabledCameras.has(camera.id);
      if (!switchedOn) this.excluded.set(camera.id, camera);
      if (switchedOn || this.isViewed(camera.id)) selected.push(camera);
    }
    return selected;
  }

  /** Has camera-page viewers, or lost its last one less than `VIEWER_LINGER_MS` ago. */
  private isViewed(cameraId: string): boolean {
    return (this.resultSubscribers.get(cameraId)?.size ?? 0) > 0 || this.viewerLinger.has(cameraId);
  }

  /**
   * Re-reads the registry and brings the analyzed set in line with it
   * without a restart: cameras that became active start (staggered, like
   * at boot), cameras that are no longer active stop. Cameras active
   * before and after keep running untouched, learned state and all. Called
   * when an availability check has rewritten the registry.
   */
  async reload(): Promise<{ started: string[]; stopped: string[] }> {
    if (!this.running) return { started: [], stopped: [] };
    const entries = await this.source.load();
    if (!this.running) return { started: [], stopped: [] };
    const active = new Map(this.selectCameras(entries).map((camera) => [camera.id, camera]));

    const stopped: string[] = [];
    for (const [cameraId, state] of Array.from(this.cameraStates)) {
      if (active.has(cameraId)) continue;
      this.removeCamera(state);
      stopped.push(cameraId);
    }
    const started: string[] = [];
    for (const camera of active.values()) {
      if (this.cameraStates.has(camera.id)) continue;
      this.addCamera(camera, started.length * STARTUP_STAGGER_STEP_MS);
      started.push(camera.id);
    }
    return { started, stopped };
  }

  private addCamera(camera: CameraEntry, startDelayMs: number): void {
    const state: CameraState = {
      camera,
      analyzer: this.options.createAnalyzer(camera.id, camera),
      capture: null,
      startHandle: null,
      historyWindow: { startedAt: this.options.now().getTime(), counts: [], lastResult: null },
      lastOverviewAt: -Infinity,
      latestFrame: null,
      thumbnailStartedAt: -Infinity,
      recentResults: [],
      throughput: new ThroughputWindow(METRICS_WINDOW_MS, () => this.options.now().getTime()),
      errors: new ThroughputWindow(METRICS_WINDOW_MS, () => this.options.now().getTime()),
    };
    this.cameraStates.set(camera.id, state);
    state.startHandle = this.options.scheduler.setTimeout(() => this.startCamera(state), startDelayMs);
  }

  private isCurrent(state: CameraState): boolean {
    return this.cameraStates.get(state.camera.id) === state;
  }

  /** Stops one camera's loop, closing its capture and disposing its analyzer. */
  private removeCamera(state: CameraState): void {
    if (state.startHandle !== null) this.options.scheduler.clearTimeout(state.startHandle);
    state.startHandle = null;
    state.capture?.close();
    state.capture = null;
    // Everything this camera had learned goes with its analyzer - see
    // `CameraAnalyzer.dispose`.
    state.analyzer.dispose();
    if (this.cameraStates.get(state.camera.id) === state) this.cameraStates.delete(state.camera.id);
  }

  /** Stops every camera's loop, closing its capture and disposing its analyzer. */
  stop(): void {
    this.running = false;
    for (const handle of this.viewerLinger.values()) this.options.scheduler.clearTimeout(handle);
    this.viewerLinger.clear();
    for (const state of Array.from(this.cameraStates.values())) this.removeCamera(state);
  }

  /** Resolves once every camera loop has exited - after `stop()`, for tests and graceful shutdown. */
  async idle(): Promise<void> {
    await Promise.all(Array.from(this.loops));
  }

  /** Cameras the settings switch on, or null when no setting limits them (every active camera is analyzed). */
  getEnabledCameras(): string[] | null {
    return this.enabledCameras ? Array.from(this.enabledCameras) : null;
  }

  /** Latest known overview (count + traffic level) for every camera analyzed so far - used to bootstrap the dashboard before its SSE connection delivers the first live update. */
  getLatestOverview(): CameraAnalysisOverview[] {
    // A camera the settings leave out keeps its last stored row, which would show as a stale live badge.
    return Array.from(this.latestOverview.values()).filter((overview) => !this.excluded.has(overview.cameraId));
  }

  /**
   * A recent frame from this camera as a JPEG (at most
   * `thumbnailIntervalMs` older than the newest analyzed frame), or null if
   * none yet / not an active camera. Comes from the capture already running
   * for analysis, so a thumbnail costs no extra ffmpeg process.
   */
  getLatestFrame(cameraId: string): { buffer: Buffer; capturedAt: string } | null {
    return this.cameraStates.get(cameraId)?.latestFrame ?? null;
  }

  /**
   * This camera's per-frame results from the last `recentResultsMs`, oldest
   * first. The live player shows a picture some seconds older than the frame
   * analysis is working on, and draws each result only when the video
   * reaches that result's `streamTime` - so a viewer who has just connected
   * needs the results already produced for the stretch of video it is about
   * to play, not only the ones that arrive from now on.
   */
  getRecentResults(cameraId: string): CameraAnalysisResult[] {
    return [...(this.cameraStates.get(cameraId)?.recentResults ?? [])];
  }

  /**
   * How the fleet-wide analysis is keeping up, for the Admin page: the
   * shared job queue, and per camera the analyzed frame rate, time per
   * frame, how fast the stream advances against the clock, and its
   * capture's restart/stall/drop counters.
   */
  getMetrics(): { activeJobs: number; queuedJobs: number; maxConcurrency: number; cameras: CameraAnalysisMetrics[] } {
    const cameras = Array.from(this.cameraStates.values()).map((state): CameraAnalysisMetrics => {
      const { fps, avgMs, streamRatio } = state.throughput.snapshot();
      return {
        cameraId: state.camera.id,
        name: state.camera.name,
        fps,
        avgMs,
        streamRatio,
        errors: state.errors.snapshot().count,
        capture: state.capture?.counters?.() ?? null,
      };
    });
    return { activeJobs: this.activeJobs, queuedJobs: this.queue.length, maxConcurrency: this.options.maxConcurrency, cameras };
  }

  getHistory(cameraId: string, options?: { sinceIso?: string; limit?: number }): StoredAnalysisResult[] {
    return this.historyStore.getHistory(cameraId, options);
  }

  /**
   * Subscribes to every frame's full result for a single camera. Returns an
   * unsubscribe function. An active camera the settings leave out is
   * analyzed anyway while it has viewers (Bane's call: the camera page should
   * always show live analysis), and stops `VIEWER_LINGER_MS` after the last
   * one leaves - so a reload doesn't throw away what it has learned.
   */
  subscribeCameraDetail(cameraId: string, callback: ResultSubscriber): () => void {
    const existing = this.resultSubscribers.get(cameraId);
    const subs = existing ?? new Set<ResultSubscriber>();
    if (!existing) this.resultSubscribers.set(cameraId, subs);
    subs.add(callback);

    const linger = this.viewerLinger.get(cameraId);
    if (linger !== undefined) {
      this.options.scheduler.clearTimeout(linger);
      this.viewerLinger.delete(cameraId);
    }
    const leftOut = this.excluded.get(cameraId);
    if (this.running && leftOut && !this.cameraStates.has(cameraId)) this.addCamera(leftOut, 0);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      subs.delete(callback);
      // Drop the (now empty) set rather than leaving an entry per camera id
      // ever subscribed to - including ids that don't exist in the registry.
      if (subs.size === 0 && this.resultSubscribers.get(cameraId) === subs) {
        this.resultSubscribers.delete(cameraId);
        if (this.excluded.has(cameraId) && this.cameraStates.has(cameraId)) this.scheduleViewedStop(cameraId);
      }
    };
  }

  /** Stops a left-out camera analyzed only for its viewers, unless one is back by then. */
  private scheduleViewedStop(cameraId: string): void {
    const handle = this.options.scheduler.setTimeout(() => {
      if (this.viewerLinger.get(cameraId) !== handle) return;
      this.viewerLinger.delete(cameraId);
      const state = this.cameraStates.get(cameraId);
      if (state && this.excluded.has(cameraId) && !this.isViewed(cameraId)) this.removeCamera(state);
    }, VIEWER_LINGER_MS);
    this.viewerLinger.set(cameraId, handle);
  }

  /** Subscribes to the lightweight dashboard-wide overview feed. Returns an unsubscribe function. */
  subscribeOverview(callback: OverviewSubscriber): () => void {
    this.overviewSubscribers.add(callback);
    return () => this.overviewSubscribers.delete(callback);
  }

  private startCamera(state: CameraState): void {
    state.startHandle = null;
    if (!this.running || this.cameraStates.get(state.camera.id) !== state) return;
    const capture = this.frameGrabber.openCapture(state.camera);
    state.capture = capture;
    const loop = this.runLoop(state, capture)
      // Anything escaping the loop's own handling must not go silent - see `processFrame`.
      .catch((err) => console.error(`[TrafficAnalysisService] loop for camera "${state.camera.id}" failed:`, err))
      .finally(() => this.loops.delete(loop));
    this.loops.add(loop);
  }

  /**
   * One camera's analysis loop: take the next frame, analyze it, publish,
   * repeat - until the service stops. A failed frame (capture timed out,
   * stream down and reconnecting) is published as an error result and the
   * loop simply asks again; the capture handles reconnection itself, and
   * `next()` waits rather than spinning while it does.
   */
  private async runLoop(state: CameraState, capture: FrameCapture): Promise<void> {
    while (this.running && state.capture === capture) {
      const frame = await capture.next();
      if (!this.running || state.capture !== capture) return;
      await this.enqueue(() => this.processFrame(state, frame));
    }
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const run = () => {
        this.activeJobs += 1;
        job()
          // A failure escaping `processFrame` (e.g. a bug in a subscriber
          // path) must not kill the camera's loop or go completely silent.
          .catch((err) => console.error('[TrafficAnalysisService] frame failed:', err))
          .finally(() => {
            this.activeJobs -= 1;
            resolve();
            const next = this.queue.shift();
            if (next) next();
          });
      };

      if (this.activeJobs < this.options.maxConcurrency) {
        run();
      } else {
        this.queue.push(run);
      }
    });
  }

  private async processFrame(state: CameraState, frame: GrabFrameResult): Promise<void> {
    // A camera stopped by `reload()` while this frame waited for a slot is gone - its analyzer is disposed.
    if (!this.isCurrent(state)) return;
    // A frame's own capture time is its timestamp - not when analysis got
    // round to it - since that's what the tracker's motion model runs on.
    const timestamp = frame.ok ? new Date(frame.capturedAt).toISOString() : this.options.now().toISOString();
    if (frame.ok) this.refreshThumbnail(state, frame.frame, frame.capturedAt);
    const startedAt = Date.now();
    const analyzed = frame.ok
      ? await state.analyzer.analyze(frame.frame, timestamp)
      : state.analyzer.errorResult(timestamp, frame.error);
    if (!this.isCurrent(state)) return;
    if (frame.ok) state.throughput.record(Date.now() - startedAt, frame.streamTime);
    else state.errors.record(0);
    // The analyzer doesn't need to know which stream moment a frame was; the
    // overlay does, to line the result up with the picture.
    const result = frame.ok && frame.streamTime !== undefined ? { ...analyzed, streamTime: frame.streamTime } : analyzed;
    this.rememberRecent(state, result);

    const usable = !result.error && !result.warmingUp;
    if (usable) {
      this.recordHistory(state, result);
      if (this.options.onResult) notify(this.options.onResult, result);
    }
    this.publish(state, result, usable);
  }

  private rememberRecent(state: CameraState, result: CameraAnalysisResult): void {
    const recent = state.recentResults;
    recent.push(result);
    const cutoff = Date.parse(result.timestamp) - this.options.recentResultsMs;
    let stale = 0;
    while (stale < recent.length && Date.parse(recent[stale].timestamp) < cutoff) stale += 1;
    if (stale > 0) recent.splice(0, stale);
  }

  /**
   * Starts encoding this frame as the camera's thumbnail if the current one
   * is older than `thumbnailIntervalMs`. Not awaited: the analysis loop must
   * not wait on an image only a dashboard will look at, and a failed encode
   * just leaves the previous thumbnail in place.
   */
  private refreshThumbnail(state: CameraState, frame: VideoFrame, capturedAt: number): void {
    if (capturedAt - state.thumbnailStartedAt < this.options.thumbnailIntervalMs) return;
    state.thumbnailStartedAt = capturedAt;
    this.options
      .encodeThumbnail(frame)
      .then((buffer) => {
        // Encodes can finish out of order; never replace a newer thumbnail.
        const current = state.latestFrame ? Date.parse(state.latestFrame.capturedAt) : -Infinity;
        if (capturedAt >= current) state.latestFrame = { buffer, capturedAt: new Date(capturedAt).toISOString() };
      })
      .catch((err) => console.error(`[TrafficAnalysisService] thumbnail for camera "${state.camera.id}" failed:`, err));
  }

  /**
   * Accumulates this frame's count into the camera's current history
   * window, writing one row (mean count, latest badge) once the window has
   * run for `historyIntervalMs`.
   */
  private recordHistory(state: CameraState, result: CameraAnalysisResult): void {
    const window = state.historyWindow;
    window.counts.push(result.totalCount);
    window.lastResult = result;

    const nowMs = Date.parse(result.timestamp);
    if (nowMs - window.startedAt < this.options.historyIntervalMs) return;

    const mean = window.counts.reduce((a, b) => a + b, 0) / window.counts.length;
    state.historyWindow = { startedAt: nowMs, counts: [], lastResult: null };
    // A persistence failure must not lose the live update.
    try {
      this.historyStore.record({
        cameraId: result.cameraId,
        timestamp: result.timestamp,
        totalCount: Math.round(mean),
        trafficLevel: result.trafficLevel,
      });
    } catch (err) {
      console.error(`[TrafficAnalysisService] failed to persist result for camera "${state.camera.id}":`, err);
    }
  }

  private publish(state: CameraState, result: CameraAnalysisResult, usable: boolean): void {
    const subs = this.resultSubscribers.get(result.cameraId);
    subs?.forEach((cb) => notify(cb, result));

    // A warm-up frame says nothing about the road - keep showing the last
    // real overview rather than replacing it with a zero.
    if (!usable && !result.error) return;

    const overview: CameraAnalysisOverview = {
      cameraId: result.cameraId,
      timestamp: result.timestamp,
      totalCount: result.totalCount,
      trafficLevel: result.trafficLevel,
      ...(result.occupancy === undefined ? {} : { occupancy: result.occupancy }),
      error: result.error,
    };
    const previous = this.latestOverview.get(result.cameraId);
    this.latestOverview.set(result.cameraId, overview);

    const changed = !previous || previous.trafficLevel !== overview.trafficLevel || previous.error !== overview.error;
    const nowMs = this.options.now().getTime();
    if (!changed && nowMs - state.lastOverviewAt < this.options.overviewIntervalMs) return;
    state.lastOverviewAt = nowMs;
    this.overviewSubscribers.forEach((cb) => notify(cb, overview));
  }
}

/**
 * Delivers a payload to one subscriber, containing any failure.
 *
 * Subscribers are SSE writers on connections that can drop at any moment.
 * Letting one throw would abandon every subscriber after it in the set for
 * that tick, and unwind into the tick itself - so a single dead dashboard
 * connection could stop a camera's results reaching everyone else.
 */
function notify<T>(callback: (payload: T) => void, payload: T): void {
  try {
    callback(payload);
  } catch {
    // A broken subscriber must not affect the others, or the tick.
  }
}

