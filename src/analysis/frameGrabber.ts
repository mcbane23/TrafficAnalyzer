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
   * 3: every active camera is analyzed continuously, so this is multiplied
   * by the whole fleet. Three frames a second is enough for the tracker to
   * follow a vehicle across a typical view (it crosses in several seconds)
   * while keeping ~20 cameras within a couple of CPU cores.
   */
  streamFps?: number;
  /**
   * Decoded-but-not-yet-consumed frames retained per capture before the
   * oldest are dropped. Defaults to 12. See the note on burstiness above
   * `FfmpegFrameCapture.frameQueue` for why this needs to be more than 1.
   */
  maxQueuedFrames?: number;
  /**
   * Pace a continuous capture's input at the stream's native frame rate
   * (ffmpeg `-re`). Defaults to true. Without it, ffmpeg decodes each
   * fetched HLS segment as fast as it can - many seconds of footage landing
   * within ~100ms, then silence until the next segment - so the frames a
   * consumer pulls are unevenly spaced in time and the queue cap throws most
   * of each burst away. Pacing turns that into an even, real-time trickle,
   * which is what lets `capturedAt` stand in for the frame's real time and
   * lets the tracker see every frame instead of a few per segment.
   */
  realtime?: boolean;
  /**
   * A running capture that has produced no frame for this long (ms) is
   * treated as stalled - an HLS playlist that stopped advancing, a TCP
   * connection silently black-holed - and its ffmpeg process is killed and
   * restarted. Defaults to 20000. Without this, a stalled ffmpeg neither
   * exits nor produces data, and the capture stays dead until its holder
   * happens to close it.
   */
  stallTimeoutMs?: number;
  /** Delay (ms) before restarting a capture whose ffmpeg exited after producing frames. Defaults to 1000. */
  restartDelayMs?: number;
  /**
   * Ceiling (ms) on the restart delay. A capture whose ffmpeg keeps exiting
   * without producing a single frame - a camera that's down, a URL that
   * 404s - backs off exponentially from `restartDelayMs` up to this, rather
   * than respawning ffmpeg in a tight loop against a dead upstream.
   * Defaults to 60000.
   */
  maxRestartDelayMs?: number;
}

export interface GrabFrameSuccess {
  ok: true;
  /** A single decoded JPEG video frame. */
  buffer: Buffer;
  /** When the frame was decoded (epoch ms) - its timestamp for tracking purposes. */
  capturedAt: number;
}

export interface GrabFrameFailure {
  ok: false;
  error: string;
}

export type GrabFrameResult = GrabFrameSuccess | GrabFrameFailure;

/**
 * An open, continuously-decoding capture of one camera's stream, which
 * keeps itself connected: a stalled or exited ffmpeg is restarted (with
 * backoff) for as long as the capture is open.
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
const DEFAULT_STREAM_FPS = 3;
const DEFAULT_MAX_QUEUED_FRAMES = 12;
const DEFAULT_STALL_TIMEOUT_MS = 20_000;
const DEFAULT_RESTART_DELAY_MS = 1_000;
const DEFAULT_MAX_RESTART_DELAY_MS = 60_000;
/** Read/write timeout for HTTP(S)-delivered streams, in microseconds (ffmpeg's unit) - a hung segment fetch fails instead of blocking forever. */
const HTTP_RW_TIMEOUT_US = 15_000_000;
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
  private readonly realtime: boolean;
  private readonly supervision: CaptureSupervision;
  private readonly ffmpegRunner: FfmpegRunner;
  private readonly ffmpegStreamRunner: FfmpegStreamRunner;

  constructor(options: FrameGrabberOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.streamFps = options.streamFps ?? DEFAULT_STREAM_FPS;
    this.maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
    this.realtime = options.realtime ?? true;
    this.supervision = {
      stallTimeoutMs: options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
      restartDelayMs: options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
      maxRestartDelayMs: options.maxRestartDelayMs ?? DEFAULT_MAX_RESTART_DELAY_MS,
    };
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

    return { ok: true, buffer: outcome.stdout, capturedAt: Date.now() };
  }

  /**
   * Opens a continuously-decoding capture of this camera's stream. The
   * caller owns the returned capture and must `close()` it, or the ffmpeg
   * process is leaked.
   */
  openCapture(camera: CameraEntry): FrameCapture {
    return new FfmpegFrameCapture(
      () => this.ffmpegStreamRunner(buildStreamArgs(camera, this.streamFps, this.realtime)),
      this.timeoutMs,
      this.maxQueuedFrames,
      this.supervision,
    );
  }
}

interface CaptureSupervision {
  stallTimeoutMs: number;
  restartDelayMs: number;
  maxRestartDelayMs: number;
}

/**
 * One camera's long-running ffmpeg capture: spawns the process, splits its
 * MJPEG stdout back into discrete frames, hands them out one per `next()`,
 * and keeps the process alive.
 *
 * The process is first spawned lazily, on the first `next()`. From then on
 * the capture supervises it until `close()`:
 *
 * - If ffmpeg exits (a network blip, an upstream restart, a 404), a restart
 *   is scheduled. A process that produced frames before dying is restarted
 *   after `restartDelayMs`; one that keeps dying without producing any
 *   backs off exponentially up to `maxRestartDelayMs`, so a camera that is
 *   down costs one ffmpeg spawn a minute, not one per tick.
 * - If ffmpeg stays running but produces nothing for `stallTimeoutMs`, it is
 *   killed and restarted the same way. This is the failure mode that used
 *   to leave a capture permanently dead: a live HLS playlist that stops
 *   advancing doesn't make ffmpeg exit, it makes it wait forever.
 *
 * A `next()` placed while the process is down or restarting simply waits
 * (up to the capture timeout) for the first frame after reconnection.
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
   * With real-time pacing (see `FrameGrabberOptions.realtime`) frames
   * arrive evenly and this rarely holds more than one or two. It still
   * matters when pacing is off, or when ffmpeg catches up after a slow
   * segment fetch: a burst of frames is spread across the next several
   * calls instead of collapsing to only its last frame, and a call placed
   * while nothing is queued waits for the next genuinely new frame instead
   * of re-serving a stale one.
   */
  private readonly frameQueue: GrabFrameSuccess[] = [];
  private lastError: string | null = null;
  private waiters: Array<(result: GrabFrameResult) => void> = [];
  private closed = false;
  /** Whether `next()` has ever been called - before that, nothing is spawned. */
  private started = false;
  /** Consecutive process runs that ended without producing a single frame. */
  private failedRuns = 0;
  private framesThisRun = 0;
  private lastFrameAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly spawn: () => FfmpegStreamHandle,
    private readonly timeoutMs: number,
    private readonly maxQueuedFrames: number,
    private readonly supervision: CaptureSupervision,
  ) {}

  next(): Promise<GrabFrameResult> {
    if (this.closed) {
      return Promise.resolve({ ok: false, error: 'capture closed' });
    }
    if (!this.started) {
      this.started = true;
      this.startProcess();
    }

    // Consume-once: a call landing while nothing new has been decoded waits
    // for the next genuinely new frame instead of re-resolving with one
    // already handed to an earlier caller.
    const queued = this.frameQueue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(settle);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve({ ok: false, error: this.lastError ?? 'frame capture timed out' });
      }, this.timeoutMs);
      timer.unref?.();

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
    this.clearTimers();
    this.handle?.kill();
    this.handle = null;
    this.failWaiters('capture closed');
  }

  private startProcess(): void {
    this.restartTimer = null;
    if (this.closed || this.handle) return;

    this.buffer = Buffer.alloc(0);
    this.frameStart = -1;
    this.scanned = 0;
    this.framesThisRun = 0;
    this.lastFrameAt = Date.now();

    const handle = this.spawn();
    this.handle = handle;

    handle.stdout.on('data', (chunk: Buffer) => {
      if (this.handle === handle) this.onData(chunk);
    });
    handle.stderr.on('data', (chunk: Buffer) => {
      const line = firstNonEmptyLine(chunk.toString('utf8'));
      if (line) this.lastError = line;
    });
    handle.onExit((reason) => {
      // Ignore a process this capture already gave up on (killed as stalled).
      if (this.handle !== handle) return;
      this.handle = null;
      this.onProcessEnded(this.lastError ?? reason);
    });
    this.armStallTimer();
  }

  /** Re-arms the stall watchdog against the most recent frame. */
  private armStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    const elapsed = Date.now() - this.lastFrameAt;
    const wait = Math.max(0, this.supervision.stallTimeoutMs - elapsed);
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      const handle = this.handle;
      if (!handle || this.closed) return;
      if (Date.now() - this.lastFrameAt >= this.supervision.stallTimeoutMs) {
        const reason = `stream stalled: no frames for ${Math.round(this.supervision.stallTimeoutMs / 1000)}s`;
        this.handle = null;
        handle.kill();
        this.lastError = reason;
        this.onProcessEnded(reason);
      } else {
        this.armStallTimer();
      }
    }, wait);
  }

  private onProcessEnded(reason: string): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.failWaiters(reason);
    if (this.closed) return;

    this.failedRuns = this.framesThisRun > 0 ? 0 : this.failedRuns + 1;
    const delay = Math.min(
      this.supervision.maxRestartDelayMs,
      this.supervision.restartDelayMs * 2 ** Math.max(0, this.failedRuns - 1),
    );
    this.restartTimer = setTimeout(() => this.startProcess(), delay);
  }

  private clearTimers(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.restartTimer = null;
    this.stallTimer = null;
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
   * stdout chunk can contain several complete frames at once (see
   * `frameQueue`).
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

    const capturedAt = Date.now();
    this.framesThisRun += found.length;
    this.lastFrameAt = capturedAt;
    this.lastError = null;

    // Waiters get first claim on newly-decoded frames (FIFO pairing: the
    // longest-waiting call gets the oldest new frame), then whatever's left
    // joins the queue for the next call to pick up immediately.
    for (const buffer of found) {
      const frame: GrabFrameSuccess = { ok: true, buffer, capturedAt };
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        this.frameQueue.push(frame);
      }
    }
    // Bounded to the newest `maxQueuedFrames`: if the consumer falls behind,
    // the frames closest to live are the ones worth keeping. The tracker
    // works off each frame's own timestamp, so a dropped frame shows up as a
    // longer gap, not as a vehicle jumping.
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

function buildStreamArgs(camera: CameraEntry, streamFps: number, realtime: boolean): string[] {
  const args = buildCommonArgs(camera, realtime);
  // Continuously decode at a low fixed fps and emit each frame as a JPEG on
  // stdout - the process is left running until the capture is closed, rather
  // than exiting after one frame.
  args.push('-vf', `fps=${streamFps}`, '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1');
  return args;
}

function buildCommonArgs(camera: CameraEntry, realtime = false): string[] {
  // Errors only on stderr, so the first stderr line is a reason worth
  // surfacing rather than ffmpeg's version banner.
  const args: string[] = ['-hide_banner', '-nostats', '-loglevel', 'error'];

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
  if (/^https?:/i.test(camera.url)) {
    // Fail a hung request instead of blocking forever, and let ffmpeg's HTTP
    // layer retry a dropped connection itself before the whole process has
    // to be restarted.
    args.push('-rw_timeout', String(HTTP_RW_TIMEOUT_US), '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  if (realtime) {
    args.push('-re');
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
