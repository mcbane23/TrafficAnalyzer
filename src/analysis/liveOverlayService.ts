import { CameraEntry } from '../types/camera';
import { CameraSource } from '../server/cameraService';
import { LiveOverlayResult } from '../types/analysis';
import { VehicleDetectorLike, VehicleTrackerLike } from './cameraAnalyzer';
import { AnalysisScheduler, FrameGrabberLike } from './trafficAnalysisService';
import { FrameCapture } from './frameGrabber';
import { ThroughputWindow } from './throughputWindow';
import { OverlayCameraMetrics } from '../types/admin';

/** One watched camera's detector and tracker - built when the first viewer arrives, dropped when the last one leaves. */
export interface OverlayPipeline {
  detector: VehicleDetectorLike;
  tracker: VehicleTrackerLike;
}

export interface LiveOverlayServiceOptions {
  /**
   * Cameras that may run at once. Defaults to 2. Each costs a decode at the
   * detector's resolution plus an appearance-model inference per frame -
   * roughly half a core on the target host - so a third viewer on a third
   * camera is told the overlay is unavailable (and falls back to the motion
   * boxes) rather than starving the fleet-wide analysis.
   */
  maxCameras?: number;
  /**
   * How long (ms) a camera's pipeline keeps running after its last viewer
   * leaves. Defaults to 15000, so a page reload or a quick back-and-forth
   * doesn't pay for a fresh ffmpeg start (several seconds of HLS probing).
   */
  idleStopMs?: number;
  /** How much of each camera's recent results (ms, by capture time) a new viewer is sent first. Defaults to 45000 - see `TrafficAnalysisService.getRecentResults`. */
  recentResultsMs?: number;
  scheduler?: AnalysisScheduler;
}

type OverlaySubscriber = (result: LiveOverlayResult) => void;

interface WatchedCamera {
  camera: CameraEntry;
  capture: FrameCapture;
  pipeline: OverlayPipeline;
  subscribers: Set<OverlaySubscriber>;
  recent: LiveOverlayResult[];
  stopHandle: unknown;
  /** Frames analyzed, detection time spent and stream time covered since the last throughput log line. */
  stats: OverlayStats;
  /** The same figures over the last few seconds, for the Admin page. */
  throughput: ThroughputWindow;
}

interface OverlayStats {
  since: number;
  frames: number;
  detectMs: number;
  vehicles: number;
  /** Stream time of the first and latest frame in this window, and when (wall clock) the first one was analyzed. */
  firstStreamTime?: number;
  firstStreamAt?: number;
  lastStreamTime?: number;
}

const DEFAULTS = {
  maxCameras: 2,
  idleStopMs: 15_000,
  recentResultsMs: 45_000,
};

const THROUGHPUT_LOG_MS = 60_000;

const defaultScheduler: AnalysisScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * LiveOverlayService produces the vehicle boxes drawn over a camera someone
 * is watching, with an appearance-based detector (YOLO), separately from the
 * fleet-wide analysis.
 *
 * The split is a cost decision. Motion detection is nearly free and runs on
 * every camera all the time for statistics, but on screen its failures are
 * obvious: a fountain boxed as a car, a queue of cars as one box. An
 * appearance model fixes both, but on the 4-core target host it can afford
 * one or two cameras, not twenty. So it runs only while a camera has
 * viewers, on its own higher-resolution capture, and stops shortly after
 * the last one leaves. Statistics never see its output.
 *
 * Every result carries the frame's `streamTime`, so the player can draw it
 * over the matching picture; a viewer is first sent the recent results it
 * will need for the video it is about to play.
 *
 * Capture, the per-camera detector/tracker and timers are injected, so the
 * lifecycle (start on first viewer, linger, cap) is tested without ffmpeg
 * or a model.
 */
export class LiveOverlayService {
  private readonly maxCameras: number;
  private readonly idleStopMs: number;
  private readonly recentResultsMs: number;
  private readonly scheduler: AnalysisScheduler;
  private readonly watched = new Map<string, WatchedCamera>();
  /** Cameras whose registry lookup is in flight, so two viewers arriving together start one pipeline. */
  private readonly starting = new Map<string, Promise<WatchedCamera | string>>();
  private readonly loops = new Set<Promise<void>>();

  constructor(
    private readonly source: CameraSource,
    private readonly frameGrabber: FrameGrabberLike,
    private readonly createPipeline: (camera: CameraEntry) => OverlayPipeline,
    options: LiveOverlayServiceOptions = {},
  ) {
    this.maxCameras = options.maxCameras ?? DEFAULTS.maxCameras;
    this.idleStopMs = options.idleStopMs ?? DEFAULTS.idleStopMs;
    this.recentResultsMs = options.recentResultsMs ?? DEFAULTS.recentResultsMs;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  /**
   * Subscribes to a camera's overlay results, starting its pipeline if this
   * is the first viewer. A camera that can't be served (unknown, inactive,
   * or over `maxCameras`) gets one result carrying `error`, and nothing
   * after it. Returns an unsubscribe function.
   */
  subscribe(cameraId: string, callback: OverlaySubscriber): () => void {
    let unsubscribed = false;
    let entry: WatchedCamera | null = null;

    void this.acquire(cameraId).then((acquired) => {
      if (unsubscribed) {
        if (typeof acquired !== 'string') this.scheduleStopIfIdle(acquired);
        return;
      }
      if (typeof acquired === 'string') {
        notify(callback, { cameraId, timestamp: new Date().toISOString(), detections: [], error: acquired });
        return;
      }
      entry = acquired;
      if (entry.stopHandle !== null) {
        this.scheduler.clearTimeout(entry.stopHandle);
        entry.stopHandle = null;
      }
      entry.subscribers.add(callback);
      for (const result of entry.recent) notify(callback, result);
    });

    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      if (!entry) return;
      entry.subscribers.delete(callback);
      this.scheduleStopIfIdle(entry);
    };
  }

  /** What each watched camera's detector is doing right now, for the Admin page. */
  getMetrics(): { maxCameras: number; cameras: OverlayCameraMetrics[] } {
    const cameras = Array.from(this.watched.values()).map((entry): OverlayCameraMetrics => {
      const { fps, avgMs, streamRatio, avgValue } = entry.throughput.snapshot();
      return {
        cameraId: entry.camera.id,
        name: entry.camera.name,
        viewers: entry.subscribers.size,
        fps,
        avgMs,
        streamRatio,
        vehiclesPerFrame: avgValue,
        capture: entry.capture.counters?.() ?? null,
      };
    });
    return { maxCameras: this.maxCameras, cameras };
  }

  /** Stops every pipeline now. */
  stop(): void {
    for (const entry of Array.from(this.watched.values())) this.release(entry);
  }

  /** Resolves once every camera loop has exited - for tests and shutdown. */
  async idle(): Promise<void> {
    await Promise.all(Array.from(this.loops));
  }

  private acquire(cameraId: string): Promise<WatchedCamera | string> {
    const existing = this.watched.get(cameraId);
    if (existing) return Promise.resolve(existing);
    const pending = this.starting.get(cameraId);
    if (pending) return pending;

    const started = this.source
      .load()
      .then((cameras): WatchedCamera | string => {
        const already = this.watched.get(cameraId);
        if (already) return already;
        const camera = cameras.find((c) => c.id === cameraId);
        if (!camera || camera.status !== 'active') return 'camera is not active';
        if (this.watched.size >= this.maxCameras) return 'overlay detector is busy with other cameras';
        return this.start(camera);
      })
      .catch((err): string => `overlay detector failed to start: ${err instanceof Error ? err.message : String(err)}`)
      .finally(() => this.starting.delete(cameraId));
    this.starting.set(cameraId, started);
    return started;
  }

  private start(camera: CameraEntry): WatchedCamera {
    const entry: WatchedCamera = {
      camera,
      capture: this.frameGrabber.openCapture(camera),
      pipeline: this.createPipeline(camera),
      subscribers: new Set(),
      recent: [],
      stopHandle: null,
      stats: { since: Date.now(), frames: 0, detectMs: 0, vehicles: 0 },
      throughput: new ThroughputWindow(),
    };
    this.watched.set(camera.id, entry);
    const loop = this.runLoop(entry)
      .catch((err) => console.error(`[LiveOverlayService] loop for camera "${camera.id}" failed:`, err))
      .finally(() => this.loops.delete(loop));
    this.loops.add(loop);
    return entry;
  }

  private scheduleStopIfIdle(entry: WatchedCamera): void {
    if (entry.subscribers.size > 0 || entry.stopHandle !== null || this.watched.get(entry.camera.id) !== entry) return;
    entry.stopHandle = this.scheduler.setTimeout(() => {
      entry.stopHandle = null;
      if (entry.subscribers.size === 0) this.release(entry);
    }, this.idleStopMs);
  }

  private release(entry: WatchedCamera): void {
    if (entry.stopHandle !== null) this.scheduler.clearTimeout(entry.stopHandle);
    entry.stopHandle = null;
    if (this.watched.get(entry.camera.id) === entry) this.watched.delete(entry.camera.id);
    entry.capture.close();
  }

  private async runLoop(entry: WatchedCamera): Promise<void> {
    while (this.watched.get(entry.camera.id) === entry) {
      const frame = await entry.capture.next();
      if (this.watched.get(entry.camera.id) !== entry) return;
      const timestamp = new Date(frame.ok ? frame.capturedAt : Date.now()).toISOString();
      let result: LiveOverlayResult;
      if (!frame.ok) {
        result = { cameraId: entry.camera.id, timestamp, detections: [], error: frame.error };
      } else {
        try {
          const startedAt = Date.now();
          const detected = await entry.pipeline.detector.detect(frame.frame);
          const tracked = entry.pipeline.tracker.update(detected.detections, frame.capturedAt);
          this.recordThroughput(entry, Date.now() - startedAt, tracked.tracks.length, frame.streamTime);
          result = {
            cameraId: entry.camera.id,
            timestamp,
            detections: tracked.tracks,
            ...(frame.streamTime === undefined ? {} : { streamTime: frame.streamTime }),
          };
        } catch (err) {
          result = { cameraId: entry.camera.id, timestamp, detections: [], error: err instanceof Error ? err.message : 'Detection failed' };
        }
      }
      this.publish(entry, result);
    }
  }

  /**
   * Logs, once a minute per watched camera, how fast the detector actually
   * runs on this host - the first thing to look at when boxes are sparse
   * (a detector slower than the capture's fps means dropped frames). The
   * stream-seconds-per-second figure is whether the capture itself keeps up:
   * below 1x (ffmpeg starved of CPU) the overlay falls further behind the
   * picture every second, and once the player overtakes it there are no
   * boxes to draw however fast the detector is.
   */
  private recordThroughput(entry: WatchedCamera, detectMs: number, vehicles: number, streamTime?: number): void {
    entry.throughput.record(detectMs, streamTime, vehicles);
    const stats = entry.stats;
    stats.frames += 1;
    stats.detectMs += detectMs;
    stats.vehicles += vehicles;
    if (streamTime !== undefined) {
      if (stats.firstStreamTime === undefined) {
        stats.firstStreamTime = streamTime;
        stats.firstStreamAt = Date.now();
      }
      stats.lastStreamTime = streamTime;
    }
    const elapsed = Date.now() - stats.since;
    if (elapsed < THROUGHPUT_LOG_MS) return;
    const streamWallMs = stats.firstStreamAt === undefined ? 0 : Date.now() - stats.firstStreamAt;
    const covered =
      stats.firstStreamTime !== undefined && stats.lastStreamTime !== undefined && streamWallMs > 0 && stats.lastStreamTime >= stats.firstStreamTime
        ? `, stream ${((stats.lastStreamTime - stats.firstStreamTime) / (streamWallMs / 1000)).toFixed(2)}x real time`
        : '';
    console.log(
      `[LiveOverlayService] ${entry.camera.id}: ${((stats.frames * 1000) / elapsed).toFixed(1)} frames/s, ` +
        `detection ${Math.round(stats.detectMs / stats.frames)} ms/frame, ${(stats.vehicles / stats.frames).toFixed(1)} vehicles/frame${covered}`,
    );
    entry.stats = { since: Date.now(), frames: 0, detectMs: 0, vehicles: 0 };
  }

  private publish(entry: WatchedCamera, result: LiveOverlayResult): void {
    if (!result.error) {
      entry.recent.push(result);
      const cutoff = Date.parse(result.timestamp) - this.recentResultsMs;
      let stale = 0;
      while (stale < entry.recent.length && Date.parse(entry.recent[stale].timestamp) < cutoff) stale += 1;
      if (stale > 0) entry.recent.splice(0, stale);
    }
    entry.subscribers.forEach((cb) => notify(cb, result));
  }
}

/** Delivers to one subscriber, containing any failure - see the same helper in `TrafficAnalysisService`. */
function notify<T>(callback: (payload: T) => void, payload: T): void {
  try {
    callback(payload);
  } catch {
    // A broken subscriber must not affect the others.
  }
}
