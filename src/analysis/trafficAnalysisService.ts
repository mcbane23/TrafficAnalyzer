import { CameraEntry } from '../types/camera';
import { CameraSource } from '../server/cameraService';
import { CameraAnalysisOverview, CameraAnalysisResult, StoredAnalysisResult } from '../types/analysis';
import { FrameCapture, GrabFrameResult } from './frameGrabber';
import { CameraAnalyzer } from './cameraAnalyzer';

/** Narrow seam over FrameGrabber so tests can inject a fake without spawning ffmpeg. */
export interface FrameGrabberLike {
  /** One frame from a one-off process - used for a camera's single background pass. */
  grabFrame(camera: CameraEntry): Promise<GrabFrameResult>;
  /** A continuously-decoding capture, held for as long as a camera is being watched. The caller must close it. */
  openCapture(camera: CameraEntry): FrameCapture;
}

/**
 * Narrow seam over `CameraAnalyzer` - everything that turns one camera's
 * frame into one result, including all of that camera's learned state.
 * This is the single seam that used to be a detector, a tracker and an
 * occupancy estimator injected separately.
 */
export interface CameraAnalyzerLike {
  analyze(frame: Buffer, timestamp: string): Promise<CameraAnalysisResult>;
  /** The result for a tick whose frame never arrived - the analyzer owns this camera's result shape either way. */
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
   * Delay, in ms, before an active camera's one-time initial analysis pass
   * (used to stagger those passes on `start()` - see
   * `STARTUP_STAGGER_STEP_MS`) and the retry delay when that one-time pass
   * has to be skipped because another camera is currently being watched
   * (see `runTick`). Defaults to 10000 (10s). Despite the name, this is no
   * longer a repeating sampling interval - see the class docstring.
   */
  backgroundIntervalMs?: number;
  /**
   * How often a camera with at least one detail-page subscriber is sampled,
   * in ms. Defaults to 200 (~5fps) - `MotionDetector.detect` runs in
   * ~20-40ms (background-subtraction over a downscaled frame, not a model
   * inference pass), and a boosted tick's frame grab is a near-instant
   * dequeue from the camera's already-warm streaming capture (see
   * `FrameGrabber`'s streaming mode), so the cadence here is limited by how
   * often the client should redraw, not by how long a tick takes.
   */
  boostedIntervalMs?: number;
  /**
   * Max number of camera ticks in flight at once. Defaults to 6.
   *
   * This is effectively a *capture* limit. A tick is dominated by its frame
   * grab - measured at 0.9-2.7s of ffmpeg reconnecting to an HLS stream,
   * against ~70ms per inference pass - and that wait is pure network I/O.
   * Inference is bounded separately, inside the ONNX runner, which knows the
   * thread budget; gating both here with one small number meant a few
   * cameras sitting in network wait left the CPU idle.
   */
  maxConcurrency?: number;
  /**
   * Builds one camera's analyzer. A factory, not a shared instance: an
   * analyzer holds that camera's background model, tracks and learned
   * roadway, all of which describe a single fixed viewpoint and are
   * meaningless shared across cameras. Defaults to a real `CameraAnalyzer`.
   */
  createAnalyzer?: (cameraId: string) => CameraAnalyzerLike;
  now?: () => Date;
  scheduler?: AnalysisScheduler;
}

type ResultSubscriber = (result: CameraAnalysisResult) => void;
type OverviewSubscriber = (overview: CameraAnalysisOverview) => void;

/**
 * Everything this service tracks about one camera, including the analyzer
 * holding that camera's learned state. One record per camera, created in
 * `start()` and dropped in `stop()` - there is deliberately no second map
 * keyed by camera id with a different lifetime.
 */
interface CameraTickState {
  camera: CameraEntry;
  analyzer: CameraAnalyzerLike;
  /**
   * This camera's open continuous capture, held only while it's being
   * watched. Owning the object (rather than remembering to call a
   * stop-by-id method later) is what makes the ffmpeg process impossible to
   * leave running by accident: it's dropped everywhere this state is.
   */
  capture: FrameCapture | null;
  subscriberCount: number;
  timeoutHandle: unknown;
  /** Whether this camera has completed at least one analysis pass since `start()` - see `runTick`. */
  analyzed: boolean;
}

const DEFAULTS = {
  backgroundIntervalMs: 10_000,
  boostedIntervalMs: 200,
  maxConcurrency: 6,
};

/**
 * Spacing between each active camera's very first tick on `start()`. Without
 * this, every camera's tick fires at the same instant (delay 0), so all of
 * them spawn ffmpeg against their stream at once - observed in practice to
 * make a chunk of that first batch fail ("frame capture timed out") purely
 * from the burst itself (OS/process-launch contention, and several cameras
 * sharing the same small upstream relay all connecting simultaneously),
 * even though each one succeeds comfortably in isolation. Spreading the
 * first tick out avoids the burst; it's capped by `backgroundIntervalMs` so
 * no camera's first sample is delayed past its normal cadence anyway.
 */
const STARTUP_STAGGER_STEP_MS = 400;

/**
 * TrafficAnalysisService is the central orchestrator for the vehicle
 * traffic analysis feature.
 *
 * For every camera whose registry `status` is `active`, it runs one tick
 * (grab a frame -> detect moving vehicles -> derive a Light/Moderate/Heavy
 * traffic badge -> persist -> publish) on `start()` and then goes idle -
 * the dashboard overview is a snapshot taken once at load, not a
 * continuously refreshed feed, since running detection against ~20+ live
 * streams on a timer for a grid nobody may be looking at is expensive for
 * a badge that's rarely worth re-computing faster than "whenever the page
 * was last opened". A camera only ticks again once it has at least one
 * detail-page subscriber, for as long as that subscription lasts, at a
 * boosted rate suited to live viewing - then goes back to idle (not back
 * to a repeating background rate) once the last subscriber disconnects,
 * simply keeping its last result and timestamp. While ANY camera is being
 * watched (has a subscriber), every other camera's still-pending one-time
 * pass is skipped for that instant (no frame grab, no detection) and
 * retried shortly after, rather than competing with the camera actually
 * being watched - see `runTick`. Detection work across all cameras is
 * capped by a small concurrency pool so ~20+ cameras' initial passes don't
 * overwhelm the host at once.
 *
 * What this service deliberately does *not* know is how a frame becomes a
 * result. Detection, tracking, occupancy and the Light/Moderate/Heavy
 * derivation are all per-camera stateful, all describe one fixed
 * viewpoint, and all have to be discarded together - so they live behind
 * one `CameraAnalyzer` per camera (see `createAnalyzer`), built in
 * `start()` and disposed in `stop()`. This module hands that analyzer a
 * frame and publishes what comes back.
 *
 * `FrameGrabber`, the per-camera analyzer factory, `TrafficHistoryStore`
 * and the scheduler/clock are all injected as narrow interfaces, so this
 * scheduling/boosting/concurrency/fan-out logic can be unit tested without
 * real frame capture, detection, or timers.
 */
export class TrafficAnalysisService {
  private readonly options: {
    backgroundIntervalMs: number;
    boostedIntervalMs: number;
    maxConcurrency: number;
    createAnalyzer: (cameraId: string) => CameraAnalyzerLike;
    now: () => Date;
    scheduler: AnalysisScheduler;
  };

  private readonly cameraStates = new Map<string, CameraTickState>();
  private readonly resultSubscribers = new Map<string, Set<ResultSubscriber>>();
  private readonly overviewSubscribers = new Set<OverviewSubscriber>();
  private readonly latestOverview = new Map<string, CameraAnalysisOverview>();

  private running = false;
  private activeJobs = 0;
  private readonly queue: Array<() => void> = [];
  /** Number of distinct cameras that currently have at least one detail-page subscriber. */
  private boostedCameraCount = 0;

  constructor(
    private readonly source: CameraSource,
    private readonly frameGrabber: FrameGrabberLike,
    private readonly historyStore: TrafficHistoryStoreLike,
    options: TrafficAnalysisServiceOptions = {},
  ) {
    this.options = {
      backgroundIntervalMs: options.backgroundIntervalMs ?? DEFAULTS.backgroundIntervalMs,
      boostedIntervalMs: options.boostedIntervalMs ?? DEFAULTS.boostedIntervalMs,
      maxConcurrency: options.maxConcurrency ?? DEFAULTS.maxConcurrency,
      createAnalyzer: options.createAnalyzer ?? ((cameraId) => new CameraAnalyzer(cameraId)),
      now: options.now ?? (() => new Date()),
      scheduler: options.scheduler ?? defaultScheduler,
    };

    for (const result of this.historyStore.getLatestForAllCameras()) {
      this.latestOverview.set(result.cameraId, {
        cameraId: result.cameraId,
        timestamp: result.timestamp,
        totalCount: result.totalCount,
        trafficLevel: result.trafficLevel,
      });
    }
  }

  /** Loads the current camera registry and runs each active camera's one-time initial analysis pass. Inactive cameras are skipped entirely. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const entries = await this.source.load();
    let activeIndex = 0;
    for (const camera of entries) {
      if (camera.status !== 'active') continue;
      this.cameraStates.set(camera.id, {
        camera,
        analyzer: this.options.createAnalyzer(camera.id),
        capture: null,
        subscriberCount: 0,
        timeoutHandle: null,
        analyzed: false,
      });
      const startupDelayMs = Math.min(activeIndex * STARTUP_STAGGER_STEP_MS, this.options.backgroundIntervalMs);
      this.scheduleTick(camera.id, startupDelayMs);
      activeIndex += 1;
    }
  }

  stop(): void {
    this.running = false;
    for (const state of this.cameraStates.values()) {
      if (state.timeoutHandle !== null) {
        this.options.scheduler.clearTimeout(state.timeoutHandle);
      }
      this.closeCapture(state);
      // Everything this camera had learned goes with its analyzer - see
      // `CameraAnalyzer.dispose`.
      state.analyzer.dispose();
    }
    this.cameraStates.clear();
  }

  /** Latest known overview (count + traffic level) for every camera analyzed so far - used to bootstrap the dashboard before its SSE connection delivers the first live update. */
  getLatestOverview(): CameraAnalysisOverview[] {
    return Array.from(this.latestOverview.values());
  }

  getHistory(cameraId: string, options?: { sinceIso?: string; limit?: number }): StoredAnalysisResult[] {
    return this.historyStore.getHistory(cameraId, options);
  }

  /**
   * Subscribes to full per-tick results for a single camera. While this
   * subscription (or any other for the same camera) is active, that
   * camera's sampling rate is boosted. Returns an unsubscribe function
   * that reverts the boost once the last subscriber for that camera is
   * gone.
   */
  subscribeCameraDetail(cameraId: string, callback: ResultSubscriber): () => void {
    const existing = this.resultSubscribers.get(cameraId);
    const subs = existing ?? new Set<ResultSubscriber>();
    if (!existing) this.resultSubscribers.set(cameraId, subs);
    subs.add(callback);

    const state = this.cameraStates.get(cameraId);
    if (state) {
      if (state.subscriberCount === 0) {
        this.boostedCameraCount += 1;
        // The first subscriber for this camera shouldn't have to wait out
        // whatever's left of its current background-rate timer (up to
        // `backgroundIntervalMs`) before analysis starts responding to them -
        // cut that wait short and tick now, boosted, so opening a camera's
        // detail page starts producing results immediately instead of
        // however many seconds into its existing schedule it happens to land.
        if (state.timeoutHandle !== null) {
          this.options.scheduler.clearTimeout(state.timeoutHandle);
        }
        this.scheduleTick(cameraId, 0);
      }
      state.subscriberCount += 1;
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      subs.delete(callback);
      // Drop the (now empty) set rather than leaving an entry per camera id
      // ever subscribed to - including ids that don't exist in the registry.
      if (subs.size === 0 && this.resultSubscribers.get(cameraId) === subs) {
        this.resultSubscribers.delete(cameraId);
      }
      if (state && state.subscriberCount > 0) {
        state.subscriberCount -= 1;
        if (state.subscriberCount === 0) {
          this.boostedCameraCount = Math.max(0, this.boostedCameraCount - 1);
          // Last detail-page viewer for this camera gone - close its
          // continuous capture rather than leaving it running (and
          // reconnected) in the background until the next boost.
          this.closeCapture(state);
        }
      }
    };
  }

  /** Subscribes to the lightweight dashboard-wide overview feed. Returns an unsubscribe function. */
  subscribeOverview(callback: OverviewSubscriber): () => void {
    this.overviewSubscribers.add(callback);
    return () => this.overviewSubscribers.delete(callback);
  }

  private scheduleTick(cameraId: string, delayOverrideMs?: number): void {
    const state = this.cameraStates.get(cameraId);
    if (!state || !this.running) return;
    const delay = delayOverrideMs ?? (state.subscriberCount > 0 ? this.options.boostedIntervalMs : this.options.backgroundIntervalMs);
    // Note: this returns the runTick() promise even though the scheduler
    // interface types the callback as `() => void` - TypeScript permits a
    // void-returning callback type to be satisfied by a function that
    // returns a value (the same rule that allows `arr.forEach(async fn)`),
    // and the real return value lets tests await a fired tick to
    // completion via the fake scheduler.
    state.timeoutHandle = this.options.scheduler.setTimeout(() => this.runTick(cameraId), delay);
  }

  private async runTick(cameraId: string): Promise<void> {
    const state = this.cameraStates.get(cameraId);
    if (!state || !this.running) return;
    // A boosted tick (an open detail-page subscriber) differs only in how the
    // frame is captured - it reuses the camera's warm streaming capture. It
    // used to also drop to a cheaper detection pass to stay responsive, which
    // made the live detail page - the one view users judge this feature by -
    // the least accurate configuration in the system. MotionDetector's pass
    // costs ~20-40ms regardless of mode, well inside the boosted cadence, so
    // both paths now detect identically.
    const boosted = state.subscriberCount > 0;
    if (!boosted && this.boostedCameraCount > 0) {
      // Someone is actively watching a different camera's detail page right
      // now - skip analysing this unwatched camera entirely (no frame grab,
      // no inference) so all available capacity goes to the camera actually
      // being watched. If this camera hasn't produced even its one-time
      // initial result yet, retry shortly once that capacity frees up
      // rather than leaving it with nothing to show; a camera that's
      // already been analyzed once has nothing left to do here and simply
      // goes idle, keeping its last result until someone watches it.
      if (!state.analyzed) {
        this.scheduleTick(cameraId);
      } else {
        state.timeoutHandle = null;
      }
      return;
    }
    await this.enqueue(() => this.analyzeCamera(state, boosted));
    state.analyzed = true;
    // Keep ticking only for as long as this camera is actively being
    // watched - see the class docstring. Once the last subscriber
    // disconnects, `state.subscriberCount` is back to 0 by the time this
    // check runs (or will be shortly after this tick's frame capture, at
    // worst one trailing tick later), so this naturally settles back to
    // idle instead of resuming a repeating background sample.
    if (state.subscriberCount > 0) {
      this.scheduleTick(cameraId);
    } else {
      state.timeoutHandle = null;
    }
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const run = () => {
        this.activeJobs += 1;
        job()
          // Any failure that escapes `analyzeCamera`'s own try/catches (e.g. a
          // bug in a detector/estimator constructor) must not go completely
          // silent - it previously did, which is exactly how a persistence
          // bug once stopped every tick from ever reaching `publish()` with
          // nothing in the logs to point at why.
          .catch((err) => console.error('[TrafficAnalysisService] tick failed:', err))
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

  private async analyzeCamera(state: CameraTickState, boosted: boolean): Promise<void> {
    const timestamp = this.options.now().toISOString();

    // Boosted ticks pull from the camera's open continuous capture
    // (near-instant, already-warm frame) so the boosted cadence is actually
    // achievable; background ticks use a one-off capture since they run
    // once per camera and shouldn't hold an ffmpeg process open at all.
    const frame = boosted ? await this.captureFor(state).next() : await this.frameGrabber.grabFrame(state.camera);
    const result = frame.ok
      ? await state.analyzer.analyze(frame.buffer, timestamp)
      : state.analyzer.errorResult(timestamp, frame.error);

    // A failed tick is published but never persisted: its zeroed count and
    // "light" badge describe a capture/detection failure, not an empty road,
    // and writing those to history would show up in the trend view as
    // genuine quiet traffic. Subscribers get it because a live viewer needs
    // to know the feed is broken; history doesn't, because it can't tell the
    // difference afterwards.
    if (!result.error) {
      // A persistence failure must not lose the live update - subscribers
      // still care about seeing the current frame's result even if it
      // couldn't be written to history.
      try {
        this.historyStore.record({
          cameraId: result.cameraId,
          timestamp: result.timestamp,
          totalCount: result.totalCount,
          trafficLevel: result.trafficLevel,
        });
      } catch (err) {
        console.error(`[TrafficAnalysisService] failed to persist result for camera "${state.camera.id}":`, err);
      }
    }
    this.publish(result);
  }

  /** This camera's open capture, started on the first boosted tick that needs one. */
  private captureFor(state: CameraTickState): FrameCapture {
    const existing = state.capture;
    if (existing) return existing;
    const opened = this.frameGrabber.openCapture(state.camera);
    state.capture = opened;
    return opened;
  }

  /** Closes and forgets this camera's capture, if one is open. Safe to call when there isn't. */
  private closeCapture(state: CameraTickState): void {
    state.capture?.close();
    state.capture = null;
  }

  private publish(result: CameraAnalysisResult): void {
    const subs = this.resultSubscribers.get(result.cameraId);
    subs?.forEach((cb) => notify(cb, result));

    const overview: CameraAnalysisOverview = {
      cameraId: result.cameraId,
      timestamp: result.timestamp,
      totalCount: result.totalCount,
      trafficLevel: result.trafficLevel,
      ...(result.occupancy === undefined ? {} : { occupancy: result.occupancy }),
      error: result.error,
    };
    this.latestOverview.set(result.cameraId, overview);
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
