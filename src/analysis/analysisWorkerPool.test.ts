import { AnalysisWorkerHost, AnalysisWorkerLike, AnalysisWorkerPool, AnalysisWorkerReply, AnalysisWorkerRequest } from './analysisWorkerPool';
import { CameraAnalyzerLike } from './trafficAnalysisService';
import { errorAnalysisResult } from './cameraAnalyzer';
import { CameraEntry } from '../types/camera';
import { VideoFrame } from './videoFrame';

const TIMESTAMP = '2026-01-01T00:00:00.000Z';
const FRAME: VideoFrame = { width: 2, height: 2, data: new Uint8Array(6) };

function camera(id: string, overrides: Partial<CameraEntry> = {}): CameraEntry {
  return { id, name: id, url: `https://example.test/${id}.m3u8`, status: 'active', ...overrides } as CameraEntry;
}

/** An analyzer that reports which worker ran it and how many frames it has seen - its "learned state". */
function makeCountingAnalyzer(workerIndex: number, cameraId: string): CameraAnalyzerLike {
  let frames = 0;
  return {
    analyze: async (_frame, timestamp) => {
      frames += 1;
      return { ...errorAnalysisResult(cameraId, timestamp, ''), error: undefined, totalCount: frames, workerIndex } as never;
    },
    errorResult: (timestamp, error) => errorAnalysisResult(cameraId, timestamp, error),
    dispose: jest.fn(),
  };
}

/**
 * An in-process stand-in for a worker thread: requests go to a real
 * `AnalysisWorkerHost` on a later tick, replies come back through the
 * `message` listener. `hold` keeps replies back so a crash can catch a frame
 * in flight.
 */
class FakeWorker implements AnalysisWorkerLike {
  readonly received: AnalysisWorkerRequest[] = [];
  hold = false;
  terminated = false;
  private readonly listeners: Record<string, Array<(arg: never) => void>> = {};
  private readonly host: AnalysisWorkerHost;

  constructor(readonly index: number, createAnalyzer?: (cameraId: string) => CameraAnalyzerLike) {
    this.host = new AnalysisWorkerHost(createAnalyzer ?? ((cameraId) => makeCountingAnalyzer(index, cameraId)));
  }

  postMessage(message: AnalysisWorkerRequest): void {
    this.received.push(message);
    void Promise.resolve()
      .then(() => this.host.handle(message))
      .then((reply) => {
        if (reply && !this.hold && !this.terminated) this.emit('message', reply);
      });
  }

  on(event: string, listener: (arg: never) => void): this {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }

  emit(event: 'message', reply: AnalysisWorkerReply): void;
  emit(event: 'exit', code: number): void;
  emit(event: string, arg: unknown): void {
    for (const listener of this.listeners[event] ?? []) listener(arg as never);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

function makePool(size: number, createAnalyzer?: (cameraId: string) => CameraAnalyzerLike) {
  const workers: FakeWorker[] = [];
  const pool = new AnalysisWorkerPool({
    size,
    restartDelayMs: 1000,
    createWorker: () => {
      const worker = new FakeWorker(workers.length, createAnalyzer);
      workers.push(worker);
      return worker;
    },
  });
  return { pool, workers };
}

describe('AnalysisWorkerPool', () => {
  it('spreads cameras over the workers and keeps each camera on its own worker', async () => {
    const { pool, workers } = makePool(2);
    const a = pool.createAnalyzer('a', camera('a'));
    const b = pool.createAnalyzer('b', camera('b'));
    const c = pool.createAnalyzer('c', camera('c'));

    const results = await Promise.all([a.analyze(FRAME, TIMESTAMP), b.analyze(FRAME, TIMESTAMP), c.analyze(FRAME, TIMESTAMP)]);
    const second = await a.analyze(FRAME, TIMESTAMP);

    expect(results.map((r) => (r as unknown as { workerIndex: number }).workerIndex)).toEqual([0, 1, 0]);
    expect(results.map((r) => r.cameraId)).toEqual(['a', 'b', 'c']);
    // Same analyzer instance on the same worker: its state carried over.
    expect(second.totalCount).toBe(2);
    expect(workers).toHaveLength(2);
  });

  it("passes the camera's ignore zones to the worker", () => {
    const { pool, workers } = makePool(1);
    const zone: Array<[number, number]> = [[0, 0], [1, 0], [1, 1]];

    pool.createAnalyzer('a', camera('a', { ignoreZones: [{ name: 'fountain', points: zone }] }));

    expect(workers[0].received[0]).toEqual({ type: 'create', cameraId: 'a', ignoreZones: [zone] });
  });

  it('sends only the picture to the worker, not the capture metadata', async () => {
    const { pool, workers } = makePool(1);
    const analyzer = pool.createAnalyzer('a', camera('a'));

    await analyzer.analyze({ ...FRAME, capturedAt: 5, streamTime: 1.5 } as VideoFrame, TIMESTAMP);

    const request = workers[0].received.find((m) => m.type === 'analyze');
    expect(request && request.type === 'analyze' && Object.keys(request.frame).sort()).toEqual(['data', 'height', 'width']);
  });

  it('turns an analysis failure in the worker into an error result', async () => {
    const { pool } = makePool(1, (cameraId) => ({
      analyze: async () => {
        throw new Error('detector exploded');
      },
      errorResult: (timestamp, error) => errorAnalysisResult(cameraId, timestamp, error),
      dispose: () => {},
    }));
    const analyzer = pool.createAnalyzer('a', camera('a'));

    const result = await analyzer.analyze(FRAME, TIMESTAMP);

    expect(result).toEqual(errorAnalysisResult('a', TIMESTAMP, 'detector exploded'));
  });

  it("builds the camera's error result locally, without a round trip", () => {
    const { pool, workers } = makePool(1);
    const analyzer = pool.createAnalyzer('a', camera('a'));

    expect(analyzer.errorResult(TIMESTAMP, 'frame capture timed out')).toEqual(errorAnalysisResult('a', TIMESTAMP, 'frame capture timed out'));
    expect(workers[0].received.filter((m) => m.type === 'analyze')).toHaveLength(0);
  });

  it("fails a dead worker's in-flight frames, then replaces it and rebuilds its cameras", async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick', 'setImmediate'] });
    const { pool, workers } = makePool(1);
    const analyzer = pool.createAnalyzer('a', camera('a'));
    await analyzer.analyze(FRAME, TIMESTAMP);
    workers[0].hold = true;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const inFlight = analyzer.analyze(FRAME, TIMESTAMP);
    workers[0].emit('exit', 1);

    expect((await inFlight).error).toBe('analysis worker exited with code 1');
    // Until its replacement is up, frames fail straight away with the reason.
    expect((await analyzer.analyze(FRAME, TIMESTAMP)).error).toBe('analysis worker exited with code 1');
    expect(workers).toHaveLength(1);

    jest.advanceTimersByTime(1000);

    expect(workers).toHaveLength(2);
    expect(workers[1].received[0]).toEqual({ type: 'create', cameraId: 'a', ignoreZones: undefined });
    // The new worker's analyzer starts from scratch.
    expect((await analyzer.analyze(FRAME, TIMESTAMP)).totalCount).toBe(1);
    errorSpy.mockRestore();
    jest.useRealTimers();
  });

  it('drops a disposed camera on its worker and stops analyzing it', async () => {
    const { pool, workers } = makePool(1);
    const analyzer = pool.createAnalyzer('a', camera('a'));

    analyzer.dispose();

    expect(workers[0].received).toContainEqual({ type: 'dispose', cameraId: 'a' });
    expect((await analyzer.analyze(FRAME, TIMESTAMP)).error).toBe('Analysis stopped');
  });

  it('starts no worker until a camera is created, and only as many as there are cameras', () => {
    const { pool, workers } = makePool(2);
    expect(workers).toHaveLength(0);
    expect(pool.runningWorkers).toBe(0);

    pool.createAnalyzer('a', camera('a'));

    expect(workers).toHaveLength(1);
    expect(pool.runningWorkers).toBe(1);
  });

  it("stops a worker once its last camera is disposed, and starts a new one for the next camera", async () => {
    const { pool, workers } = makePool(1);
    const a = pool.createAnalyzer('a', camera('a'));
    const b = pool.createAnalyzer('b', camera('b'));

    a.dispose();
    expect(workers[0].terminated).toBe(false);
    b.dispose();
    expect(workers[0].terminated).toBe(true);
    expect(pool.runningWorkers).toBe(0);

    const c = pool.createAnalyzer('c', camera('c'));
    expect(workers).toHaveLength(2);
    expect((await c.analyze(FRAME, TIMESTAMP)).totalCount).toBe(1);
  });

  it('does not restart a dead worker whose cameras were all disposed meanwhile', () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick', 'setImmediate'] });
    const { pool, workers } = makePool(1);
    const analyzer = pool.createAnalyzer('a', camera('a'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    workers[0].emit('exit', 1);
    analyzer.dispose();
    jest.advanceTimersByTime(1000);

    expect(workers).toHaveLength(1);
    expect(pool.runningWorkers).toBe(0);
    errorSpy.mockRestore();
    jest.useRealTimers();
  });

  it('resolves in-flight frames as errors and terminates the workers on close', async () => {
    const { pool, workers } = makePool(2);
    const analyzer = pool.createAnalyzer('a', camera('a'));
    workers[0].hold = true;

    const inFlight = analyzer.analyze(FRAME, TIMESTAMP);
    await pool.close();

    expect((await inFlight).error).toBe('Analysis stopped');
    expect(workers.every((w) => w.terminated)).toBe(true);
  });
});

describe('AnalysisWorkerHost', () => {
  it('answers a frame for a camera it was never asked to create with an error', async () => {
    const host = new AnalysisWorkerHost(() => makeCountingAnalyzer(0, 'a'));

    const reply = await host.handle({ type: 'analyze', id: 7, cameraId: 'a', frame: FRAME, timestamp: TIMESTAMP });

    expect(reply).toEqual({ id: 7, error: 'No analyzer for camera a' });
  });

  it('disposes the old analyzer when a camera is created again', async () => {
    const created: CameraAnalyzerLike[] = [];
    const host = new AnalysisWorkerHost((cameraId) => {
      const analyzer = makeCountingAnalyzer(0, cameraId);
      created.push(analyzer);
      return analyzer;
    });

    await host.handle({ type: 'create', cameraId: 'a' });
    await host.handle({ type: 'create', cameraId: 'a' });

    expect(created[0].dispose).toHaveBeenCalled();
    expect(created[1].dispose).not.toHaveBeenCalled();
  });
});
