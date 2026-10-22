import fs from 'node:fs';
import path from 'node:path';
import { CameraEntry } from '../types/camera';
import { CameraAnalysisResult } from '../types/analysis';
import { AccuracyCheck, AccuracyCheckSummary, CheckPassage, ManualCount, countEvents } from '../types/accuracy';
import { CameraPassageModel } from './passageModel';
import { VideoFrame } from './videoFrame';

/** Seconds the user can choose to compare; the default first. */
export const CHECK_DURATIONS = [300, 120, 600];
/** Clip seconds the motion analysis gets to learn the background before counting starts. */
export const CHECK_WARMUP_SEC = 15;
/** The last seconds are not compared: a vehicle still in view when the clip ends never finishes its track. */
const CHECK_TAIL_SEC = 5;
/** Checks kept (oldest deleted first), and how many of them keep their clip (~10-40 MB each). */
const KEEP_CHECKS = 30;
const KEEP_CLIPS = 5;

export interface AccuracyCheckDeps {
  /** Where checks are kept: `<dir>/<id>/check.json` and `<dir>/<id>/clip.mp4`. */
  dir: string;
  getCamera: (cameraId: string) => Promise<CameraEntry | undefined>;
  /** Records `seconds` of the camera into `file` (see `recordClip`). */
  record: (camera: CameraEntry, file: string, seconds: number) => Promise<void>;
  /** Decodes `file` at `fps` into analysis frames (see `decodeClip`). */
  decode: (file: string, fps: number, onFrame: (frame: VideoFrame, index: number) => Promise<void>) => Promise<void>;
  /** A fresh analyzer for this camera, built like the live one (same ignore zones). */
  createAnalyzer: (camera: CameraEntry) => { analyze(frame: VideoFrame, timestamp: string): Promise<CameraAnalysisResult>; dispose?(): void };
  /** A passage model seeded with the camera's learned road axis, so A and B mean what they mean in the statistics. */
  passageModel: (cameraId: string) => CameraPassageModel;
  analysisFps: () => number;
  now?: () => Date;
}

/** A refused request; `status` is the HTTP status to answer with. */
export class AccuracyCheckError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'busy' | 'not-found' | 'no-camera' | 'not-ready',
  ) {
    super(message);
  }
}

/**
 * Checks how well the vehicle count matches reality, one camera and a few
 * minutes at a time: records a clip of the camera, runs the same motion
 * analysis on it as runs live (same frame rate, ignore zones and learned
 * road axis), and keeps the vehicles it counted with their time in the clip.
 * The Admin page plays the clip, the user clicks once per vehicle and
 * direction, and the two counts are compared over the same stretch.
 *
 * One check runs at a time (a small server should not record and decode
 * several streams on top of the live analysis). Checks are kept as JSON in
 * the data volume; only the last few keep their clip.
 */
export class AccuracyCheckService {
  private readonly now: () => Date;
  private running: AccuracyCheck | null = null;
  private job: Promise<void> | null = null;

  constructor(private readonly deps: AccuracyCheckDeps) {
    this.now = deps.now ?? (() => new Date());
    // A check the server was stopped in the middle of will never finish.
    for (const id of this.ids()) {
      const check = this.get(id);
      if (check && (check.state === 'recording' || check.state === 'analyzing')) {
        this.save({ ...check, state: 'failed', error: 'The server was restarted during the check.' });
      }
    }
  }

  /** Starts a check; refused while another one records or analyzes. */
  async start(cameraId: unknown, durationSec: unknown): Promise<AccuracyCheck> {
    if (this.running) throw new AccuracyCheckError('A check is already running.', 409, 'busy');
    const camera = typeof cameraId === 'string' ? await this.deps.getCamera(cameraId) : undefined;
    if (!camera || camera.hidden || camera.status !== 'active') {
      throw new AccuracyCheckError('Pick an active camera.', 400, 'no-camera');
    }
    const duration = CHECK_DURATIONS.includes(Number(durationSec)) ? Number(durationSec) : CHECK_DURATIONS[0];
    const createdAt = this.now();
    const check: AccuracyCheck = {
      id: `${createdAt.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-${camera.id}`,
      cameraId: camera.id,
      cameraName: camera.name,
      ...(camera.directions ? { directions: camera.directions } : {}),
      createdAt: createdAt.toISOString(),
      state: 'recording',
      progress: 0,
      durationSec: duration,
      warmupSec: CHECK_WARMUP_SEC,
      analysisFps: null,
      countFrom: CHECK_WARMUP_SEC,
      countTo: CHECK_WARMUP_SEC + duration - CHECK_TAIL_SEC,
      axis: null,
      passages: [],
      manual: null,
      manualSavedAt: null,
      hasClip: false,
    };
    this.running = check;
    fs.mkdirSync(this.checkDir(check.id), { recursive: true });
    this.save(check);
    this.job = this.run(check, camera).finally(() => {
      this.running = null;
      this.job = null;
    });
    return { ...check };
  }

  /** Resolves once the running check (if any) is through - for tests and shutdown. */
  async idle(): Promise<void> {
    await this.job;
  }

  list(): AccuracyCheckSummary[] {
    return this.ids()
      .map((id) => this.get(id))
      .filter((check): check is AccuracyCheck => check !== null)
      .map((check) => ({
        id: check.id,
        cameraId: check.cameraId,
        cameraName: check.cameraName,
        createdAt: check.createdAt,
        state: check.state,
        durationSec: check.durationSec,
        app: check.state === 'ready' ? countEvents(check.passages, check.countFrom, check.countTo) : null,
        manual: check.manual ? countEvents(check.manual, check.countFrom, check.countTo) : null,
      }));
  }

  get(id: string): AccuracyCheck | null {
    if (this.running?.id === id) return { ...this.running };
    if (!/^[\w-]+$/.test(id)) return null;
    try {
      const check = JSON.parse(fs.readFileSync(path.join(this.checkDir(id), 'check.json'), 'utf8')) as AccuracyCheck;
      return { ...check, hasClip: fs.existsSync(this.clipPath(id)) };
    } catch {
      return null;
    }
  }

  /** The recorded clip's path, or null once it is deleted or while it is still being recorded. */
  clipFile(id: string): string | null {
    const check = this.get(id);
    if (!check || check.state === 'recording' || !check.hasClip) return null;
    return this.clipPath(id);
  }

  /** Saves the user's own count (replacing an earlier one), times clamped into the clip. */
  saveManual(id: string, input: unknown): AccuracyCheck {
    const check = this.get(id);
    if (!check) throw new AccuracyCheckError(`Check not found: ${id}`, 404, 'not-found');
    if (check.state !== 'ready') throw new AccuracyCheckError('The check is not ready yet.', 409, 'not-ready');
    const raw = Array.isArray((input as { clicks?: unknown })?.clicks) ? (input as { clicks: unknown[] }).clicks : [];
    const end = check.warmupSec + check.durationSec;
    const manual: ManualCount[] = raw
      .slice(0, 5000)
      .flatMap((click): ManualCount[] => {
        const { t, direction } = (click ?? {}) as { t?: unknown; direction?: unknown };
        if (typeof t !== 'number' || !Number.isFinite(t)) return [];
        return [{ t: Math.round(Math.min(end, Math.max(0, t)) * 100) / 100, direction: direction === 'A' || direction === 'B' ? direction : null }];
      })
      .sort((a, b) => a.t - b.t);
    const saved: AccuracyCheck = { ...check, manual, manualSavedAt: this.now().toISOString() };
    this.save(saved);
    return saved;
  }

  private async run(check: AccuracyCheck, camera: CameraEntry): Promise<void> {
    const clip = this.clipPath(check.id);
    const recordSec = check.warmupSec + check.durationSec;
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      check.progress = Math.min(0.99, (Date.now() - startedAt) / 1000 / recordSec);
    }, 1000);
    ticker.unref?.();
    try {
      await this.deps.record(camera, clip, recordSec);
      clearInterval(ticker);
      Object.assign(check, { state: 'analyzing', progress: 0, hasClip: true });
      this.save(check);
      this.pruneOld(check.id);

      const fps = this.deps.analysisFps();
      check.analysisFps = fps;
      const analyzer = this.deps.createAnalyzer(camera);
      const model = this.deps.passageModel(camera.id);
      check.axis = model.direction.axis();
      const base = Date.parse(check.createdAt);
      const passages: CheckPassage[] = [];
      let warmUntil: number | null = null;
      let lastFrameSec = 0;
      const expected = recordSec * fps;
      try {
        await this.deps.decode(clip, fps, async (frame, index) => {
          const seconds = index / fps;
          lastFrameSec = seconds;
          const result = await analyzer.analyze(frame, new Date(base + seconds * 1000).toISOString());
          if (!result.error && !result.warmingUp) {
            warmUntil ??= seconds;
            for (const track of result.finishedTracks ?? []) {
              const passage = model.toPassage(track);
              const mid = (Date.parse(track.firstSeen) + Date.parse(track.lastSeen)) / 2;
              passages.push({ t: Math.round(((mid - base) / 1000) * 100) / 100, direction: passage.direction, sizeClass: passage.sizeClass });
            }
          }
          check.progress = Math.min(0.99, (index + 1) / expected);
          // Let HTTP requests and the live analysis in between frames.
          if (index % 10 === 9) await new Promise((resolve) => setImmediate(resolve));
        });
      } finally {
        analyzer.dispose?.();
      }
      if (warmUntil === null) throw new Error('The analysis produced no usable frame from the clip.');
      check.countFrom = Math.max(check.warmupSec, Math.ceil(warmUntil));
      // A stream that dropped out early leaves a shorter clip.
      check.countTo = Math.min(check.countTo, Math.floor(lastFrameSec) - CHECK_TAIL_SEC);
      if (check.countTo <= check.countFrom) throw new Error(`The clip is too short (${Math.round(lastFrameSec)} s).`);
      Object.assign(check, { state: 'ready', progress: 1, passages: passages.sort((a, b) => a.t - b.t) });
    } catch (err) {
      clearInterval(ticker);
      Object.assign(check, { state: 'failed', error: err instanceof Error ? err.message : String(err) });
      console.error(`[AccuracyCheck] check ${check.id} failed:`, err);
    }
    check.hasClip = fs.existsSync(clip);
    this.save(check);
  }

  /** Deletes checks beyond `KEEP_CHECKS`, and the clips of all but the newest `KEEP_CLIPS`. */
  private pruneOld(keepId: string): void {
    const ids = this.ids();
    ids.forEach((id, index) => {
      if (id === keepId) return;
      try {
        if (index >= KEEP_CHECKS) fs.rmSync(this.checkDir(id), { recursive: true, force: true });
        else if (index >= KEEP_CLIPS) fs.rmSync(this.clipPath(id), { force: true });
      } catch (err) {
        console.error(`[AccuracyCheck] could not delete old check ${id}:`, err);
      }
    });
  }

  /** Check ids, newest first (they start with their creation time). */
  private ids(): string[] {
    try {
      return fs
        .readdirSync(this.deps.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  private save(check: AccuracyCheck): void {
    const file = path.join(this.checkDir(check.id), 'check.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(check));
    fs.renameSync(`${file}.tmp`, file);
  }

  private checkDir(id: string): string {
    return path.join(this.deps.dir, id);
  }

  private clipPath(id: string): string {
    return path.join(this.checkDir(id), 'clip.mp4');
  }
}
