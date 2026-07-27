import { CameraEntry, ValidationResult } from '../types/camera';
import { ProbeRunner, createFfprobeRunner } from './probeRunner';

export interface CameraValidatorOptions {
  /** Per-camera probe timeout, in milliseconds. Defaults to 15000. */
  timeoutMs?: number;
  /** Injectable probe runner, primarily used for testing. */
  probeRunner?: ProbeRunner;
  /** Path to the ffprobe executable, if not on PATH. Ignored if `probeRunner` is supplied. */
  ffprobePath?: string;
  /** Injectable clock, primarily used for testing. */
  now?: () => Date;
}

interface FfprobeStream {
  width?: number;
  height?: number;
}

interface FfprobeJson {
  streams?: FfprobeStream[];
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * CameraValidator is the deep module at the heart of this feature: given a
 * single camera entry, it determines whether the camera is genuinely
 * streaming decodable video right now.
 *
 * It does this by shelling out to `ffprobe` and asking it to pull real
 * stream metadata (not just checking for an HTTP 200 / open socket), so a
 * camera that responds but serves a broken or blank stream is correctly
 * reported as not working.
 *
 * The module has no file-system knowledge and no orchestration logic -
 * camera entry in, `ValidationResult` out - which keeps it simple to unit
 * test in isolation by injecting a fake `ProbeRunner`.
 */
export class CameraValidator {
  private readonly timeoutMs: number;
  private readonly probeRunner: ProbeRunner;
  private readonly now: () => Date;

  constructor(options: CameraValidatorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.probeRunner = options.probeRunner ?? createFfprobeRunner(options.ffprobePath);
    this.now = options.now ?? (() => new Date());
  }

  async validate(camera: CameraEntry): Promise<ValidationResult> {
    const startedAt = Date.now();
    const checkedAt = this.now().toISOString();

    let outcome;
    try {
      outcome = await this.probeRunner(this.buildArgs(camera), this.timeoutMs);
    } catch (err) {
      return {
        cameraId: camera.id,
        status: 'inactive',
        checkedAt,
        error: `probe failed to run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const latencyMs = Date.now() - startedAt;

    if (outcome.timedOut) {
      return { cameraId: camera.id, status: 'inactive', checkedAt, latencyMs, error: 'stream timed out' };
    }

    if (outcome.exitCode !== 0) {
      const reason = this.firstNonEmptyLine(outcome.stderr) ?? `ffprobe exited with code ${outcome.exitCode}`;
      return { cameraId: camera.id, status: 'inactive', checkedAt, latencyMs, error: reason };
    }

    let parsed: FfprobeJson;
    try {
      parsed = JSON.parse(outcome.stdout) as FfprobeJson;
    } catch {
      return { cameraId: camera.id, status: 'inactive', checkedAt, latencyMs, error: 'could not parse ffprobe output' };
    }

    const videoStream = parsed.streams?.find((s) => typeof s.width === 'number' && typeof s.height === 'number');
    if (!videoStream) {
      return { cameraId: camera.id, status: 'inactive', checkedAt, latencyMs, error: 'no decodable video stream found' };
    }

    return {
      cameraId: camera.id,
      status: 'active',
      checkedAt,
      latencyMs,
      resolution: `${videoStream.width}x${videoStream.height}`,
    };
  }

  private buildArgs(camera: CameraEntry): string[] {
    const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json'];
    if (camera.protocol === 'RTSP') {
      // Prefer TCP for RTSP: more likely to traverse firewalls/NATs than the UDP default.
      args.push('-rtsp_transport', 'tcp');
    }
    args.push(camera.url);
    return args;
  }

  private firstNonEmptyLine(text: string): string | undefined {
    return text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
  }
}
