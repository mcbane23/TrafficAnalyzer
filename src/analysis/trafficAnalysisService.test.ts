import {
  AnalysisScheduler,
  CameraAnalyzerLike,
  FrameGrabberLike,
  TrafficAnalysisService,
  TrafficAnalysisServiceOptions,
  TrafficHistoryStoreLike,
} from './trafficAnalysisService';
import { CameraSource } from '../server/cameraService';
import { CameraEntry } from '../types/camera';
import { CameraAnalysisOverview, CameraAnalysisResult, StoredAnalysisResult } from '../types/analysis';
import { FrameCapture, GrabFrameResult } from './frameGrabber';
import { VideoFrame } from './videoFrame';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function makeCamera(overrides: Partial<CameraEntry> = {}): CameraEntry {
  return {
    id: 'cam-1',
    name: 'Test Camera',
    location: { address: 'Test Square' },
    resolution: null,
    source: 'Test Source',
    url: 'https://example.com/stream.m3u8',
    protocol: 'HLS',
    status: 'active',
    lastVerifiedAt: null,
    lastError: null,
    ...overrides,
  };
}

function makeSource(entries: CameraEntry[]): CameraSource {
  return { load: jest.fn(async () => entries) };
}

/** A fake scheduler that records scheduled (fn, ms) pairs instead of using real timers. */
function makeFakeScheduler() {
  const scheduled: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  const scheduler: AnalysisScheduler = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      scheduled.push({ id, fn, ms });
      return id;
    },
    clearTimeout: (handle) => {
      const idx = scheduled.findIndex((s) => s.id === handle);
      if (idx >= 0) scheduled.splice(idx, 1);
    },
  };
  /** Fires every scheduled callback (camera starts), in order. */
  const fireAll = () => scheduled.splice(0).forEach((s) => s.fn());
  return { scheduler, scheduled, fireAll };
}

/** A stand-in frame; its single pixel records when it was captured, so tests can tell frames apart. */
function fakeFrame(atMs: number): VideoFrame {
  return { width: 1, height: 1, data: Uint8Array.of(atMs % 256) };
}

/** Fake thumbnail encoder: names the frame it was given instead of producing a real JPEG. */
const fakeEncode = async (frame: VideoFrame) => Buffer.from(`jpeg of pixel ${frame.data[0]}`);

/** A capture whose frames are pushed by the test. */
class FakeCapture implements FrameCapture {
  private readonly pending: GrabFrameResult[] = [];
  private waiter: ((r: GrabFrameResult) => void) | null = null;
  closed = false;

  constructor(readonly cameraId: string) {}

  next(): Promise<GrabFrameResult> {
    if (this.closed) return Promise.resolve({ ok: false, error: 'capture closed' });
    const queued = this.pending.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => (this.waiter = resolve));
  }

  close(): void {
    this.closed = true;
    this.deliver({ ok: false, error: 'capture closed' });
  }

  /** Delivers a frame captured at `T0 + atMs`, optionally with its stream presentation time. */
  frame(atMs: number, streamTime?: number): void {
    this.deliver({ ok: true, frame: fakeFrame(atMs), capturedAt: T0 + atMs, ...(streamTime === undefined ? {} : { streamTime }) });
  }

  fail(error: string): void {
    this.deliver({ ok: false, error });
  }

  private deliver(result: GrabFrameResult): void {
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) waiter(result);
    else if (!this.closed) this.pending.push(result);
  }
}

function makeFrameGrabber() {
  const captures = new Map<string, FakeCapture>();
  const grabber: FrameGrabberLike & { openCapture: jest.Mock } = {
    openCapture: jest.fn((camera: CameraEntry) => {
      const capture = new FakeCapture(camera.id);
      captures.set(camera.id, capture);
      return capture;
    }),
  };
  return { grabber, captures };
}

type AnalyzeImpl = (frame: VideoFrame, timestamp: string) => Partial<CameraAnalysisResult>;

/** A fake analyzer: whatever `impl` says, shaped into a full result. */
function makeAnalyzer(cameraId: string, impl: AnalyzeImpl = () => ({})) {
  const analyzer: CameraAnalyzerLike & { analyze: jest.Mock; errorResult: jest.Mock; dispose: jest.Mock } = {
    analyze: jest.fn(async (frame: VideoFrame, timestamp: string) => ({
      cameraId,
      timestamp,
      totalCount: 0,
      trafficLevel: 'light' as const,
      detections: [],
      finishedTracks: [],
      ...impl(frame, timestamp),
    })),
    errorResult: jest.fn((timestamp: string, error: string) => ({
      cameraId,
      timestamp,
      totalCount: 0,
      trafficLevel: 'light' as const,
      detections: [],
      finishedTracks: [],
      error,
    })),
    dispose: jest.fn(),
  };
  return analyzer;
}

function makeHistoryStore(seed: StoredAnalysisResult[] = []) {
  const records: StoredAnalysisResult[] = [];
  const store: TrafficHistoryStoreLike & { records: StoredAnalysisResult[] } = {
    records,
    record: jest.fn((r: StoredAnalysisResult) => {
      records.push(r);
    }),
    getLatestForAllCameras: jest.fn(() => seed),
    getHistory: jest.fn(() => []),
  };
  return store;
}

/** Lets pending promise chains (frame -> analyze -> publish -> next) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

function setup(cameras: CameraEntry[] = [makeCamera()], options: TrafficAnalysisServiceOptions & { impl?: AnalyzeImpl } = {}) {
  const { grabber, captures } = makeFrameGrabber();
  const history = makeHistoryStore();
  const { scheduler, scheduled, fireAll } = makeFakeScheduler();
  const analyzers = new Map<string, ReturnType<typeof makeAnalyzer>>();
  let nowMs = T0;
  const service = new TrafficAnalysisService(makeSource(cameras), grabber, history, {
    scheduler,
    now: () => new Date(nowMs),
    encodeThumbnail: fakeEncode,
    createAnalyzer: (id) => {
      const a = makeAnalyzer(id, options.impl);
      analyzers.set(id, a);
      return a;
    },
    ...options,
  });
  return {
    service,
    grabber,
    captures,
    history,
    scheduled,
    fireAll,
    analyzers,
    setNow: (ms: number) => (nowMs = T0 + ms),
  };
}

describe('TrafficAnalysisService', () => {
  it('starts one capture per active camera, staggered, and skips inactive cameras', async () => {
    const ctx = setup([makeCamera({ id: 'a' }), makeCamera({ id: 'b', status: 'inactive' }), makeCamera({ id: 'c' })]);
    await ctx.service.start();

    expect(ctx.scheduled.map((s) => s.ms)).toEqual([0, 400]);
    ctx.fireAll();
    expect(ctx.grabber.openCapture.mock.calls.map(([c]) => c.id)).toEqual(['a', 'c']);
    ctx.service.stop();
  });

  it('analyzes only the cameras switched on', async () => {
    const cameras = ['a', 'b', 'c'].map((id) => makeCamera({ id }));
    const ctx = setup(cameras, { enabledCameras: ['a', 'c'] });
    await ctx.service.start();
    ctx.fireAll();
    expect(ctx.grabber.openCapture.mock.calls.map(([c]) => c.id)).toEqual(['a', 'c']);
    ctx.service.stop();
  });

  it('analyzes a switched-off camera while its page is open, and stops it a while after the last viewer leaves', async () => {
    const cameras = ['a', 'b'].map((id) => makeCamera({ id }));
    const ctx = setup(cameras, { enabledCameras: ['a'] });
    await ctx.service.start();
    ctx.fireAll();

    const first = ctx.service.subscribeCameraDetail('b', () => undefined);
    const second = ctx.service.subscribeCameraDetail('b', () => undefined);
    ctx.fireAll();
    expect(ctx.grabber.openCapture.mock.calls.map(([c]) => c.id)).toEqual(['a', 'b']);
    const captureB = ctx.captures.get('b')!;

    // A viewer coming back within the linger keeps the same capture running.
    first();
    second();
    expect(ctx.scheduled.map((s) => s.ms)).toEqual([15_000]);
    const back = ctx.service.subscribeCameraDetail('b', () => undefined);
    expect(ctx.scheduled).toEqual([]);
    expect(ctx.grabber.openCapture).toHaveBeenCalledTimes(2);

    // A reload (settings change, availability check) while it is watched keeps it too.
    await ctx.service.reload();
    expect(captureB.closed).toBe(false);

    back();
    ctx.fireAll();
    expect(captureB.closed).toBe(true);
    expect(ctx.service.getMetrics().cameras.map((c) => c.cameraId)).toEqual(['a']);

    // A switched-on camera's viewers come and go without stopping it.
    ctx.service.subscribeCameraDetail('a', () => undefined)();
    expect(ctx.scheduled).toEqual([]);
    expect(ctx.captures.get('a')!.closed).toBe(false);
    ctx.service.stop();
  });

  it('a viewer on an inactive or unknown camera starts nothing', async () => {
    const ctx = setup([makeCamera({ id: 'a', status: 'inactive' })], { enabledCameras: [] });
    await ctx.service.start();
    ctx.service.subscribeCameraDetail('a', () => undefined);
    ctx.service.subscribeCameraDetail('nope', () => undefined);
    ctx.fireAll();
    expect(ctx.grabber.openCapture).not.toHaveBeenCalled();
    ctx.service.stop();
  });

  it('setEnabledCameras() stops switched-off cameras and starts switched-on ones without touching the rest', async () => {
    const cameras = ['a', 'b', 'c'].map((id) => makeCamera({ id }));
    const ctx = setup(cameras, { enabledCameras: ['a', 'b'] });
    await ctx.service.start();
    ctx.fireAll();
    const analyzerA = ctx.analyzers.get('a')!;

    expect(await ctx.service.setEnabledCameras(['a', 'c'])).toEqual({ started: ['c'], stopped: ['b'] });
    expect(ctx.captures.get('b')!.closed).toBe(true);
    expect(ctx.analyzers.get('a')).toBe(analyzerA);

    expect(await ctx.service.setEnabledCameras([])).toEqual({ started: [], stopped: ['a', 'c'] });
    ctx.service.stop();
  });

  it('starts no capture when no camera is switched on', async () => {
    const ctx = setup([makeCamera({ id: 'a' })], { enabledCameras: [] });
    await ctx.service.start();
    ctx.fireAll();
    expect(ctx.grabber.openCapture).not.toHaveBeenCalled();
    ctx.service.stop();
  });

  it('analyzes every frame continuously, stamped with the frame capture time', async () => {
    const ctx = setup();
    await ctx.service.start();
    ctx.fireAll();
    const capture = ctx.captures.get('cam-1')!;

    for (let i = 0; i < 5; i++) {
      capture.frame(i * 333);
      await settle();
    }

    const analyzer = ctx.analyzers.get('cam-1')!;
    expect(analyzer.analyze).toHaveBeenCalledTimes(5);
    expect(analyzer.analyze.mock.calls[2][1]).toBe(new Date(T0 + 666).toISOString());
    ctx.service.stop();
  });

  it('delivers every frame result to detail subscribers', async () => {
    const ctx = setup([makeCamera()], { impl: () => ({ totalCount: 2 }) });
    const received: CameraAnalysisResult[] = [];
    ctx.service.subscribeCameraDetail('cam-1', (r) => received.push(r));
    await ctx.service.start();
    ctx.fireAll();

    ctx.captures.get('cam-1')!.frame(0);
    await settle();
    ctx.captures.get('cam-1')!.frame(200);
    await settle();

    expect(received.map((r) => r.totalCount)).toEqual([2, 2]);
    ctx.service.stop();
  });

  it("stamps results with the frame's stream time and keeps the last recentResultsMs of them for late viewers", async () => {
    const ctx = setup([makeCamera()], { recentResultsMs: 1000, impl: () => ({ totalCount: 1 }) });
    const received: CameraAnalysisResult[] = [];
    ctx.service.subscribeCameraDetail('cam-1', (r) => received.push(r));
    await ctx.service.start();
    ctx.fireAll();
    const capture = ctx.captures.get('cam-1')!;

    capture.frame(0, 500);
    await settle();
    capture.frame(600, 500.6);
    await settle();
    capture.frame(1200);
    await settle();

    expect(received.map((r) => r.streamTime)).toEqual([500, 500.6, undefined]);
    // The first result is older than 1s by the newest one's capture time.
    expect(ctx.service.getRecentResults('cam-1').map((r) => r.timestamp)).toEqual([
      new Date(T0 + 600).toISOString(),
      new Date(T0 + 1200).toISOString(),
    ]);
    expect(ctx.service.getRecentResults('unknown')).toEqual([]);
    ctx.service.stop();
  });

  it('publishes capture failures to live viewers, keeps looping, and never persists them', async () => {
    const ctx = setup([makeCamera()], { historyIntervalMs: 0 });
    const received: CameraAnalysisResult[] = [];
    ctx.service.subscribeCameraDetail('cam-1', (r) => received.push(r));
    await ctx.service.start();
    ctx.fireAll();
    const capture = ctx.captures.get('cam-1')!;

    capture.fail('stream stalled');
    await settle();
    capture.frame(1000);
    await settle();

    expect(received.map((r) => r.error)).toEqual(['stream stalled', undefined]);
    expect(ctx.history.records).toHaveLength(1);
    expect(ctx.history.records[0].timestamp).toBe(new Date(T0 + 1000).toISOString());
    ctx.service.stop();
  });

  it('never persists a warm-up result, and does not overwrite the overview with one', async () => {
    const seed = [{ cameraId: 'cam-1', timestamp: 'earlier', totalCount: 7, trafficLevel: 'moderate' as const }];
    const { grabber, captures } = makeFrameGrabber();
    const history = makeHistoryStore(seed);
    const { scheduler, fireAll } = makeFakeScheduler();
    const onResult = jest.fn();
    const service = new TrafficAnalysisService(makeSource([makeCamera()]), grabber, history, {
      scheduler,
      historyIntervalMs: 0,
      onResult,
      createAnalyzer: (id) => makeAnalyzer(id, () => ({ warmingUp: true })),
    });
    await service.start();
    fireAll();

    captures.get('cam-1')!.frame(0);
    await settle();

    expect(history.records).toEqual([]);
    expect(onResult).not.toHaveBeenCalled();
    expect(service.getLatestOverview()).toEqual([expect.objectContaining({ totalCount: 7 })]);
    service.stop();
  });

  it('writes one history row per historyIntervalMs holding the mean count over the window', async () => {
    let count = 0;
    const ctx = setup([makeCamera()], { historyIntervalMs: 1000, impl: () => ({ totalCount: count }) });
    await ctx.service.start();
    ctx.fireAll();
    const capture = ctx.captures.get('cam-1')!;

    // Frames at 0..1000ms every 250ms with counts 1,2,3,4,5 -> one row at 1000ms, mean 3.
    for (let i = 0; i <= 4; i++) {
      count = i + 1;
      capture.frame(i * 250);
      await settle();
    }

    expect(ctx.history.records).toEqual([{ cameraId: 'cam-1', timestamp: new Date(T0 + 1000).toISOString(), totalCount: 3, trafficLevel: 'light' }]);
    ctx.service.stop();
  });

  it('calls onResult for every usable frame, including its finished tracks', async () => {
    const finished = [{ trackId: 3, firstSeen: 'a', lastSeen: 'b', firstBox: { x: 0, y: 0, width: 0.1, height: 0.1 }, lastBox: { x: 0.5, y: 0, width: 0.1, height: 0.1 }, hits: 9 }];
    const onResult = jest.fn();
    const ctx = setup([makeCamera()], { onResult, impl: () => ({ finishedTracks: finished }) });
    await ctx.service.start();
    ctx.fireAll();

    ctx.captures.get('cam-1')!.frame(0);
    await settle();
    ctx.captures.get('cam-1')!.fail('boom');
    await settle();

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0].finishedTracks).toEqual(finished);
    ctx.service.stop();
  });

  it('throttles unchanged overview updates but sends a changed traffic level immediately', async () => {
    let level: CameraAnalysisResult['trafficLevel'] = 'light';
    const ctx = setup([makeCamera()], { overviewIntervalMs: 2000, impl: () => ({ trafficLevel: level }) });
    const overviews: CameraAnalysisOverview[] = [];
    ctx.service.subscribeOverview((o) => overviews.push(o));
    await ctx.service.start();
    ctx.fireAll();
    const capture = ctx.captures.get('cam-1')!;

    const frameAt = async (ms: number) => {
      ctx.setNow(ms);
      capture.frame(ms);
      await settle();
    };
    await frameAt(0); // first -> sent
    await frameAt(500); // unchanged, throttled
    await frameAt(1000); // unchanged, throttled
    level = 'heavy';
    await frameAt(1200); // changed -> sent
    await frameAt(3300); // unchanged but interval elapsed -> sent

    expect(overviews.map((o) => o.trafficLevel)).toEqual(['light', 'heavy', 'heavy']);
    expect(ctx.service.getLatestOverview()[0].timestamp).toBe(new Date(T0 + 3300).toISOString());
    ctx.service.stop();
  });

  it('caps concurrent analysis at maxConcurrency across cameras', async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const cameras = [makeCamera({ id: 'a' }), makeCamera({ id: 'b' }), makeCamera({ id: 'c' })];
    const { grabber, captures } = makeFrameGrabber();
    const { scheduler, fireAll } = makeFakeScheduler();
    const service = new TrafficAnalysisService(makeSource(cameras), grabber, makeHistoryStore(), {
      scheduler,
      maxConcurrency: 2,
      createAnalyzer: (id) => {
        const a = makeAnalyzer(id);
        a.analyze.mockImplementation(async (_f: VideoFrame, timestamp: string) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((r) => releases.push(r));
          inFlight -= 1;
          return { cameraId: id, timestamp, totalCount: 0, trafficLevel: 'light', detections: [], finishedTracks: [] };
        });
        return a;
      },
    });
    await service.start();
    fireAll();

    for (const id of ['a', 'b', 'c']) captures.get(id)!.frame(0);
    await settle();
    expect(inFlight).toBe(2);
    releases.shift()!();
    await settle();
    expect(inFlight).toBe(2);
    releases.splice(0).forEach((r) => r());
    await settle();

    expect(peak).toBe(2);
    service.stop();
  });

  it('builds one analyzer per camera', async () => {
    const ctx = setup([makeCamera({ id: 'a' }), makeCamera({ id: 'b' })]);
    await ctx.service.start();

    expect([...ctx.analyzers.keys()]).toEqual(['a', 'b']);
    expect(ctx.analyzers.get('a')).not.toBe(ctx.analyzers.get('b'));
    ctx.service.stop();
  });

  it('stop() closes every capture, disposes every analyzer, cancels pending starts and ends the loops', async () => {
    const ctx = setup([makeCamera({ id: 'a' }), makeCamera({ id: 'b' })]);
    await ctx.service.start();
    ctx.scheduled[0].fn(); // only "a" has started

    ctx.service.stop();
    await ctx.service.idle();

    expect(ctx.captures.get('a')!.closed).toBe(true);
    expect(ctx.scheduled.map((s) => s.ms)).toEqual([0]); // "a"'s already-fired entry; "b"'s was cancelled
    expect(ctx.grabber.openCapture).toHaveBeenCalledTimes(1);
    expect(ctx.analyzers.get('a')!.dispose).toHaveBeenCalled();
    expect(ctx.analyzers.get('b')!.dispose).toHaveBeenCalled();
    expect(ctx.analyzers.get('a')!.errorResult).not.toHaveBeenCalled();
  });

  it('reload() starts cameras that became active and stops ones that did not stay active, leaving the rest running', async () => {
    const cameras = [makeCamera({ id: 'a' }), makeCamera({ id: 'b' }), makeCamera({ id: 'c', status: 'inactive' })];
    const ctx = setup(cameras);
    await ctx.service.start();
    ctx.fireAll();
    const analyzerA = ctx.analyzers.get('a')!;

    cameras[1].status = 'inactive';
    cameras[2].status = 'active';
    expect(await ctx.service.reload()).toEqual({ started: ['c'], stopped: ['b'] });

    expect(ctx.captures.get('b')!.closed).toBe(true);
    expect(ctx.analyzers.get('b')!.dispose).toHaveBeenCalled();
    expect(ctx.captures.get('a')!.closed).toBe(false);
    expect(ctx.analyzers.get('a')).toBe(analyzerA);
    expect(analyzerA.dispose).not.toHaveBeenCalled();

    ctx.fireAll();
    ctx.captures.get('c')!.frame(0);
    await settle();
    expect(ctx.analyzers.get('c')!.analyze).toHaveBeenCalledTimes(1);
    expect(ctx.service.getMetrics().cameras.map((c) => c.cameraId)).toEqual(['a', 'c']);

    expect(await ctx.service.reload()).toEqual({ started: [], stopped: [] });
    ctx.service.stop();
  });

  it('never analyzes a hidden camera, and restartCamera() rebuilds one camera from its edited entry', async () => {
    const cameras = [makeCamera({ id: 'a' }), makeCamera({ id: 'b', hidden: true })];
    const ctx = setup(cameras);
    await ctx.service.start();
    ctx.fireAll();
    expect(ctx.service.getMetrics().cameras.map((c) => c.cameraId)).toEqual(['a']);

    const oldAnalyzer = ctx.analyzers.get('a')!;
    cameras[0] = makeCamera({ id: 'a', ignoreZones: [{ points: [[0, 0], [1, 0], [1, 1]] }] });
    expect(await ctx.service.restartCamera('a')).toBe(true);
    expect(oldAnalyzer.dispose).toHaveBeenCalled();
    expect(ctx.analyzers.get('a')).not.toBe(oldAnalyzer);
    expect(await ctx.service.restartCamera('b')).toBe(false);

    cameras[1] = makeCamera({ id: 'b' });
    expect(await ctx.service.reload()).toEqual({ started: ['b'], stopped: [] });
    ctx.service.stop();
  });

  it('drops a frame from a camera that reload() stopped while the frame waited for analysis', async () => {
    const cameras = [makeCamera({ id: 'a' })];
    let release: () => void = () => undefined;
    const ctx = setup(cameras);
    await ctx.service.start();
    ctx.fireAll();
    const analyzer = ctx.analyzers.get('a')!;
    analyzer.analyze.mockImplementationOnce(
      (_frame: VideoFrame, timestamp: string) =>
        new Promise((resolve) => {
          release = () => resolve({ cameraId: 'a', timestamp, totalCount: 3, trafficLevel: 'light', detections: [], finishedTracks: [] });
        }),
    );
    const received: unknown[] = [];
    ctx.service.subscribeCameraDetail('a', (r) => received.push(r));

    ctx.captures.get('a')!.frame(0);
    await settle();
    cameras[0].status = 'inactive';
    await ctx.service.reload();
    release();
    await settle();

    expect(received).toEqual([]);
    ctx.service.stop();
  });

  it('a throwing subscriber does not stop others or the loop', async () => {
    const ctx = setup();
    const good = jest.fn();
    ctx.service.subscribeCameraDetail('cam-1', () => {
      throw new Error('dead socket');
    });
    ctx.service.subscribeCameraDetail('cam-1', good);
    await ctx.service.start();
    ctx.fireAll();

    ctx.captures.get('cam-1')!.frame(0);
    await settle();
    ctx.captures.get('cam-1')!.frame(200);
    await settle();

    expect(good).toHaveBeenCalledTimes(2);
    ctx.service.stop();
  });

  it('unsubscribing stops delivery', async () => {
    const ctx = setup();
    const cb = jest.fn();
    const unsubscribe = ctx.service.subscribeCameraDetail('cam-1', cb);
    await ctx.service.start();
    ctx.fireAll();

    ctx.captures.get('cam-1')!.frame(0);
    await settle();
    unsubscribe();
    unsubscribe();
    ctx.captures.get('cam-1')!.frame(200);
    await settle();

    expect(cb).toHaveBeenCalledTimes(1);
    ctx.service.stop();
  });

  it('keeps a recent frame per camera as a thumbnail, re-encoding at most every thumbnailIntervalMs', async () => {
    const encode = jest.fn(fakeEncode);
    const ctx = setup([makeCamera()], { thumbnailIntervalMs: 1000, encodeThumbnail: encode });
    await ctx.service.start();
    expect(ctx.service.getLatestFrame('cam-1')).toBeNull();
    ctx.fireAll();

    for (const atMs of [0, 400, 800, 1200]) {
      ctx.captures.get('cam-1')!.frame(atMs);
      await settle();
    }
    ctx.captures.get('cam-1')!.fail('stalled');
    await settle();

    // 0 and 1200 are encoded; 400 and 800 fall inside the interval.
    expect(encode).toHaveBeenCalledTimes(2);
    expect(ctx.service.getLatestFrame('cam-1')).toEqual({
      buffer: Buffer.from(`jpeg of pixel ${1200 % 256}`),
      capturedAt: new Date(T0 + 1200).toISOString(),
    });
    expect(ctx.service.getLatestFrame('unknown')).toBeNull();
    ctx.service.stop();
  });

  it('never replaces a thumbnail with an older frame whose encode finished later', async () => {
    const resolvers: Array<() => void> = [];
    const encode = jest.fn(
      (frame: VideoFrame) => new Promise<Buffer>((resolve) => resolvers.push(() => resolve(Buffer.from(`pixel ${frame.data[0]}`)))),
    );
    const ctx = setup([makeCamera()], { thumbnailIntervalMs: 0, encodeThumbnail: encode });
    await ctx.service.start();
    ctx.fireAll();

    ctx.captures.get('cam-1')!.frame(10);
    await settle();
    ctx.captures.get('cam-1')!.frame(20);
    await settle();
    resolvers[1]();
    await settle();
    resolvers[0]();
    await settle();

    expect(ctx.service.getLatestFrame('cam-1')?.buffer).toEqual(Buffer.from('pixel 20'));
    ctx.service.stop();
  });

  it('seeds the latest overview from history on construction', () => {
    const seed = [{ cameraId: 'cam-9', timestamp: 't', totalCount: 4, trafficLevel: 'heavy' as const }];
    const service = new TrafficAnalysisService(makeSource([]), makeFrameGrabber().grabber, makeHistoryStore(seed));

    expect(service.getLatestOverview()).toEqual(seed);
  });

  it('reports per-camera frame rate, stream speed and capture errors for the Admin page', async () => {
    const ctx = setup([makeCamera(), makeCamera({ id: 'cam-2', name: 'Second' })]);
    await ctx.service.start();
    ctx.fireAll();
    const capture = ctx.captures.get('cam-1')!;

    for (let i = 0; i <= 10; i++) {
      ctx.setNow(i * 500);
      capture.frame(i * 500, 100 + i * 0.25);
      await settle();
    }
    capture.fail('stream stalled: no frames for 20s');
    await settle();

    const metrics = ctx.service.getMetrics();
    expect(metrics).toMatchObject({ activeJobs: 0, queuedJobs: 0, maxConcurrency: 6 });
    const [first, second] = metrics.cameras;
    expect(first).toMatchObject({ cameraId: 'cam-1', name: 'Test Camera', errors: 1, capture: null });
    expect(first.fps).toBeCloseTo(2.2, 1);
    expect(first.streamRatio).toBeCloseTo(0.5, 5);
    expect(second).toMatchObject({ cameraId: 'cam-2', fps: 0, avgMs: null, errors: 0 });
    ctx.service.stop();
  });

  it('getHistory delegates to the history store', () => {
    const history = makeHistoryStore();
    const service = new TrafficAnalysisService(makeSource([]), makeFrameGrabber().grabber, history);

    service.getHistory('cam-1', { limit: 5 });

    expect(history.getHistory).toHaveBeenCalledWith('cam-1', { limit: 5 });
  });
});
