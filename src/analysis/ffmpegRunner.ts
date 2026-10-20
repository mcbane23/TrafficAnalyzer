import { execFile, spawn } from 'node:child_process';

/**
 * Path to the ffmpeg binary bundled via `@ffmpeg-installer/ffmpeg`, mirroring
 * how `probeRunner.ts` bundles ffprobe - no system-wide ffmpeg install is
 * required. Loaded on demand, not at import: the Docker image sets
 * `FFMPEG_PATH` and deletes the bundled binaries (~66 MB), so the package must
 * not be required when the override is present.
 */
export function bundledFfmpegPath(): string {
  return (require('@ffmpeg-installer/ffmpeg') as { path: string }).path;
}

/**
 * The ffmpeg actually used by default: `FFMPEG_PATH` from the environment if
 * set, else the bundled binary. The bundled Linux build is a static-glibc
 * build, and static glibc cannot resolve hostnames - it segfaults on any
 * `https://` camera URL whose host needs a DNS lookup, so every live capture
 * dies before producing a frame. On Linux (the Docker image) a system ffmpeg
 * must be supplied this way; see the Dockerfile. The bundled binary is fine
 * for local files, which is all the tests feed it.
 */
export const FFMPEG_PATH = process.env.FFMPEG_PATH || bundledFfmpegPath();

/** Result of running a single ffmpeg invocation. */
export interface FfmpegOutcome {
  /** Process exit code, or null if the process was killed (e.g. on timeout). */
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  /** True if the process was killed because it exceeded the requested timeout. */
  timedOut: boolean;
}

/**
 * A function that runs an ffmpeg command and resolves with its outcome.
 * Kept as a narrow, injectable seam so `FrameGrabber` can be unit tested
 * without spawning real processes.
 */
export type FfmpegRunner = (args: string[], timeoutMs: number) => Promise<FfmpegOutcome>;

/**
 * Creates an `FfmpegRunner` that shells out to a real `ffmpeg` binary.
 *
 * Defaults to the platform binary bundled via `@ffmpeg-installer/ffmpeg`.
 * Pass an explicit path to use a different (e.g. system-installed) ffmpeg
 * instead.
 */
export function createFfmpegRunner(ffmpegPath: string = FFMPEG_PATH): FfmpegRunner {
  return (args, timeoutMs) =>
    new Promise<FfmpegOutcome>((resolve) => {
      execFile(
        ffmpegPath,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 20 * 1024 * 1024, encoding: 'buffer' },
        (error, stdout, stderr) => {
          const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
          const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');

          if (!error) {
            resolve({ exitCode: 0, stdout: stdoutBuffer, stderr: stderrText, timedOut: false });
            return;
          }

          const errWithMeta = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
          resolve({
            exitCode: typeof errWithMeta.code === 'number' ? errWithMeta.code : null,
            stdout: stdoutBuffer,
            stderr: stderrText,
            timedOut: !!errWithMeta.killed,
          });
        },
      );
    });
}

/**
 * A long-lived ffmpeg invocation that keeps decoding and emitting frames
 * on `stdout` until `kill()` is called, rather than exiting after a
 * single outcome. Used for each camera's continuous capture, where
 * re-spawning ffmpeg (and reconnecting/re-buffering the HLS stream from
 * scratch) per frame is far too slow to hit multiple frames per second -
 * see `FrameGrabber.openCapture`.
 */
export interface FfmpegStreamHandle {
  stdout: NodeJS.ReadableStream;
  /** Emits Buffer chunks of stderr text, e.g. for diagnosing why the process later exits/errors. */
  stderr: NodeJS.ReadableStream;
  /** Fires once, when the underlying process exits or fails to spawn. */
  onExit(callback: (reason: string) => void): void;
  kill(): void;
}

/**
 * A function that starts a long-running ffmpeg process and returns a
 * handle to its output streams. Kept as a narrow, injectable seam so
 * `FrameGrabber`'s streaming mode can be unit tested without spawning a
 * real process.
 */
export type FfmpegStreamRunner = (args: string[]) => FfmpegStreamHandle;

/**
 * Creates an `FfmpegStreamRunner` that shells out to a real, long-running
 * `ffmpeg` process via `spawn` (as opposed to `createFfmpegRunner`'s
 * `execFile`, which waits for the process to exit before resolving).
 */
export function createFfmpegStreamRunner(ffmpegPath: string = FFMPEG_PATH): FfmpegStreamRunner {
  return (args) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let exited = false;
    const exitCallbacks: Array<(reason: string) => void> = [];
    const fireExit = (reason: string) => {
      if (exited) return;
      exited = true;
      exitCallbacks.forEach((cb) => cb(reason));
    };

    child.on('error', (err) => fireExit(`ffmpeg failed to run: ${err.message}`));
    child.on('close', (code) => fireExit(`ffmpeg stream exited with code ${code}`));

    return {
      stdout: child.stdout,
      stderr: child.stderr,
      onExit: (callback) => {
        if (exited) {
          callback('ffmpeg stream already exited');
          return;
        }
        exitCallbacks.push(callback);
      },
      kill: () => {
        if (!child.killed) child.kill('SIGKILL');
      },
    };
  };
}
