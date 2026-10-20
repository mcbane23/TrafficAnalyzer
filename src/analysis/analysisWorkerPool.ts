import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { CameraAnalysisResult } from '../types/analysis';
import { CameraEntry } from '../types/camera';
import { CameraAnalyzer, errorAnalysisResult } from './cameraAnalyzer';
import type { CameraAnalyzerLike } from './trafficAnalysisService';
import { VideoFrame } from './videoFrame';
import { NormalizedPolygon } from './backgroundModel';

/** What the main thread sends a worker. */
export type AnalysisWorkerRequest =
  | { type: 'create'; cameraId: string; ignoreZones?: NormalizedPolygon[] }
  | { type: 'analyze'; id: number; cameraId: string; frame: VideoFrame; timestamp: string }
  | { type: 'dispose'; cameraId: string };

/** What a worker answers an `analyze` request with. */
export type AnalysisWorkerReply =
  | { id: number; result: CameraAnalysisResult }
  | { id: number; error: string };

/**
 * The worker side: one `CameraAnalyzer` per camera assigned to this worker,
 * created, fed and dropped by the main thread's messages. Kept apart from the
 * `worker_threads` wiring (see analysisWorker.ts) so it can be driven
 * directly in tests.
 */
export class AnalysisWorkerHost {
  private readonly analyzers = new Map<string, CameraAnalyzerLike>();

  constructor(
    private readonly createAnalyzer: (cameraId: string, ignoreZones?: NormalizedPolygon[]) => CameraAnalyzerLike = (cameraId, ignoreZones) =>
      new CameraAnalyzer(cameraId, { ignoreZones }),
  ) {}

  /** Handles one request; resolves with the reply to post back, or null when the request has none. */
  async handle(request: AnalysisWorkerRequest): Promise<AnalysisWorkerReply | null> {
    switch (request.type) {
      case 'create':
        this.analyzers.get(request.cameraId)?.dispose();
        this.analyzers.set(request.cameraId, this.createAnalyzer(request.cameraId, request.ignoreZones));
        return null;
      case 'dispose':
        this.analyzers.get(request.cameraId)?.dispose();
        this.analyzers.delete(request.cameraId);
        return null;
      case 'analyze': {
        const analyzer = this.analyzers.get(request.cameraId);
        if (!analyzer) return { id: request.id, error: `No analyzer for camera ${request.cameraId}` };
        try {
          return { id: request.id, result: await analyzer.analyze(request.frame, request.timestamp) };
        } catch (err) {
          return { id: request.id, error: err instanceof Error ? err.message : 'Analysis failed' };
        }
      }
    }
  }
}

/** The slice of `worker_threads.Worker` the pool uses, so tests can wire a host in-process instead. */
export interface AnalysisWorkerLike {
  postMessage(message: AnalysisWorkerRequest): void;
  on(event: 'message', listener: (reply: AnalysisWorkerReply) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export interface AnalysisWorkerPoolOptions {
  /** Worker threads to spread cameras over. Defaults to 2. */
  size?: number;
  /** Starts one worker. Defaults to a real `worker_threads` worker running analysisWorker. */
  createWorker?: () => AnalysisWorkerLike;
  /** Wait before replacing a worker that died. Defaults to 1000 ms. */
  restartDelayMs?: number;
}

interface PoolWorker {
  worker: AnalysisWorkerLike;
  /** Cameras assigned to this worker, with what it needs to rebuild them after a crash. */
  cameras: Map<string, NormalizedPolygon[] | undefined>;
  pending: Map<number, { resolve: (result: CameraAnalysisResult) => void; cameraId: string; timestamp: string }>;
  /** Why the worker is dead, while it waits to be replaced. */
  down: string | null;
}

/**
 * Runs every camera's motion analysis on worker threads instead of the main
 * thread.
 *
 * On a 4-core N150 the main Node thread was the bottleneck, not the CPU as a
 * whole (231% of 400% busy): the fleet's background subtraction and tracking
 * for 22 cameras at 3 fps, plus the live overlay's YOLO pre- and
 * post-processing, all ran on it. While it was busy it read the overlay's
 * ffmpeg pipe late, so that ffmpeg ran at 0.33-0.73x real time and the player
 * overtook the boxes. At ANALYSIS_FPS=1 the overlay was back at 1.00x, which
 * confirmed it. Moving the fleet's analysis here leaves the main thread to
 * captures, the overlay and the HTTP server.
 *
 * Each camera stays on one worker for its whole life, since its analyzer's
 * learned background and tracks live there. `createAnalyzer` returns a
 * `CameraAnalyzerLike`, so `TrafficAnalysisService` doesn't know the
 * difference. A worker that dies fails its in-flight frames as error results
 * and is replaced; its cameras start learning their background again.
 */
export class AnalysisWorkerPool {
  private readonly workers: PoolWorker[] = [];
  private readonly createWorker: () => AnalysisWorkerLike;
  private readonly restartDelayMs: number;
  private nextWorker = 0;
  private nextId = 1;
  private closed = false;

  constructor(options: AnalysisWorkerPoolOptions = {}) {
    this.createWorker = options.createWorker ?? defaultCreateWorker;
    this.restartDelayMs = options.restartDelayMs ?? 1000;
    const size = Math.max(1, Math.floor(options.size ?? 2));
    for (let i = 0; i < size; i++) {
      const entry: PoolWorker = { worker: null as unknown as AnalysisWorkerLike, cameras: new Map(), pending: new Map(), down: null };
      this.workers.push(entry);
      this.spawn(entry);
    }
  }

  /** A `CameraAnalyzerLike` whose analysis runs on one of the pool's workers (assigned round robin). */
  createAnalyzer(cameraId: string, camera: CameraEntry): CameraAnalyzerLike {
    const entry = this.workers[this.nextWorker];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    const ignoreZones = camera.ignoreZones?.map((zone) => zone.points);
    entry.cameras.set(cameraId, ignoreZones);
    entry.worker.postMessage({ type: 'create', cameraId, ignoreZones });

    return {
      analyze: (frame, timestamp) =>
        new Promise<CameraAnalysisResult>((resolve) => {
          if (this.closed || !entry.cameras.has(cameraId)) {
            resolve(errorAnalysisResult(cameraId, timestamp, 'Analysis stopped'));
            return;
          }
          if (entry.down !== null) {
            resolve(errorAnalysisResult(cameraId, timestamp, entry.down));
            return;
          }
          const id = this.nextId++;
          entry.pending.set(id, { resolve, cameraId, timestamp });
          // Only the picture crosses over: the frame object also carries
          // capture metadata the analyzer doesn't use.
          entry.worker.postMessage({
            type: 'analyze',
            id,
            cameraId,
            frame: { width: frame.width, height: frame.height, data: frame.data },
            timestamp,
          });
        }),
      errorResult: (timestamp, error) => errorAnalysisResult(cameraId, timestamp, error),
      dispose: () => {
        if (!entry.cameras.delete(cameraId) || this.closed) return;
        entry.worker.postMessage({ type: 'dispose', cameraId });
      },
    };
  }

  /** Stops every worker. In-flight frames resolve as error results. */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.workers) this.failPending(entry, 'Analysis stopped');
    await Promise.all(this.workers.map((entry) => entry.worker.terminate()));
  }

  private spawn(entry: PoolWorker): void {
    const worker = this.createWorker();
    entry.worker = worker;
    entry.down = null;
    worker.on('message', (reply) => {
      const pending = entry.pending.get(reply.id);
      if (!pending) return;
      entry.pending.delete(reply.id);
      pending.resolve('result' in reply ? reply.result : errorAnalysisResult(pending.cameraId, pending.timestamp, reply.error));
    });
    let replaced = false;
    const replace = (reason: string) => {
      if (replaced || entry.worker !== worker) return;
      replaced = true;
      entry.down = reason;
      this.failPending(entry, reason);
      if (this.closed) return;
      console.error(`[AnalysisWorkerPool] ${reason}, restarting it`);
      // Frames meanwhile get `reason` as their error. The delay keeps a
      // worker that dies on startup from restarting in a tight loop.
      setTimeout(() => {
        if (this.closed) return;
        this.spawn(entry);
        for (const [cameraId, ignoreZones] of entry.cameras) entry.worker.postMessage({ type: 'create', cameraId, ignoreZones });
      }, this.restartDelayMs).unref();
    };
    worker.on('error', (err) => replace(`analysis worker failed: ${err.message}`));
    worker.on('exit', (code) => replace(`analysis worker exited with code ${code}`));
  }

  private failPending(entry: PoolWorker, reason: string): void {
    for (const pending of entry.pending.values()) {
      pending.resolve(errorAnalysisResult(pending.cameraId, pending.timestamp, reason));
    }
    entry.pending.clear();
  }
}

/**
 * The worker script next to this file: analysisWorker.js once built, or
 * analysisWorker.ts under `tsx` (`npm run dev`). A worker thread doesn't
 * inherit tsx's loader, so in that case it registers it before loading the
 * script.
 */
function defaultCreateWorker(): AnalysisWorkerLike {
  const extension = path.extname(__filename);
  const script = path.join(__dirname, `analysisWorker${extension}`);
  if (extension !== '.ts') return new Worker(script);
  return new Worker(`require('tsx/cjs/api').register(); require(${JSON.stringify(script)});`, { eval: true });
}
