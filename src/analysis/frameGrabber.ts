import { CameraEntry } from '../types/camera';
import { CaptureCounters } from '../types/admin';
import { FfmpegRunner, FfmpegStreamHandle, FfmpegStreamRunner, createFfmpegRunner, createFfmpegStreamRunner } from './ffmpegRunner';
import { VideoFrame, yuv420pFrameSize } from './videoFrame';

export interface FrameGrabberOptions {
  /**
   * How long a `next()` (or a one-off `grabFrame`) waits for a frame, in
   * milliseconds. Defaults to 30000 - deliberately longer than
   * `stallTimeoutMs`, so a capture that has genuinely stopped is reported
   * by the watchdog with its real reason, while one that is merely slow to
   * open (probing a live HLS playlist means downloading whole 10 s
   * segments, slower still on a loaded host) is given time to get its first
   * frame out instead of being reported as broken.
   */
  timeoutMs?: number;
  /** Injectable ffmpeg runner, primarily used for testing. */
  ffmpegRunner?: FfmpegRunner;
  /** Injectable long-running ffmpeg stream runner (used by `openCapture`), primarily used for testing. */
  ffmpegStreamRunner?: FfmpegStreamRunner;
  /** Path to the ffmpeg executable, if not on PATH. Ignored if `ffmpegRunner`/`ffmpegStreamRunner` are supplied. */
  ffmpegPath?: string;
  /**
   * Size ffmpeg scales every frame to before handing it over, as raw
   * `yuv420p`. Defaults to 320x240 - comfortably above the working
   * resolution of every background model (the largest is 240x180), and
   * large enough for a dashboard thumbnail. Scaling inside ffmpeg, right
   * after decode, is what keeps the per-frame cost down: no JPEG is
   * encoded, piped or decoded anywhere on the analysis path.
   */
  frameWidth?: number;
  /** See `frameWidth`. Defaults to 240. */
  frameHeight?: number;
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
  /** A single decoded video frame, scaled to the grabber's frame size. */
  frame: VideoFrame;
  /** When the frame was decoded (epoch ms) - its timestamp for tracking purposes. */
  capturedAt: number;
  /**
   * The frame's presentation time in the source stream, in seconds - the
   * MPEG-TS PTS the camera's encoder stamped on it, which the browser's
   * player sees for the same frame. This, not `capturedAt`, is what lets a
   * viewer line a result up with the video picture it describes: the
   * analysis capture and the player join a live playlist at different
   * segments, so the same wall-clock instant shows them different moments.
   * Only set by continuous captures, and omitted for a frame whose time
   * ffmpeg did not report.
   */
  streamTime?: number;
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
  /** Restart/stall/drop counters for the Admin page. Optional so test fakes needn't implement it. */
  counters?(): CaptureCounters;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FRAME_WIDTH = 320;
const DEFAULT_FRAME_HEIGHT = 240;
const DEFAULT_STREAM_FPS = 3;
const DEFAULT_MAX_QUEUED_FRAMES = 12;
const DEFAULT_STALL_TIMEOUT_MS = 20_000;
const DEFAULT_RESTART_DELAY_MS = 1_000;
const DEFAULT_MAX_RESTART_DELAY_MS = 60_000;
/** Read/write timeout for HTTP(S)-delivered streams, in microseconds (ffmpeg's unit) - a hung segment fetch fails instead of blocking forever. */
const HTTP_RW_TIMEOUT_US = 15_000_000;
/**
 * Where a continuous capture joins a live HLS playlist: the second-to-last
 * segment. ffmpeg's default (-3) put analysis a segment *behind* the
 * browser's player (hls.js holds 3 target durations back from the end of
 * the playlist), so results for the picture on screen had not been
 * produced yet. Joining here keeps analysis about one segment ahead of the
 * player - results are buffered client-side until the video catches up -
 * while still leaving one whole segment of slack, so a paced (-re) capture
 * doesn't run dry waiting on the next segment to be published.
 */
const LIVE_START_INDEX = -2;
/** ffmpeg's log prefix for a line at error severity or worse, with `-loglevel level+...`. */
const ERROR_LEVEL_TAG = /\[(error|fatal|panic)\]\s*/;
/** A `showinfo` filter line for one output frame: its index within this process run, its pts, and that pts in seconds. */
const SHOWINFO_FRAME_LINE = /Parsed_showinfo.*\bn:\s*(\d+)\b.*\bpts:\s*(-?\d+)\b.*\bpts_time:\s*(-?[0-9.e+]+)/;
/**
 * `showinfo`'s time base, logged once when the filter is configured. Used to
 * compute seconds from the integer pts: `pts_time` is printed with only six
 * significant digits, which at a stream clock of ~70000s is a tenth of a second.
 */
const SHOWINFO_TIME_BASE_LINE = /Parsed_showinfo.*config in time_base:\s*(\d+)\/(\d+)/;

/**
 * FrameGrabber invokes ffmpeg against a camera's live stream URL and
 * returns decoded frames as small raw `yuv420p` images (see `VideoFrame`),
 * for a `CameraAnalyzer` to run detection against.
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
  private streamFps: number;
  private readonly maxQueuedFrames: number;
  private readonly realtime: boolean;
  private readonly frameSize: FrameSize;
  private readonly supervision: CaptureSupervision;
  private readonly ffmpegRunner: FfmpegRunner;
  private readonly ffmpegStreamRunner: FfmpegStreamRunner;
  /** Captures opened and not yet closed - restarted by `setStreamFps`. */
  private readonly openCaptures = new Set<FfmpegFrameCapture>();

  constructor(options: FrameGrabberOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.streamFps = options.streamFps ?? DEFAULT_STREAM_FPS;
    this.maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
    this.realtime = options.realtime ?? true;
    this.frameSize = {
      width: options.frameWidth ?? DEFAULT_FRAME_WIDTH,
      height: options.frameHeight ?? DEFAULT_FRAME_HEIGHT,
    };
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
      outcome = await this.ffmpegRunner(buildArgs(camera, this.frameSize), this.timeoutMs);
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

    const bytes = yuv420pFrameSize(this.frameSize.width, this.frameSize.height);
    if (outcome.stdout.length < bytes) {
      return { ok: false, error: 'ffmpeg produced no frame data' };
    }

    const frame: VideoFrame = { ...this.frameSize, data: new Uint8Array(outcome.stdout.subarray(0, bytes)) };
    return { ok: true, frame, capturedAt: Date.now() };
  }

  /**
   * Opens a continuously-decoding capture of this camera's stream. The
   * caller owns the returned capture and must `close()` it, or the ffmpeg
   * process is leaked.
   */
  openCapture(camera: CameraEntry): FrameCapture {
    const capture = new FfmpegFrameCapture(
      () => this.ffmpegStreamRunner(buildStreamArgs(camera, this.frameSize, this.streamFps, this.realtime)),
      this.frameSize,
      this.timeoutMs,
      this.maxQueuedFrames,
      this.supervision,
      () => this.openCaptures.delete(capture),
    );
    this.openCaptures.add(capture);
    return capture;
  }

  /** The frame rate captures decode at. */
  getStreamFps(): number {
    return this.streamFps;
  }

  /**
   * Changes the frame rate (the Admin page's setting) and restarts every
   * open capture's ffmpeg on it straight away - the rate is part of its
   * filter graph. Each capture keeps its consumer and queued frames, so the
   * analysis just sees a few seconds' gap while the stream reconnects.
   */
  setStreamFps(fps: number): void {
    if (fps === this.streamFps) return;
    this.streamFps = fps;
    for (const capture of this.openCaptures) capture.restart();
  }
}

interface FrameSize {
  width: number;
  height: number;
}

interface CaptureSupervision {
  stallTimeoutMs: number;
  restartDelayMs: number;
  maxRestartDelayMs: number;
}

/**
 * One camera's long-running ffmpeg capture: spawns the process, splits its
 * raw-video stdout back into discrete fixed-size frames, hands them out one per `next()`,
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
  /** The frame currently being filled from stdout, and how many of its bytes have arrived. */
  private pending: Uint8Array;
  private pendingBytes = 0;
  private readonly frameBytes: number;
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
  /**
   * Presentation times reported by ffmpeg's `showinfo` filter, keyed by the
   * frame's index within the current process run. stderr and stdout are
   * separate pipes with no ordering between them, so a frame is matched to
   * its time by index rather than by arrival order - a time arriving a beat
   * after its frame then costs that one frame its `streamTime`, instead of
   * shifting every later frame onto its neighbour's time.
   */
  private streamTimes = new Map<number, number>();
  /** Incomplete trailing stderr line, carried over to the next chunk. */
  private stderrRemainder = '';
  /** `showinfo`'s time base for the current run, once logged. */
  private showinfoTimeBase: { num: number; den: number } | null = null;
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
  /** Lifetime supervision counters - see `counters()`. Unlike `lastError`, `lastFailure` survives the next good frame. */
  private starts = 0;
  private stalls = 0;
  private dropped = 0;
  private lastFailure: string | null = null;
  private everDecoded = false;

  constructor(
    private readonly spawn: () => FfmpegStreamHandle,
    private readonly frameSize: FrameSize,
    private readonly timeoutMs: number,
    private readonly maxQueuedFrames: number,
    private readonly supervision: CaptureSupervision,
    private readonly onClose: () => void = () => undefined,
  ) {
    this.frameBytes = yuv420pFrameSize(frameSize.width, frameSize.height);
    this.pending = new Uint8Array(this.frameBytes);
  }

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

  counters(): CaptureCounters {
    return {
      starts: this.starts,
      stalls: this.stalls,
      dropped: this.dropped,
      lastFrameAt: this.everDecoded ? new Date(this.lastFrameAt).toISOString() : null,
      lastError: this.lastFailure,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.handle?.kill();
    this.handle = null;
    this.failWaiters('capture closed');
    this.onClose();
  }

  /**
   * Replaces the running ffmpeg with a fresh one (new arguments - see
   * `FrameGrabber.setStreamFps`). Not a failure: no backoff, nothing logged
   * as the last error, and a `next()` already waiting is served by the new
   * process. A capture not started yet, or waiting out a restart delay,
   * picks the new arguments up on its next start anyway.
   */
  restart(): void {
    if (this.closed || !this.handle) return;
    const handle = this.handle;
    this.handle = null;
    handle.kill();
    this.clearTimers();
    this.failedRuns = 0;
    this.startProcess();
  }

  private startProcess(): void {
    this.restartTimer = null;
    if (this.closed || this.handle) return;

    // A new process starts at a frame boundary; a partial frame left by the
    // previous one must not be glued onto its first bytes.
    this.pendingBytes = 0;
    this.framesThisRun = 0;
    this.streamTimes.clear();
    this.stderrRemainder = '';
    this.showinfoTimeBase = null;
    this.lastFrameAt = Date.now();
    this.starts += 1;

    const handle = this.spawn();
    this.handle = handle;

    handle.stdout.on('data', (chunk: Buffer) => {
      if (this.handle === handle) this.onData(chunk);
    });
    handle.stderr.on('data', (chunk: Buffer) => {
      if (this.handle === handle) this.onStderr(chunk);
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
        this.stalls += 1;
        this.lastError = reason;
        this.onProcessEnded(reason);
      } else {
        this.armStallTimer();
      }
    }, wait);
  }

  private onProcessEnded(reason: string): void {
    if (!this.closed) this.lastFailure = reason;
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
   * Reads ffmpeg's log: `showinfo` lines carry each output frame's
   * presentation time, and lines at error severity are kept as the reason
   * to report if the capture fails. Everything else (stream banners,
   * segment opens) is info-level noise.
   */
  private onStderr(chunk: Buffer): void {
    const lines = (this.stderrRemainder + chunk.toString('utf8')).split(/\r?\n/);
    this.stderrRemainder = lines.pop() ?? '';
    for (const line of lines) {
      const frameInfo = SHOWINFO_FRAME_LINE.exec(line);
      if (frameInfo) {
        const index = Number(frameInfo[1]);
        const timeBase = this.showinfoTimeBase;
        const seconds = timeBase ? (Number(frameInfo[2]) * timeBase.num) / timeBase.den : Number(frameInfo[3]);
        // Only frames still to come can claim a time - anything older was
        // already handed out without one.
        if (index >= this.framesThisRun && Number.isFinite(seconds)) this.streamTimes.set(index, seconds);
        continue;
      }
      const timeBase = SHOWINFO_TIME_BASE_LINE.exec(line);
      if (timeBase) {
        const num = Number(timeBase[1]);
        const den = Number(timeBase[2]);
        if (num > 0 && den > 0) this.showinfoTimeBase = { num, den };
        continue;
      }
      const severity = ERROR_LEVEL_TAG.exec(line);
      if (severity) {
        const reason = (line.slice(0, severity.index) + line.slice(severity.index + severity[0].length)).trim();
        if (reason) this.lastError = reason;
      }
    }
  }

  /**
   * Cuts the raw ffmpeg stdout stream into frames. Raw video has no markers
   * to search for: every frame is exactly `frameBytes` long, so chunks are
   * copied into the frame being filled and a frame is complete when it is
   * full. Every frame completed by a chunk is collected, not just the last
   * one - a single stdout chunk can contain several (see `frameQueue`).
   */
  private onData(chunk: Buffer): void {
    const found: Uint8Array[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(this.frameBytes - this.pendingBytes, chunk.length - offset);
      this.pending.set(chunk.subarray(offset, offset + take), this.pendingBytes);
      this.pendingBytes += take;
      offset += take;
      if (this.pendingBytes === this.frameBytes) {
        found.push(this.pending);
        this.pending = new Uint8Array(this.frameBytes);
        this.pendingBytes = 0;
      }
    }

    if (found.length === 0) return;

    const capturedAt = Date.now();
    this.lastFrameAt = capturedAt;
    this.everDecoded = true;
    this.lastError = null;

    // Waiters get first claim on newly-decoded frames (FIFO pairing: the
    // longest-waiting call gets the oldest new frame), then whatever's left
    // joins the queue for the next call to pick up immediately.
    for (const data of found) {
      const index = this.framesThisRun++;
      const streamTime = this.streamTimes.get(index);
      this.streamTimes.delete(index);
      const result: GrabFrameSuccess = {
        ok: true,
        frame: { ...this.frameSize, data },
        capturedAt,
        ...(streamTime === undefined ? {} : { streamTime }),
      };
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(result);
      } else {
        this.frameQueue.push(result);
      }
    }
    // Bounded to the newest `maxQueuedFrames`: if the consumer falls behind,
    // the frames closest to live are the ones worth keeping. The tracker
    // works off each frame's own timestamp, so a dropped frame shows up as a
    // longer gap, not as a vehicle jumping.
    const overflow = this.frameQueue.length - this.maxQueuedFrames;
    if (overflow > 0) {
      this.frameQueue.splice(0, overflow);
      this.dropped += overflow;
    }
  }

  private failWaiters(reason: string): void {
    if (this.waiters.length === 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((settle) => settle({ ok: false, error: reason }));
  }
}

function buildArgs(camera: CameraEntry, size: FrameSize): string[] {
  const args = buildCommonArgs(camera);
  // Grab exactly one frame and emit it as raw video on stdout.
  args.push('-frames:v', '1', '-vf', scaleFilter(size), ...rawVideoOutput());
  return args;
}

function buildStreamArgs(camera: CameraEntry, size: FrameSize, streamFps: number, realtime: boolean): string[] {
  const args = buildCommonArgs(camera, { realtime, streaming: true });
  // Continuously decode, keep `streamFps` frames a second, scale those down
  // and emit them as raw video on stdout - the process is left running until
  // the capture is closed, rather than exiting after one frame. `fps` comes
  // first so only the kept frames are ever scaled. `showinfo` logs each
  // emitted frame's presentation time (kept in the source's own timeline by
  // `-copyts`), which is how a result is later matched to the video picture
  // it came from - see `GrabFrameSuccess.streamTime`.
  args.push('-vf', `fps=${streamFps},${scaleFilter(size)},showinfo`, ...rawVideoOutput());
  return args;
}

function scaleFilter(size: FrameSize): string {
  return `scale=${size.width}:${size.height},format=yuv420p`;
}

function rawVideoOutput(): string[] {
  return ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'];
}

function buildCommonArgs(camera: CameraEntry, mode: { realtime?: boolean; streaming?: boolean } = {}): string[] {
  // A one-off grab logs errors only, so the first stderr line is a reason
  // worth surfacing rather than ffmpeg's version banner. A continuous
  // capture also needs `showinfo`'s info-level frame lines, so it logs at
  // info with each line tagged by severity, and picks the errors back out.
  const args: string[] = ['-hide_banner', '-nostats', '-loglevel', mode.streaming ? 'level+info' : 'error'];
  // One decoding thread per process. Every active camera has its own
  // ffmpeg, so there is already one process per stream to spread across
  // cores; ffmpeg's default of a thread per core on top of that only adds
  // ~20 cameras' worth of contention and per-thread overhead. The same goes
  // for the filter graph (fps + scale), which otherwise also starts a thread
  // per core: with both, each capture runs 8 threads instead of 16.
  args.push('-threads', '1', '-filter_threads', '1');

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
  if (mode.realtime) {
    args.push('-re');
  }
  if (mode.streaming) {
    // Keep the source's own timestamps rather than rebasing them to zero,
    // so `streamTime` is the same clock the browser's player sees.
    args.push('-copyts');
    if (/\.m3u8($|\?)/i.test(camera.url)) args.push('-live_start_index', String(LIVE_START_INDEX));
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
