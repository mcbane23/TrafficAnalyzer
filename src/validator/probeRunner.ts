import { execFile } from 'node:child_process';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

/**
 * Path to the ffprobe binary bundled via `@ffprobe-installer/ffprobe`. Used as
 * the default so the app works standalone, without requiring ffmpeg to be
 * installed separately on the host machine.
 */
export const BUNDLED_FFPROBE_PATH = ffprobeInstaller.path;

/**
 * Result of running a single ffprobe invocation.
 */
export interface ProbeOutcome {
  /** Process exit code, or null if the process was killed (e.g. on timeout). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True if the process was killed because it exceeded the requested timeout. */
  timedOut: boolean;
}

/**
 * A function that runs a probe command and resolves with its outcome.
 * Kept as a narrow, injectable seam so `CameraValidator` can be unit
 * tested without spawning real processes.
 */
export type ProbeRunner = (args: string[], timeoutMs: number) => Promise<ProbeOutcome>;

/**
 * Creates a `ProbeRunner` that shells out to a real `ffprobe` binary.
 *
 * Defaults to the platform binary bundled via `@ffprobe-installer/ffprobe`,
 * so no system-wide ffmpeg install is required. Pass an explicit path to use
 * a different (e.g. system-installed) ffprobe instead.
 */
export function createFfprobeRunner(ffprobePath: string = BUNDLED_FFPROBE_PATH): ProbeRunner {
  return (args, timeoutMs) =>
    new Promise<ProbeOutcome>((resolve) => {
      execFile(
        ffprobePath,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ exitCode: 0, stdout, stderr, timedOut: false });
            return;
          }

          const errWithMeta = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
          resolve({
            exitCode: typeof errWithMeta.code === 'number' ? errWithMeta.code : null,
            stdout,
            stderr,
            timedOut: !!errWithMeta.killed,
          });
        },
      );
    });
}
