import { CameraEntry } from '../types/camera';
import { FfmpegRunner, FfmpegStreamHandle, FfmpegStreamRunner, createFfmpegRunner, createFfmpegStreamRunner } from './ffmpegRunner';

export interface FrameGrabberOptions {
  /** Per-camera capture timeout, in milliseconds. Defaults to 10000. */
  timeoutMs?: number;
  /** Injectable ffmpeg runner, primarily used for testing. */
  ffmpegRunner?: FfmpegRunner;
  /** Injectable long-running ffmpeg stream runner (used by `openCapture`), primarily used for testing. */
  ffmpegStreamRunner?: FfmpegStreamRunner;
  /** Path to the ffmpeg executable, if not on PATH. Ignored if `ffmpegRunner`/`ffmpegStreamRunner` are supplied. */
  ffmpegPath?: string;
  /**
   * Target frames-per-second decoded by a continuous capture. Defaults to
   * 6, comfortably ahead of `TrafficAnalysisService`'s default boosted
   * polling cadence (200ms, i.e. 5fps) so a caller only rarely has to wait
   * on the next decode instead of dequeuing an already-ready frame.
   */
  streamFps?: number;
  /**
   * Decoded-but-not-yet-consumed frames retained per capture before the
   * oldest are dropped. Defaults to 12. See the note on burstiness above
   * `FfmpegFrameCapture.frameQueue` for why this needs to be more than 1.
   */
  maxQueuedFrames?: number;
}

export interface GrabFrameSuccess {
  ok: true;
  /** A single decoded JPEG video frame. */
  buffer: Buffer;
}

export interface GrabFrameFailure {
  ok: false;
  error: string;
}

export type GrabFrameResult = GrabFrameSuccess | GrabFrameFailure;

/**
 * An open, continuously-decoding capture of one camera's stream.
 *
 * This is the object form of what used to be a `{ streaming: true }` flag
 * on `grabFrame` plus a `stopStreaming(cameraId)` call the caller had to
 * remember to make. Holding the capture *is* holding the ffmpeg process:
 * there is no separate id to look up, and no way to keep asking for frames
 * without also holding the thing you must close.
 */
export interface FrameCapture {
  /**
   * The oldest decoded frame not yet handed to a caller, waiting for the
   * next one if none is queued. Resolves with a failure rather than
   * rejecting - on timeout, on process exit, or once closed.
   */
  next(): Promise<GrabFrameResult>;
  /** Stops the underlying ffmpeg process and fails any pending `next()`. Safe to call more than once. */
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STREAM_FPS = 6;
const DEFAULT_MAX_QUEUED_FRAMES = 12;
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
/**
 * Ceiling on the bytes held for a single not-yet-complete frame. A `-q:v 4`
 * MJPEG frame is a few hundred KB even at 1080p, so anything past this is a
 * stream that will never produce a closing marker; the buffer is resynced
 * rather than grown until the process runs out of memory.
 */
const MAX_PENDING_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * FrameGrabber invokes ffmpeg against a camera's live stream URL and
 * returns decoded frames as JPEG image buffers, for a `CameraAnalyzer` to
 * run detection against.
 *
 * It reuses the same header-forwarding approach as `CameraValidator`
 * (which does the equivalent for ffprobe) for cameras that require
 * special request headers to defeat hotlink protection - ffmpeg is a
 * native client so, unlike the browser-based player, it can send those
 * headers directly without needing the HLS proxy.
 *
 * Two capture modes are supported, and they are separate methods rather
 * than one method with a mode flag, because they differ in lifetime, not
 * just in behaviour. `grabFrame` spawns a fresh ffmpeg process, waits for
 * it to exit and returns one frame - simple, self-contained, but each call
 * pays the full cost of reconnecting to the HLS stream (playlist + segment
 * fetch), which is far too slow for multiple updates per second.
 * `openCapture` instead keeps a single long-running process decoding at a
 * low fixed fps and hands back a `FrameCapture` the caller holds and
 * closes.
 *
 * The module has no orchestration knowledge - camera entry in, frames (or
 * errors) out - which keeps it simple to unit test in isolation by
 * injecting a fake `FfmpegRunner`/`FfmpegStreamRunner`.
 */
export class FrameGrabber {
  private readonly timeoutMs: number;
  private readonly streamFps: number;
  private readonly maxQueuedFrames: number;
  private readonly ffmpegRunner: FfmpegRunner;
  private readonly ffmpegStreamRunner: FfmpegStreamRunner;

  constructor(options: FrameGrabberOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.streamFps = options.streamFps ?? DEFAULT_STREAM_FPS;
    this.maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
    this.ffmpegRunner = options.ffmpegRunner ?? createFfmpegRunner(options.ffmpegPath);
    this.ffmpegStreamRunner = options.ffmpegStreamRunner ?? createFfmpegStreamRunner(options.ffmpegPath);
  }

  /** Captures exactly one frame with a one-off ffmpeg process. */
  async grabFrame(camera: CameraEntry): Promise<GrabFrameResult> {
    let outcome;
    try {
      outcome = await this.ffmpegRunner(buildArgs(camera), this.timeoutMs);
    } catch (err) {
      return { ok: false, error: `ffmpeg failed to run: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (outcome.timedOut) {
      return { ok: false, error: 'frame capture timed out' };
    }

    if (outcome.exitCode !== 0) {
      const reason = firstNonEmptyLine(outcome.stderr) ?? `ffmpeg exited with code ${outcome.exitCode}`;
      return { ok: false, error: reason };
    }

    if (outcome.stdout.length === 0) {
      return { ok: false, error: 'ffmpeg produced no frame data' };
    }

    return { ok: true, buffer: outcome.stdout };
  }

  /**
   * Opens a continuously-decoding capture of this camera's stream. The
   * caller owns the returned capture and must `close()` it, or the ffmpeg
   * process is leaked.
   */
  openCapture(camera: CameraEntry): FrameCapture {
    return new FfmpegFrameCapture(
      () => this.ffmpegStreamRunner(buildStreamArgs(camera, this.streamFps)),
      this.timeoutMs,
      this.maxQueuedFrames,
    );
  }
}

/**
 * One camera's long-running ffmpeg capture: spawns the process, splits its
 * MJPEG stdout back into discrete frames, and hands them out one per
 * `next()`.
 *
 * The process is (re)spawned lazily on the first `next()` that finds none
 * running. That covers the initial start and, equally, an ffmpeg that dies
 * mid-capture on a network blip: the following `next()` transparently
 * starts a fresh one instead of the capture staying permanently broken
 * until its holder happens to reopen it. Respawning is naturally
 * rate-limited by how often the caller asks for frames.
 */
class FfmpegFrameCapture implements FrameCapture {
  private handle: FfmpegStreamHandle | null = null;
  /** Bytes received but not yet resolved into a complete frame. */
  private buffer: Buffer = Buffer.alloc(0);
  /** Offset in `buffer` of the in-progress frame's start marker, or -1 while still looking for one. */
  private frameStart = -1;
  /** How much of `buffer` has already been scanned for whichever marker is being looked for, so chunks aren't re-scanned. */
  private scanned = 0;
  /**
   * Decoded frames not yet handed to a caller, oldest first.
   *
   * This exists because these HLS relays deliver video in bursts, not a
   * trickle: ffmpeg fetches one segment at a time, and a segment's entire
   * span of frames - measured at 80-110 frames, i.e. many seconds of
   * footage at this capture's fps - decodes and lands on stdout within
   * under 100ms of the segment arriving, followed by total silence (no
   * bytes at all) for several more seconds until the next segment is
   * fetched. A single "latest frame" slot means every call placed during
   * that silent gap instantly re-resolves with whatever the previous
   * burst last left behind - the same stale image, over and over, with no
   * indication anything is stale. Queueing means a call placed during the
   * gap instead waits for the next genuinely new frame, and a burst's
   * arrival is spread across the next several calls instead of collapsing
   * to only its last frame.
   */
  private readonly frameQueue: Buffer[] = [];
  private lastError: string | null = null;
  private waiters: Array<(result: GrabFrameResult) => void> = [];
  private closed = false;

  constructor(
    private readonly spawn: () => FfmpegStreamHandle,
    private readonly timeoutMs: number,
    private readonly maxQueuedFrames: number,
  ) {}

  next(): Promise<GrabFrameResult> {
    if (this.closed) {
      return Promise.resolve({ ok: false, error: 'capture closed' });
    }
    this.ensureProcess();

    // Consume-once: a call landing between bursts (see `frameQueue`) waits
    // for the next genuinely new frame instead of instantly re-resolving
    // with one already handed to an earlier caller.
    const queued = this.frameQueue.shift();
    if (queued) {
      return Promise.resolve({ ok: true, buffer: queued });
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(settle);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve({ ok: false, error: this.lastError ?? 'frame capture timed out' });
      }, this.timeoutMs);

      const settle = (result: GrabFrameResult) => {
        clearTimeout(timer);
        resolve(result);
      };
      this.waiters.push(settle);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handle?.kill();
    this.handle = null;
    this.failWaiters('capture closed');
  }

  private ensureProcess(): void {
    if (this.handle) return;

    const handle = this.spawn();
    this.handle = handle;

    handle.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    handle.stderr.on('data', (chunk: Buffer) => {
      const line = firstNonEmptyLine(chunk.toString('utf8'));
      if (line) this.lastError = line;
    });
    handle.onExit((reason) => {
      // The process died (or never started) - drop it so the next `next()`
      // transparently starts a fresh one, and unblock anyone waiting.
      if (this.handle === handle) this.handle = null;
      this.failWaiters(reason);
    });
  }

  /**
   * Extracts every complete JPEG frame from the raw ffmpeg stdout stream.
   *
   * Scanning resumes from `scanned` rather than restarting at the head of
   * the buffer, so a frame arriving over many chunks is scanned once
   * overall instead of once per chunk, and bytes that cannot be part of a
   * completable frame are dropped instead of accumulating.
   *
   * Every frame found is collected, not just the last one - a single
   * stdout chunk routinely contains several complete frames at once (a
   * fetched HLS segment decodes in a burst; see `frameQueue`), and
   * discarding all but the final one here would defeat the queue before it
   * even gets a chance to retain them.
   */
  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    const found: Buffer[] = [];
    for (;;) {
      if (this.frameStart < 0) {
        const soi = this.buffer.indexOf(JPEG_SOI, this.scanned);
        if (soi === -1) {
          // Nothing here starts a frame. Keep only the trailing bytes a start
          // marker could straddle into the next chunk; discard the rest.
          const keepFrom = Math.max(0, this.buffer.length - (JPEG_SOI.length - 1));
          this.buffer = this.buffer.subarray(keepFrom);
          this.scanned = 0;
          break;
        }
        this.frameStart = soi;
        this.scanned = soi + JPEG_SOI.length;
      }

      const eoi = this.buffer.indexOf(JPEG_EOI, this.scanned);
      if (eoi === -1) {
        if (this.buffer.length - this.frameStart > MAX_PENDING_FRAME_BYTES) {
          // Implausibly long "frame" - treat the start marker as spurious and resync past it.
          this.buffer = this.buffer.subarray(this.frameStart + JPEG_SOI.length);
          this.frameStart = -1;
          this.scanned = 0;
          continue;
        }
        this.scanned = Math.max(this.frameStart + JPEG_SOI.length, this.buffer.length - (JPEG_EOI.length - 1));
        break;
      }

      const frameEnd = eoi + JPEG_EOI.length;
      found.push(Buffer.from(this.buffer.subarray(this.frameStart, frameEnd)));
      this.buffer = this.buffer.subarray(frameEnd);
      this.frameStart = -1;
      this.scanned = 0;
    }

    if (found.length === 0) return;

    // Waiters get first claim on newly-decoded frames (FIFO pairing: the
    // longest-waiting call gets the oldest new frame), then whatever's left
    // joins the queue for the next call to pick up immediately.
    for (const frame of found) {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter({ ok: true, buffer: frame });
      } else {
        this.frameQueue.push(frame);
      }
    }
    // Bounded to the newest `maxQueuedFrames`: a burst can be 80-100+ frames
    // (see `frameQueue`), and detection cannot remotely keep pace with that
    // within one burst's arrival window, so unconsumed frames from early in a
    // burst are dropped in favor of keeping the tail - the samples closest to
    // live - once the cap is exceeded.
    const overflow = this.frameQueue.length - this.maxQueuedFrames;
    if (overflow > 0) this.frameQueue.splice(0, overflow);
  }

  private failWaiters(reason: string): void {
    if (this.waiters.length === 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((settle) => settle({ ok: false, error: reason }));
  }
}

function buildArgs(camera: CameraEntry): string[] {
  const args = buildCommonArgs(camera);
  // Grab exactly one frame and emit it as a JPEG on stdout.
  args.push('-frames:v', '1', '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1');
  return args;
}

function buildStreamArgs(camera: CameraEntry, streamFps: number): string[] {
  const args = buildCommonArgs(camera);
  // Continuously decode at a low fixed fps and emit each frame as a JPEG on
  // stdout - the process is left running until the capture is closed, rather
  // than exiting after one frame.
  args.push('-vf', `fps=${streamFps}`, '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1');
  return args;
}

function buildCommonArgs(camera: CameraEntry): string[] {
  const args: string[] = [];

  if (camera.headers && Object.keys(camera.headers).length > 0) {
    const headerLines = Object.entries(camera.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\r\n');
    args.push('-headers', `${headerLines}\r\n`);
  }
  if (camera.protocol === 'RTSP') {
    // Prefer TCP for RTSP: more likely to traverse firewalls/NATs than the UDP default.
    args.push('-rtsp_transport', 'tcp');
  }

  args.push('-i', camera.url);
  return args;
}

function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}
