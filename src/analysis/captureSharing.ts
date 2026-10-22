import { CaptureCounters } from '../types/admin';
import type { FrameCapture, GrabFrameResult, GrabFrameSuccess } from './frameGrabber';
import { downscaleYuv420p } from './videoFrame';

/** A running capture other captures of the same camera may take their frames from. */
export interface SharedSource {
  width: number;
  height: number;
  /** The frame rate it decodes at (it can change - see `FrameGrabber.setStreamFps`). */
  fps(): number;
  /** When it last decoded a frame (epoch ms), or 0 if never. */
  lastFrameAt(): number;
  /** Calls `listener` with every frame it decodes; returns the unsubscribe function. */
  onFrame(listener: (frame: GrabFrameSuccess) => void): () => void;
}

/** A source counts as live, for a capture deciding not to start its own ffmpeg, if it decoded a frame this recently. */
const LIVE_SOURCE_MS = 5_000;

/**
 * Where the live-box (overlay) captures offer their frames to the analysis
 * captures of the same camera - P6 from the app review.
 *
 * A watched camera used to run two ffmpeg processes on the same stream: the
 * analysis one (320x240) and the overlay one (960x720 on the GPU, 640x480 on
 * the CPU), both at 3 fps. Each decodes the whole H.264 stream, costing
 * ~17 MB and a share of a core. The overlay's frames are an exact multiple
 * of the analysis size, so while the overlay runs the analysis capture
 * shrinks its frames (area averaging, the same as its own ffmpeg's
 * `flags=area` scaling) and stops its own ffmpeg; when the overlay closes,
 * it starts its own again.
 */
export class CaptureSharing {
  private readonly sources = new Map<string, SharedSource>();
  private readonly watchers = new Map<string, Set<(source: SharedSource | null) => void>>();

  publish(cameraId: string, source: SharedSource): void {
    this.sources.set(cameraId, source);
    this.watchers.get(cameraId)?.forEach((watcher) => watcher(source));
  }

  unpublish(cameraId: string, source: SharedSource): void {
    if (this.sources.get(cameraId) !== source) return;
    this.sources.delete(cameraId);
    this.watchers.get(cameraId)?.forEach((watcher) => watcher(null));
  }

  get(cameraId: string): SharedSource | null {
    return this.sources.get(cameraId) ?? null;
  }

  /** Calls `watcher` whenever this camera's source appears or goes; returns the unwatch function. */
  watch(cameraId: string, watcher: (source: SharedSource | null) => void): () => void {
    let set = this.watchers.get(cameraId);
    if (!set) {
      set = new Set();
      this.watchers.set(cameraId, set);
    }
    set.add(watcher);
    return () => {
      set!.delete(watcher);
      if (set!.size === 0 && this.watchers.get(cameraId) === set) this.watchers.delete(cameraId);
    };
  }
}

/** The integer factor a source's frames shrink by to `width x height`, or null if they can't (not a whole multiple, chroma included). */
export function shrinkFactor(source: { width: number; height: number }, width: number, height: number): number | null {
  const factor = source.width / width;
  if (!Number.isInteger(factor) || factor < 1 || source.height !== height * factor) return null;
  if (!Number.isInteger(source.width / 2 / factor) || !Number.isInteger(source.height / 2 / factor)) return null;
  return factor;
}

export interface SharingCaptureOptions {
  cameraId: string;
  sharing: CaptureSharing;
  /** Opens this capture's own ffmpeg capture (not started until its first `next()`). */
  openOwn: () => FrameCapture & { restart?(): void };
  width: number;
  height: number;
  /** The frame rate this capture wants. */
  fps: () => number;
  timeoutMs: number;
  maxQueuedFrames: number;
  onClose?: () => void;
  now?: () => number;
}

/**
 * A capture that decodes the stream itself, except while a compatible shared
 * source (a live-box capture of the same camera) is running: then it takes
 * that source's frames, shrunk to its own size and thinned to its own frame
 * rate, and its own ffmpeg is stopped. It switches over on the source's
 * first frame, so the analysis doesn't wait out the source's start-up, and
 * back (starting its own ffmpeg again) when the source closes.
 */
export class SharingCapture implements FrameCapture {
  private own: (FrameCapture & { restart?(): void }) | null = null;
  private source: SharedSource | null = null;
  private unsubscribeSource: (() => void) | null = null;
  private readonly unwatch: () => void;
  private readonly queue: GrabFrameSuccess[] = [];
  private waiters: Array<(result: GrabFrameResult) => void> = [];
  private started = false;
  private closed = false;
  /** Stream time (s) of the last shared frame taken, to thin the source to this capture's rate. */
  private lastSharedTime: number | null = null;
  private lastError: string | null = null;
  private lastFrameAt = 0;
  private dropped = 0;
  /**
   * Counters of own captures already stopped, so the Admin page's totals don't
   * reset at each switch. Only their restarts count towards `starts`: starting
   * again after a shared source closed is not a failure.
   */
  private retired = { starts: 0, stalls: 0, dropped: 0 };
  private readonly now: () => number;

  constructor(private readonly options: SharingCaptureOptions) {
    this.now = options.now ?? (() => Date.now());
    this.unwatch = options.sharing.watch(options.cameraId, (source) => this.setSource(source));
    this.setSource(options.sharing.get(options.cameraId));
  }

  /** Whether frames currently come from a shared source rather than this capture's own ffmpeg. */
  get sharing(): boolean {
    return this.own === null && this.started;
  }

  next(): Promise<GrabFrameResult> {
    if (this.closed) return Promise.resolve({ ok: false, error: 'capture closed' });
    if (!this.started) {
      this.started = true;
      // A source already decoding is used straight away; otherwise this capture starts its own ffmpeg.
      const source = this.source;
      const live = source && this.factorFor(source) !== null && this.now() - source.lastFrameAt() < LIVE_SOURCE_MS;
      if (!live) this.startOwn();
    }
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(settle);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve({ ok: false, error: this.lastError ?? 'frame capture timed out' });
      }, this.options.timeoutMs);
      timer.unref?.();
      const settle = (result: GrabFrameResult) => {
        clearTimeout(timer);
        resolve(result);
      };
      this.waiters.push(settle);
    });
  }

  /** New ffmpeg arguments (a frame rate change): restarts the own ffmpeg; a shared source just gets thinned differently. */
  restart(): void {
    this.own?.restart?.();
  }

  counters(): CaptureCounters {
    const own = this.own?.counters?.();
    return {
      starts: this.retired.starts + Math.max(1, own?.starts ?? 1),
      stalls: this.retired.stalls + (own?.stalls ?? 0),
      dropped: this.retired.dropped + (own?.dropped ?? 0) + this.dropped,
      lastFrameAt: this.lastFrameAt ? new Date(this.lastFrameAt).toISOString() : null,
      lastError: own?.lastError ?? null,
      shared: this.sharing,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unwatch();
    this.unsubscribeSource?.();
    this.unsubscribeSource = null;
    this.stopOwn();
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((settle) => settle({ ok: false, error: 'capture closed' }));
    this.options.onClose?.();
  }

  private factorFor(source: SharedSource): number | null {
    if (source.fps() < this.options.fps() * 0.99) return null;
    return shrinkFactor(source, this.options.width, this.options.height);
  }

  private setSource(source: SharedSource | null): void {
    if (this.closed || source === this.source) return;
    this.unsubscribeSource?.();
    this.unsubscribeSource = null;
    this.source = source;
    this.lastSharedTime = null;
    if (source) this.unsubscribeSource = source.onFrame((frame) => this.onSharedFrame(source, frame));
    else if (this.started && !this.own) this.startOwn();
  }

  private onSharedFrame(source: SharedSource, frame: GrabFrameSuccess): void {
    if (this.closed || !this.started || source !== this.source) return;
    const factor = this.factorFor(source);
    if (factor === null) {
      // The source no longer fits (a frame rate below this capture's): decode the stream ourselves again.
      if (!this.own) this.startOwn();
      return;
    }
    const time = frame.streamTime ?? frame.capturedAt / 1000;
    const last = this.lastSharedTime;
    if (last !== null && time >= last && time - last < 0.75 / this.options.fps()) return;
    this.lastSharedTime = time;
    if (this.own) this.stopOwn();
    this.deliver({ ...frame, frame: downscaleYuv420p(frame.frame, factor) });
  }

  private startOwn(): void {
    if (this.own || this.closed) return;
    const own = this.options.openOwn();
    this.own = own;
    void this.pump(own);
  }

  private stopOwn(): void {
    const own = this.own;
    if (!own) return;
    this.own = null;
    const counters = own.counters?.();
    if (counters) {
      this.retired.starts += Math.max(0, counters.starts - 1);
      this.retired.stalls += counters.stalls;
      this.retired.dropped += counters.dropped;
    }
    own.close();
  }

  /** Hands the own capture's frames (and failures) on, until it is stopped. */
  private async pump(own: FrameCapture): Promise<void> {
    while (!this.closed && this.own === own) {
      const result = await own.next();
      if (this.closed || this.own !== own) return;
      this.deliver(result);
    }
  }

  private deliver(result: GrabFrameResult): void {
    if (result.ok) {
      this.lastFrameAt = result.capturedAt;
      this.lastError = null;
    } else {
      this.lastError = result.error;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(result);
      return;
    }
    if (!result.ok) return;
    this.queue.push(result);
    const overflow = this.queue.length - this.options.maxQueuedFrames;
    if (overflow > 0) {
      this.queue.splice(0, overflow);
      this.dropped += overflow;
    }
  }
}
