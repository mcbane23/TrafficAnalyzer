import { CameraEntry } from '../types/camera';
import { CameraSource } from '../server/cameraService';
import {
  BoundingBox,
  CameraAnalysisOverview,
  CameraAnalysisResult,
  StoredAnalysisResult,
  TrafficLevel,
  VehicleDetection,
  emptyClassCounts,
} from '../types/analysis';
import { GrabFrameOptions, GrabFrameResult } from './frameGrabber';
import { VehicleTracker } from './vehicleTracker';

/** Narrow seam over FrameGrabber so tests can inject a fake without spawning ffmpeg. */
export interface FrameGrabberLike {
  grabFrame(camera: CameraEntry, options?: GrabFrameOptions): Promise<GrabFrameResult>;
  /** Stops a camera's persistent streaming capture (if any) started via `grabFrame(camera, { streaming: true })`. Optional so simple test fakes don't need to implement it. */
  stopStreaming?(cameraId: string): void;
}

/** Narrow seam over VehicleDetector so tests can inject canned detections without loading a real model. */
export interface VehicleDetectorLike {
  detect(frameBuffer: Buffer, options?: { fastMode?: boolean }): Promise<VehicleDetection[]>;
}

/** Narrow seam over VehicleColorEstimator. */
export interface VehicleColorEstimatorLike {
  estimateColor(frameBuffer: Buffer, box: BoundingBox): Promise<string>;
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
  /** How often an unwatched active camera is sampled, in ms. Defaults to 10000 (10s). */
  backgroundIntervalMs?: number;
  /** How often a camera with at least one detail-page subscriber is sampled, in ms. Defaults to 500 (~2fps). */
  boostedIntervalMs?: number;
  /** Max number of frame-grab+detect jobs running concurrently across all cameras. Defaults to 3. */
  maxConcurrency?: number;
  /** Total vehicle count at/above which the traffic-level badge becomes "moderate". Defaults to 6. */
  moderateThreshold?: number;
  /** Total vehicle count at/above which the traffic-level badge becomes "heavy". Defaults to 15. */
  heavyThreshold?: number;
  now?: () => Date;
  scheduler?: AnalysisScheduler;
}

type ResultSubscriber = (result: CameraAnalysisResult) => void;
type OverviewSubscriber = (overview: CameraAnalysisOverview) => void;

interface CameraTickState {
  camera: CameraEntry;
  subscriberCount: number;
  timeoutHandle: unknown;
}

const DEFAULTS = {
  backgroundIntervalMs: 10_000,
  boostedIntervalMs: 500,
  maxConcurrency: 3,
  moderateThreshold: 6,
  heavyThreshold: 15,
};

/**
 * TrafficAnalysisService is the central orchestrator for the vehicle
 * traffic analysis feature.
 *
 * For every camera whose registry `status` is `active`, it runs a
 * repeating tick (grab a frame -> detect vehicles -> estimate colors ->
 * aggregate per-class counts -> derive a Light/Moderate/Heavy traffic
 * badge -> persist -> publish) at a low background rate by default. While
 * a camera has at least one active detail-page subscription, its
 * effective sampling rate is boosted for as long as the subscription
 * lasts, then reverts once the last subscriber disconnects. While ANY
 * camera is being watched (has a subscriber), every other, unwatched
 * camera's tick is skipped entirely (no frame grab, no inference) rather
 * than running at its normal background rate - CPU inference is
 * expensive enough that watching one camera closely should not be
 * competing with background sampling of ~20+ others. Unwatched cameras
 * resume their background rate as soon as no camera is being watched.
 * Inference work across all cameras is capped by a small concurrency
 * pool so ~20+ cameras don't overwhelm the host.
 *
 * `FrameGrabber`, `VehicleDetector`, `VehicleColorEstimator`,
 * `TrafficHistoryStore`, and the scheduler/clock are all injected as
 * narrow interfaces, so this scheduling/boosting/concurrency/derivation
 * logic can be unit tested without real frame capture, inference, or
 * timers.
 */
export class TrafficAnalysisService {
  private readonly options: {
    backgroundIntervalMs: number;
    boostedIntervalMs: number;
    maxConcurrency: number;
    moderateThreshold: number;
    heavyThreshold: number;
    now: () => Date;
    scheduler: AnalysisScheduler;
  };

  private readonly cameraStates = new Map<string, CameraTickState>();
  private readonly trackers = new Map<string, VehicleTracker>();
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
    private readonly detector: VehicleDetectorLike,
    // Accepted for API/wiring stability but currently unused - color
    // estimation is disabled for now (see analyzeCamera) since it slowed
    // down every tick. Kept positional so it's a one-line change to
    // re-enable later without touching call sites.
    _colorEstimator: VehicleColorEstimatorLike,
    private readonly historyStore: TrafficHistoryStoreLike,
    options: TrafficAnalysisServiceOptions = {},
  ) {
    this.options = {
      backgroundIntervalMs: options.backgroundIntervalMs ?? DEFAULTS.backgroundIntervalMs,
      boostedIntervalMs: options.boostedIntervalMs ?? DEFAULTS.boostedIntervalMs,
      maxConcurrency: options.maxConcurrency ?? DEFAULTS.maxConcurrency,
      moderateThreshold: options.moderateThreshold ?? DEFAULTS.moderateThreshold,
      heavyThreshold: options.heavyThreshold ?? DEFAULTS.heavyThreshold,
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

  /** Loads the current camera registry and begins background sampling for every active camera. Inactive cameras are skipped entirely. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const entries = await this.source.load();
    for (const camera of entries) {
      if (camera.status !== 'active') continue;
      this.cameraStates.set(camera.id, { camera, subscriberCount: 0, timeoutHandle: null });
      this.trackers.set(camera.id, new VehicleTracker());
      this.scheduleTick(camera.id, 0);
    }
  }

  stop(): void {
    this.running = false;
    for (const state of this.cameraStates.values()) {
      if (state.timeoutHandle !== null) {
        this.options.scheduler.clearTimeout(state.timeoutHandle);
      }
      this.frameGrabber.stopStreaming?.(state.camera.id);
    }
    this.cameraStates.clear();
    this.trackers.clear();
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
    let subs = this.resultSubscribers.get(cameraId);
    if (!subs) {
      subs = new Set();
      this.resultSubscribers.set(cameraId, subs);
    }
    subs.add(callback);

    const state = this.cameraStates.get(cameraId);
    if (state) {
      if (state.subscriberCount === 0) this.boostedCameraCount += 1;
      state.subscriberCount += 1;
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      subs?.delete(callback);
      if (state && state.subscriberCount > 0) {
        state.subscriberCount -= 1;
        if (state.subscriberCount === 0) {
          this.boostedCameraCount = Math.max(0, this.boostedCameraCount - 1);
          // Last detail-page viewer for this camera gone - tear down its
          // persistent streaming capture rather than leaving it running
          // (and reconnected) in the background until the next boost.
          this.frameGrabber.stopStreaming?.(cameraId);
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
    // A boosted tick (an open detail-page subscriber) runs at up to 2fps, so
    // it skips the multi-tile detection grid (fastMode) to stay responsive;
    // the much less frequent background tick keeps full tiling for recall.
    const boosted = state.subscriberCount > 0;
    if (!boosted && this.boostedCameraCount > 0) {
      // Someone is actively watching a different camera's detail page right
      // now - skip analysing this unwatched camera entirely (no frame grab,
      // no inference) so all available capacity goes to the camera actually
      // being watched. Still reschedule at the normal background cadence so
      // this camera resumes promptly once nothing else is being watched.
      this.scheduleTick(cameraId);
      return;
    }
    await this.enqueue(() => this.analyzeCamera(state.camera, boosted));
    this.scheduleTick(cameraId);
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const run = () => {
        this.activeJobs += 1;
        job()
          .catch(() => undefined)
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

  private async analyzeCamera(camera: CameraEntry, fastMode: boolean): Promise<void> {
    const timestamp = this.options.now().toISOString();

    // Boosted ticks use the persistent streaming capture (near-instant,
    // already-warm frame) so the ~2-3fps boosted cadence is actually
    // achievable; background ticks use the simple one-off capture since
    // they only run every ~10s per camera and shouldn't hold an ffmpeg
    // process open the whole time.
    const frame = await this.frameGrabber.grabFrame(camera, { streaming: fastMode });
    if (!frame.ok) {
      this.publish(this.errorResult(camera.id, timestamp, frame.error));
      return;
    }

    let detections: VehicleDetection[];
    try {
      const rawDetections = await this.detector.detect(frame.buffer, { fastMode });
      // Color estimation is disabled for now: it added a per-detection sharp
      // crop+resize cost (compounding with detection count) that meaningfully
      // slowed down every tick without being needed yet. Re-enable by mapping
      // rawDetections through a VehicleColorEstimator's `estimateColor` again
      // once that cost is worth paying (see the `_colorEstimator` constructor
      // parameter above).
      // that cost is worth paying.
      const tracker = this.trackers.get(camera.id);
      detections = tracker ? tracker.update(rawDetections) : rawDetections;
    } catch (err) {
      this.publish(this.errorResult(camera.id, timestamp, err instanceof Error ? err.message : 'Detection failed'));
      return;
    }

    const countsByClass = emptyClassCounts();
    for (const detection of detections) {
      countsByClass[detection.class] += 1;
    }
    const totalCount = detections.length;
    const trafficLevel = this.deriveTrafficLevel(totalCount);

    const result: CameraAnalysisResult = {
      cameraId: camera.id,
      timestamp,
      totalCount,
      countsByClass,
      trafficLevel,
      detections,
    };

    this.historyStore.record({ cameraId: camera.id, timestamp, totalCount, countsByClass, trafficLevel });
    this.publish(result);
  }

  private errorResult(cameraId: string, timestamp: string, error: string): CameraAnalysisResult {
    return {
      cameraId,
      timestamp,
      totalCount: 0,
      countsByClass: emptyClassCounts(),
      trafficLevel: 'light',
      detections: [],
      error,
    };
  }

  private deriveTrafficLevel(totalCount: number): TrafficLevel {
    if (totalCount >= this.options.heavyThreshold) return 'heavy';
    if (totalCount >= this.options.moderateThreshold) return 'moderate';
    return 'light';
  }

  private publish(result: CameraAnalysisResult): void {
    const subs = this.resultSubscribers.get(result.cameraId);
    subs?.forEach((cb) => cb(result));

    const overview: CameraAnalysisOverview = {
      cameraId: result.cameraId,
      timestamp: result.timestamp,
      totalCount: result.totalCount,
      trafficLevel: result.trafficLevel,
      error: result.error,
    };
    this.latestOverview.set(result.cameraId, overview);
    this.overviewSubscribers.forEach((cb) => cb(overview));
  }
}
