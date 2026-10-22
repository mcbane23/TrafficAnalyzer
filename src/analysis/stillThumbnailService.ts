import fs from 'node:fs';
import path from 'node:path';
import { CameraEntry } from '../types/camera';
import { CameraSource } from '../server/cameraService';
import { GrabFrameResult } from './frameGrabber';
import { VideoFrame, encodeJpeg } from './videoFrame';
import { AnalysisScheduler } from './trafficAnalysisService';

/** A camera's still image: a JPEG and when its frame was captured. */
export interface Thumbnail {
  buffer: Buffer;
  capturedAt: string;
}

/** Narrow seam over `FrameGrabber.grabFrame` - one frame from a one-off ffmpeg. */
export interface StillGrabber {
  grabFrame(camera: CameraEntry): Promise<GrabFrameResult>;
}

/** Where stills are kept between restarts. */
export interface ThumbnailStore {
  loadAll(): Map<string, Thumbnail>;
  save(cameraId: string, thumbnail: Thumbnail): void;
}

export interface StillThumbnailServiceOptions {
  /** The analysis' live thumbnail for a camera, or null while it isn't analyzed (`TrafficAnalysisService.getLatestFrame`). */
  liveFrame: (cameraId: string) => Thumbnail | null;
  /** How old a still may get before it is grabbed again (ms). Defaults to 30 minutes. */
  refreshIntervalMs?: number;
  /** How long after a failed grab the camera is tried again (ms). Defaults to 5 minutes. */
  retryDelayMs?: number;
  /** How often to look for stills that have fallen due (ms). Defaults to 1 minute. */
  checkIntervalMs?: number;
  /** One-off ffmpeg processes running at once. Defaults to 1, so a pass costs one ffmpeg's memory at a time. */
  concurrency?: number;
  store?: ThumbnailStore;
  encode?: (frame: VideoFrame) => Promise<Buffer>;
  scheduler?: AnalysisScheduler;
  now?: () => number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 5 * 60_000;
const DEFAULT_CHECK_INTERVAL_MS = 60_000;

const defaultScheduler: AnalysisScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * A thumbnail for every active camera, including those the Admin page
 * leaves out of the analysis. A camera being analyzed already has a live
 * thumbnail from its running capture, which is served as is (and
 * remembered, so it stays on the dashboard after its analysis is switched
 * off). Any other camera gets a still: a single frame from a one-off
 * ffmpeg, grabbed one camera at a time at start and then again whenever
 * the still is older than `refreshIntervalMs` (a failed grab is retried
 * after `retryDelayMs`). Grabbing one at a time keeps
 * this to a single short-lived ffmpeg on a small server, however many
 * cameras are off. Stills are kept in the data volume, so the dashboard has
 * them straight after a restart, before the first pass is through.
 */
export class StillThumbnailService {
  private readonly options: Required<Omit<StillThumbnailServiceOptions, 'store'>> & { store: ThumbnailStore | null };
  private stills = new Map<string, Thumbnail>();
  /** When each camera's last grab failed (ms), until one succeeds. */
  private readonly failedAt = new Map<string, number>();
  private running = false;
  private passHandle: unknown = null;
  private pass: Promise<void> | null = null;

  constructor(
    private readonly source: CameraSource,
    private readonly grabber: StillGrabber,
    options: StillThumbnailServiceOptions,
  ) {
    this.options = {
      liveFrame: options.liveFrame,
      refreshIntervalMs: options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      checkIntervalMs: options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
      concurrency: Math.max(1, options.concurrency ?? 1),
      store: options.store ?? null,
      encode: options.encode ?? ((frame) => encodeJpeg(frame)),
      scheduler: options.scheduler ?? defaultScheduler,
      now: options.now ?? (() => Date.now()),
    };
  }

  /** Loads the kept stills and starts the first pass. */
  start(): void {
    if (this.running) return;
    this.running = true;
    try {
      this.stills = this.options.store?.loadAll() ?? new Map();
    } catch (err) {
      console.error('[StillThumbnailService] could not load kept thumbnails:', err);
    }
    this.runPass();
  }

  stop(): void {
    this.running = false;
    if (this.passHandle !== null) this.options.scheduler.clearTimeout(this.passHandle);
    this.passHandle = null;
  }

  /** Resolves once the pass in progress (if any) is through - for tests. */
  async idle(): Promise<void> {
    await this.pass;
  }

  /** The live thumbnail while the camera is analyzed, else its latest still. */
  getThumbnail(cameraId: string): Thumbnail | null {
    const live = this.options.liveFrame(cameraId);
    if (live) {
      this.stills.set(cameraId, live);
      return live;
    }
    return this.stills.get(cameraId) ?? null;
  }

  /** When each of these cameras' thumbnails was captured (ISO), for those that have one - the dashboard shows their age. */
  capturedTimes(cameraIds: string[]): Record<string, string> {
    const times: Record<string, string> = {};
    for (const id of cameraIds) {
      const thumbnail = this.getThumbnail(id);
      if (thumbnail) times[id] = thumbnail.capturedAt;
    }
    return times;
  }

  private runPass(): void {
    this.pass = this.grabDue()
      .catch((err) => console.error('[StillThumbnailService] pass failed:', err))
      .finally(() => {
        this.pass = null;
        if (this.running) this.passHandle = this.options.scheduler.setTimeout(() => this.runPass(), this.options.checkIntervalMs);
      });
  }

  /** Active, shown cameras without a live thumbnail whose still is missing or due, in registry order. */
  private async dueCameras(): Promise<CameraEntry[]> {
    const entries = await this.source.load();
    return entries.filter((camera) => camera.status === 'active' && !camera.hidden && this.isDue(camera.id));
  }

  private isDue(cameraId: string): boolean {
    if (this.options.liveFrame(cameraId)) return false;
    const now = this.options.now();
    const failedAt = this.failedAt.get(cameraId);
    if (failedAt !== undefined && now - failedAt < this.options.retryDelayMs) return false;
    const still = this.stills.get(cameraId);
    return !still || now - Date.parse(still.capturedAt) >= this.options.refreshIntervalMs;
  }

  private async grabDue(): Promise<void> {
    const queue = await this.dueCameras();
    const worker = async () => {
      for (let camera = queue.shift(); camera && this.running; camera = queue.shift()) {
        // Analysis may have been switched on, or a viewer opened the camera, while this one waited.
        if (!this.isDue(camera.id)) continue;
        await this.grab(camera).catch((err) => {
          this.failedAt.set(camera.id, this.options.now());
          console.error(`[StillThumbnailService] still for camera "${camera.id}" failed:`, err);
        });
      }
    };
    await Promise.all(Array.from({ length: this.options.concurrency }, worker));
  }

  private async grab(camera: CameraEntry): Promise<void> {
    const result = await this.grabber.grabFrame(camera);
    if (!result.ok) {
      this.failedAt.set(camera.id, this.options.now());
      console.warn(`[StillThumbnailService] no still for camera "${camera.id}": ${result.error}`);
      return;
    }
    const thumbnail = { buffer: await this.options.encode(result.frame), capturedAt: new Date(result.capturedAt).toISOString() };
    this.stills.set(camera.id, thumbnail);
    this.failedAt.delete(camera.id);
    try {
      this.options.store?.save(camera.id, thumbnail);
    } catch (err) {
      console.error(`[StillThumbnailService] could not keep the still for camera "${camera.id}":`, err);
    }
  }
}

/** Keeps stills as `<camera id>.jpg` files in a directory, the file's mtime being the capture time. */
export class FileThumbnailStore implements ThumbnailStore {
  constructor(private readonly dir: string) {}

  loadAll(): Map<string, Thumbnail> {
    const stills = new Map<string, Thumbnail>();
    if (!fs.existsSync(this.dir)) return stills;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.jpg')) continue;
      const file = path.join(this.dir, name);
      stills.set(decodeURIComponent(name.slice(0, -4)), {
        buffer: fs.readFileSync(file),
        capturedAt: fs.statSync(file).mtime.toISOString(),
      });
    }
    return stills;
  }

  save(cameraId: string, thumbnail: Thumbnail): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${encodeURIComponent(cameraId)}.jpg`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, thumbnail.buffer);
    const capturedAt = new Date(thumbnail.capturedAt);
    fs.utimesSync(tmp, capturedAt, capturedAt);
    fs.renameSync(tmp, file);
  }
}
