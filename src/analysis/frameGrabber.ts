import { CameraEntry } from '../types/camera';
import { FfmpegRunner, FfmpegStreamHandle, FfmpegStreamRunner, createFfmpegRunner, createFfmpegStreamRunner } from './ffmpegRunner';

export interface FrameGrabberOptions {
  /** Per-camera capture timeout, in milliseconds. Defaults to 10000. */
  timeoutMs?: number;
  /** Injectable ffmpeg runner, primarily used for testing. */
  ffmpegRunner?: FfmpegRunner;
  /** Injectable long-running ffmpeg stream runner (used by streaming mode), primarily used for testing. */
  ffmpegStreamRunner?: FfmpegStreamRunner;
  /** Path to the ffmpeg executable, if not on PATH. Ignored if `ffmpegRunner`/`ffmpegStreamRunner` are supplied. */
  ffmpegPath?: string;
  /** Target frames-per-second decoded by a streaming-mode capture. Defaults to 3. */
  streamFps?: number;
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

export interface GrabFrameOptions {
  /**
   * When true, reuses (or starts) a persistent, continuously-decoding
   * ffmpeg process for this camera instead of spawning a one-off process
   * per call, and returns its most recently decoded frame. Dramatically
   * cuts per-tick latency for the boosted "live" sampling rate, since it
   * avoids re-establishing the HLS connection (playlist + segment fetch)
   * on every single call. Callers must eventually call `stopStreaming`
   * for the same camera id once they stop requesting streaming frames,
   * or the background ffmpeg process is leaked.
   */
  streaming?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STREAM_FPS = 3;
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

interface StreamState {
  handle: FfmpegStreamHandle;
  buffer: Buffer;
  latestFrame: Buffer | null;
  lastError: string | null;
  waiters: Array<(result: GrabFrameResult) => void>;
}

/**
 * FrameGrabber invokes ffmpeg against a camera's live stream URL and
 * returns a single decoded frame as a JPEG image buffer, for
 * `VehicleDetector` to run inference against.
 *
 * It reuses the same header-forwarding approach as `CameraValidator`
 * (which does the equivalent for ffprobe) for cameras that require
 * special request headers to defeat hotlink protection - ffmpeg is a
 * native client so, unlike the browser-based player, it can send those
 * headers directly without needing the HLS proxy.
 *
 * Two capture modes are supported. The default (one-off) mode spawns a
 * fresh ffmpeg process per call and waits for it to exit - simple, but
 * each call pays the full cost of reconnecting to the HLS stream
 * (playlist + segment fetch), which is far too slow to hit multiple
 * updates per second. Streaming mode (`{ streaming: true }`) instead
 * keeps a single long-running ffmpeg process per camera continuously
 * decoding frames at a low fixed fps, and simply hands back whatever
 * frame it most recently finished decoding - so repeated calls are
 * near-instant once the stream is warmed up.
 *
 * The module has no orchestration knowledge - camera entry in, a frame
 * buffer (or an error) out - which keeps it simple to unit test in
 * isolation by injecting a fake `FfmpegRunner`/`FfmpegStreamRunner`.
 */
export class FrameGrabber {
  private readonly timeoutMs: number;
  private readonly streamFps: number;
  private readonly ffmpegRunner: FfmpegRunner;
  private readonly ffmpegStreamRunner: FfmpegStreamRunner;
  private readonly streams = new Map<string, StreamState>();

  constructor(options: FrameGrabberOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.streamFps = options.streamFps ?? DEFAULT_STREAM_FPS;
    this.ffmpegRunner = options.ffmpegRunner ?? createFfmpegRunner(options.ffmpegPath);
    this.ffmpegStreamRunner = options.ffmpegStreamRunner ?? createFfmpegStreamRunner(options.ffmpegPath);
  }

  async grabFrame(camera: CameraEntry, options?: GrabFrameOptions): Promise<GrabFrameResult> {
    if (options?.streaming) {
      return this.grabStreamingFrame(camera);
    }

    let outcome;
    try {
      outcome = await this.ffmpegRunner(this.buildArgs(camera), this.timeoutMs);
    } catch (err) {
      return { ok: false, error: `ffmpeg failed to run: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (outcome.timedOut) {
      return { ok: false, error: 'frame capture timed out' };
    }

    if (outcome.exitCode !== 0) {
      const reason = this.firstNonEmptyLine(outcome.stderr) ?? `ffmpeg exited with code ${outcome.exitCode}`;
      return { ok: false, error: reason };
    }

    if (outcome.stdout.length === 0) {
      return { ok: false, error: 'ffmpeg produced no frame data' };
    }

    return { ok: true, buffer: outcome.stdout };
  }

  /** Stops and discards the persistent streaming capture for a camera, if one is running. Safe to call even if none is running. */
  stopStreaming(cameraId: string): void {
    const state = this.streams.get(cameraId);
    if (!state) return;
    this.streams.delete(cameraId);
    state.handle.kill();
    this.failWaiters(state, 'streaming capture stopped');
  }

  private grabStreamingFrame(camera: CameraEntry): Promise<GrabFrameResult> {
    const state = this.ensureStream(camera);

    if (state.latestFrame) {
      return Promise.resolve({ ok: true, buffer: state.latestFrame });
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = state.waiters.indexOf(settle);
        if (idx >= 0) state.waiters.splice(idx, 1);
        resolve({ ok: false, error: state.lastError ?? 'frame capture timed out' });
      }, this.timeoutMs);

      const settle = (result: GrabFrameResult) => {
        clearTimeout(timer);
        resolve(result);
      };
      state.waiters.push(settle);
    });
  }

  private ensureStream(camera: CameraEntry): StreamState {
    const existing = this.streams.get(camera.id);
    if (existing) return existing;

    const handle = this.ffmpegStreamRunner(this.buildStreamArgs(camera));
    const state: StreamState = { handle, buffer: Buffer.alloc(0), latestFrame: null, lastError: null, waiters: [] };
    this.streams.set(camera.id, state);

    handle.stdout.on('data', (chunk: Buffer) => this.onStreamData(state, chunk));
    handle.stderr.on('data', (chunk: Buffer) => {
      const line = this.firstNonEmptyLine(chunk.toString('utf8'));
      if (line) state.lastError = line;
    });
    handle.onExit((reason) => {
      // The process died (or never started) - drop the state so the next
      // call transparently starts a fresh one, and unblock anyone waiting.
      if (this.streams.get(camera.id) === state) this.streams.delete(camera.id);
      this.failWaiters(state, reason);
    });

    return state;
  }

  private onStreamData(state: StreamState, chunk: Buffer): void {
    state.buffer = state.buffer.length ? Buffer.concat([state.buffer, chunk]) : chunk;

    let searchFrom = 0;
    let latest: Buffer | null = null;
    for (;;) {
      const soi = state.buffer.indexOf(JPEG_SOI, searchFrom);
      if (soi === -1) break;
      const eoi = state.buffer.indexOf(JPEG_EOI, soi + JPEG_SOI.length);
      if (eoi === -1) break;
      latest = state.buffer.subarray(soi, eoi + JPEG_EOI.length);
      searchFrom = eoi + JPEG_EOI.length;
    }

    if (searchFrom > 0) {
      state.buffer = Buffer.from(state.buffer.subarray(searchFrom));
    }

    if (!latest) return;
    state.latestFrame = Buffer.from(latest);
    if (state.waiters.length === 0) return;
    const waiters = state.waiters;
    state.waiters = [];
    waiters.forEach((settle) => settle({ ok: true, buffer: state.latestFrame! }));
  }

  private failWaiters(state: StreamState, reason: string): void {
    if (state.waiters.length === 0) return;
    const waiters = state.waiters;
    state.waiters = [];
    waiters.forEach((settle) => settle({ ok: false, error: reason }));
  }

  private buildArgs(camera: CameraEntry): string[] {
    const args = this.buildCommonArgs(camera);
    // Grab exactly one frame and emit it as a JPEG on stdout.
    args.push('-frames:v', '1', '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1');
    return args;
  }

  private buildStreamArgs(camera: CameraEntry): string[] {
    const args = this.buildCommonArgs(camera);
    // Continuously decode at a low fixed fps and emit each frame as a JPEG
    // on stdout - the process is left running until `stopStreaming` kills
    // it, rather than exiting after one frame.
    args.push('-vf', `fps=${this.streamFps}`, '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1');
    return args;
  }

  private buildCommonArgs(camera: CameraEntry): string[] {
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

  private firstNonEmptyLine(text: string): string | undefined {
    return text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
  }
}
