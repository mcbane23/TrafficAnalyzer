import {
  AnalysisScheduler,
  CameraAnalyzerLike,
  FrameGrabberLike,
  TrafficAnalysisService,
  TrafficHistoryStoreLike,
} from './trafficAnalysisService';
import { CameraSource } from '../server/cameraService';
import { CameraEntry } from '../types/camera';
import { CameraAnalysisOverview, CameraAnalysisResult, StoredAnalysisResult, VehicleDetection } from '../types/analysis';
import { GrabFrameResult } from './frameGrabber';

function okFrame(buffer: Buffer): GrabFrameResult {
  return { ok: true, buffer };
}

function errFrame(error: string): GrabFrameResult {
  return { ok: false, error };
}

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

/** A fake scheduler that records scheduled (fn, ms) pairs instead of using real timers, so tests can advance ticks deterministically. */
function makeFakeScheduler() {
  interface Scheduled {
    id: number;
    fn: () => void;
    ms: number;
  }
  const scheduled: Scheduled[] = [];
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

  /** Runs the given scheduled entry (by insertion index) and waits for its (possibly async) callback to settle. */
  async function fire(index: number): Promise<void> {
    const entry = scheduled[index];
    await (entry.fn() as unknown as Promise<void> | void);
  }

  return { scheduler, scheduled, fire };
}

type FakeFrameGrabber = FrameGrabberLike & {
  grabFrame: jest.Mock;
  openCapture: jest.Mock;
  /** Every capture handed out, in the order they were opened. */
  captures: Array<{ cameraId: string; next: jest.Mock; close: jest.Mock }>;
};

/**
 * A fake grabber serving the same frames from both modes.
 *
 * Both `grabFrame` and `openCapture` are required by the seam - there is no
 * optional teardown a lazy fake can skip, which is the point: the close
 * path is exercised by every test that uses a capture.
 */
function makeFrameGrabber(impl: FrameGrabberLike['grabFrame'] = jest.fn(async () => errFrame('not configured'))): FakeFrameGrabber {
  const grabFrame = jest.fn(impl);
  const captures: FakeFrameGrabber['captures'] = [];
  const openCapture = jest.fn((camera: CameraEntry) => {
    const capture = {
      cameraId: camera.id,
      next: jest.fn(() => grabFrame(camera)),
      close: jest.fn(),
    };
    captures.push(capture);
    return capture;
  });
  return { grabFrame, openCapture, captures } as FakeFrameGrabber;
}

type FakeAnalyzer = CameraAnalyzerLike & {
  analyze: jest.Mock;
  errorResult: jest.Mock;
  dispose: jest.Mock;
};

/**
 * A fake analyzer: canned detections in, a correctly-shaped result out.
 *
 * This service never looks inside an analyzer - it hands over a frame and
 * publishes what comes back - so nothing here needs real detection,
 * tracking, occupancy or traffic-level derivation. Those are asserted
 * directly against the interface in cameraAnalyzer.test.ts, without a
 * scheduler, a frame grabber or a history store in sight.
 */
function makeAnalyzer(cameraId = 'cam-1', detections: VehicleDetection[] = []): FakeAnalyzer {
  return {
    analyze: jest.fn(async (_frame: Buffer, timestamp: string) => ({
      cameraId,
      timestamp,
      totalCount: detections.length,
      trafficLevel: 'light' as const,
      detections,
      finishedTracks: [],
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
}

/** Builds a per-camera analyzer factory that hands every camera its own fake, and records what it built. */
function makeAnalyzerFactory(detections: VehicleDetection[] = []) {
  const created = new Map<string, FakeAnalyzer>();
  const createAnalyzer = jest.fn((cameraId: string) => {
    const analyzer = makeAnalyzer(cameraId, detections);
    created.set(cameraId, analyzer);
    return analyzer;
  });
  return { createAnalyzer, created };
}

function makeHistoryStore(): TrafficHistoryStoreLike & { records: StoredAnalysisResult[] } {
  const records: StoredAnalysisResult[] = [];
  return {
    records,
    record: jest.fn((result: StoredAnalysisResult) => {
      records.push(result);
    }),
    getLatestForAllCameras: jest.fn(() => []),
    getHistory: jest.fn(() => []),
  };
}

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

describe('TrafficAnalysisService', () => {
  it('schedules a tick for each active camera and skips inactive ones', async () => {
    const source = makeSource([makeCamera({ id: 'active-1', status: 'active' }), makeCamera({ id: 'inactive-1', status: 'inactive' })]);
    const { scheduler, scheduled } = makeFakeScheduler();
    const service = new TrafficAnalysisService(source, makeFrameGrabber(), makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      createAnalyzer: makeAnalyzerFactory().createAnalyzer,
    });

    await service.start();

    expect(scheduled).toHaveLength(1);
  });

  it('staggers each active camera\'s first tick instead of firing them all at once', async () => {
    const source = makeSource(
      Array.from({ length: 5 }, (_, i) => makeCamera({ id: `cam-${i}` })),
    );
    const { scheduler, scheduled } = makeFakeScheduler();
    const service = new TrafficAnalysisService(source, makeFrameGrabber(), makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      backgroundIntervalMs: 10_000,
      createAnalyzer: makeAnalyzerFactory().createAnalyzer,
    });

    await service.start();

    const delays = scheduled.map((s) => s.ms);
    expect(delays).toHaveLength(5);
    // Strictly increasing (no two cameras start at the same instant), and
    // never delayed past the normal background cadence.
    expect(new Set(delays).size).toBe(5);
    for (const ms of delays) {
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(10_000);
    }
  });

  it('runs the one-time initial analysis pass, persists the result, and then goes idle (no repeating tick)', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, scheduled, fire } = makeFakeScheduler();
    const detection: VehicleDetection = { class: 'vehicle', confidence: 0.9, box: { x: 0, y: 0, width: 0.1, height: 0.1 } };
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const historyStore = makeHistoryStore();
    const service = new TrafficAnalysisService(source, frameGrabber, historyStore, {
      scheduler,
      now: () => FIXED_NOW,
      backgroundIntervalMs: 10_000,
      boostedIntervalMs: 500,
      createAnalyzer: makeAnalyzerFactory([detection]).createAnalyzer,
    });

    await service.start();
    await fire(0);

    expect(frameGrabber.grabFrame).toHaveBeenCalledTimes(1);
    expect(historyStore.records).toEqual([
      {
        cameraId: 'cam-1',
        timestamp: FIXED_NOW.toISOString(),
        totalCount: 1,
        trafficLevel: 'light',
      },
    ]);
    // No detail-page subscriber ever showed up, so nothing further gets
    // scheduled - an unwatched camera is analyzed exactly once, not
    // resampled on a timer (see the class docstring).
    expect(scheduled).toHaveLength(1);
  });

  it('publishes a result with an error and does not persist it when frame capture fails', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, fire } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => errFrame('stream unreachable')));
    const historyStore = makeHistoryStore();
    const { createAnalyzer, created } = makeAnalyzerFactory();
    const overviewUpdates: CameraAnalysisOverview[] = [];
    const service = new TrafficAnalysisService(source, frameGrabber, historyStore, {
      scheduler,
      now: () => FIXED_NOW,
      createAnalyzer,
    });
    service.subscribeOverview((overview) => overviewUpdates.push(overview));

    await service.start();
    await fire(0);

    // The analyzer never saw a frame - the failure went through its own
    // error-result shape instead, so subscribers get one consistent shape.
    expect(created.get('cam-1')!.analyze).not.toHaveBeenCalled();
    expect(created.get('cam-1')!.errorResult).toHaveBeenCalledWith(FIXED_NOW.toISOString(), 'stream unreachable');
    expect(historyStore.records).toHaveLength(0);
    expect(overviewUpdates).toEqual([
      { cameraId: 'cam-1', timestamp: FIXED_NOW.toISOString(), totalCount: 0, trafficLevel: 'light', error: 'stream unreachable' },
    ]);
  });

  // Same rule when the failure happens inside the analyzer rather than at
  // capture: a zeroed error result describes a broken feed, not an empty
  // road, and persisting it would read as genuine quiet traffic later.
  it('does not persist an error result produced by the analyzer itself', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, fire } = makeFakeScheduler();
    const historyStore = makeHistoryStore();
    const results: CameraAnalysisResult[] = [];
    const service = new TrafficAnalysisService(source, makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame')))), historyStore, {
      scheduler,
      now: () => FIXED_NOW,
      createAnalyzer: (cameraId) => {
        const analyzer = makeAnalyzer(cameraId);
        analyzer.analyze = jest.fn(async (_frame: Buffer, timestamp: string) =>
          analyzer.errorResult(timestamp, 'detection failed'),
        );
        return analyzer;
      },
    });
    service.subscribeCameraDetail('cam-1', (result) => results.push(result));

    await service.start();
    await fire(0);

    expect(results[0].error).toBe('detection failed');
    expect(historyStore.records).toHaveLength(0);
  });

  it('notifies camera-detail subscribers with the full result, including detections', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, fire } = makeFakeScheduler();
    const detection: VehicleDetection = { class: 'vehicle', confidence: 0.8, box: { x: 0, y: 0, width: 0.3, height: 0.3 }, trackId: 1 };
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const service = new TrafficAnalysisService(source, frameGrabber, makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      createAnalyzer: makeAnalyzerFactory([detection]).createAnalyzer,
    });

    const results: CameraAnalysisResult[] = [];
    service.subscribeCameraDetail('cam-1', (result) => results.push(result));

    await service.start();
    await fire(0);

    expect(results).toHaveLength(1);
    expect(results[0].detections).toEqual([detection]);
  });

  it('boosts the sampling rate while a camera has a detail subscriber, and reverts once unsubscribed', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, scheduled, fire } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const service = new TrafficAnalysisService(source, frameGrabber, makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      backgroundIntervalMs: 10_000,
      boostedIntervalMs: 500,
      createAnalyzer: makeAnalyzerFactory().createAnalyzer,
    });

    await service.start();

    const unsubscribe = service.subscribeCameraDetail('cam-1', () => undefined);
    await fire(0);
    expect(scheduled[1].ms).toBe(500);

    unsubscribe();
    await fire(1);
    // Once the last subscriber disconnects, the camera goes idle rather
    // than reverting to a repeating background sample - no further tick is
    // scheduled (see the class docstring).
    expect(scheduled).toHaveLength(2);
  });

  it('opens a continuous capture for boosted ticks, and closes it once the last subscriber unsubscribes', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, fire } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const service = new TrafficAnalysisService(source, frameGrabber, makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      backgroundIntervalMs: 10_000,
      boostedIntervalMs: 500,
      createAnalyzer: makeAnalyzerFactory().createAnalyzer,
    });

    await service.start();

    const unsubscribe = service.subscribeCameraDetail('cam-1', () => undefined);
    await fire(0);
    expect(frameGrabber.captures).toHaveLength(1);
    expect(frameGrabber.captures[0].cameraId).toBe('cam-1');
    expect(frameGrabber.captures[0].next).toHaveBeenCalledTimes(1);
    expect(frameGrabber.captures[0].close).not.toHaveBeenCalled();

    unsubscribe();
    expect(frameGrabber.captures[0].close).toHaveBeenCalledTimes(1);
  });

  // The capture is opened once and reused for the whole boost - reopening
  // per tick would reintroduce exactly the HLS reconnect cost it exists to
  // avoid.
  it('reuses one capture across a camera\'s boosted ticks', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, fire } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const service = new TrafficAnalysisService(source, frameGrabber, makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      boostedIntervalMs: 500,
      createAnalyzer: makeAnalyzerFactory().createAnalyzer,
    });

    await service.start();
    service.subscribeCameraDetail('cam-1', () => undefined);
    await fire(0);
    await fire(1);

    expect(frameGrabber.openCapture).toHaveBeenCalledTimes(1);
    expect(frameGrabber.captures[0].next).toHaveBeenCalledTimes(2);
  });

  // An unwatched camera's single pass must not hold an ffmpeg process open.
  it('uses a one-off grab, not a capture, for an unwatched camera\'s background tick', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, fire } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const service = new TrafficAnalysisService(source, frameGrabber, makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      createAnalyzer: makeAnalyzerFactory().createAnalyzer,
    });

    await service.start();
    await fire(0);

    expect(frameGrabber.grabFrame).toHaveBeenCalledWith(expect.objectContaining({ id: 'cam-1' }));
    expect(frameGrabber.openCapture).not.toHaveBeenCalled();
  });

  it('stop() closes any open capture', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, fire } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const service = new TrafficAnalysisService(source, frameGrabber, makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      boostedIntervalMs: 500,
      createAnalyzer: makeAnalyzerFactory().createAnalyzer,
    });

    await service.start();
    service.subscribeCameraDetail('cam-1', () => undefined);
    await fire(0);

    service.stop();

    expect(frameGrabber.captures[0].close).toHaveBeenCalledTimes(1);
  });

  // Boosting changes how the frame is captured, never how it is analyzed.
  // Degrading the boosted path to a cheaper single-pass detection is what made
  // the live detail page the least accurate view in the system.
  it('analyzes identically for boosted and background ticks', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, fire } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const { createAnalyzer, created } = makeAnalyzerFactory();
    const service = new TrafficAnalysisService(source, frameGrabber, makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      backgroundIntervalMs: 10_000,
      boostedIntervalMs: 500,
      createAnalyzer,
    });

    await service.start();

    await fire(0);
    expect(created.get('cam-1')!.analyze).toHaveBeenLastCalledWith(expect.any(Buffer), FIXED_NOW.toISOString());

    service.subscribeCameraDetail('cam-1', () => undefined);
    await fire(1);
    expect(created.get('cam-1')!.analyze).toHaveBeenLastCalledWith(expect.any(Buffer), FIXED_NOW.toISOString());
    expect(created.get('cam-1')!.analyze).toHaveBeenCalledTimes(2);
  });

  it('skips analysis entirely for unwatched cameras while a different camera is being watched, and resumes once watching stops', async () => {
    const cameras = [makeCamera({ id: 'cam-1' }), makeCamera({ id: 'cam-2' })];
    const source = makeSource(cameras);
    const { scheduler, scheduled, fire } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const service = new TrafficAnalysisService(source, frameGrabber, makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      backgroundIntervalMs: 10_000,
      boostedIntervalMs: 500,
      createAnalyzer: makeAnalyzerFactory().createAnalyzer,
    });

    await service.start();
    // scheduled[0] = cam-1 initial tick, scheduled[1] = cam-2 initial tick.

    const unsubscribe = service.subscribeCameraDetail('cam-1', () => undefined);
    // Subscribing cancels cam-1's pending initial tick and schedules an
    // immediate boosted one in its place (see subscribeCameraDetail), so
    // cam-2's still-pending initial tick is now scheduled[0].

    // cam-2's tick fires while cam-1 is being watched - should be skipped entirely.
    await fire(0);
    expect(frameGrabber.grabFrame).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'cam-2' }));
    expect(scheduled[2].ms).toBe(10_000);

    unsubscribe();

    // cam-2's next tick fires after watching stopped - should analyze normally.
    await fire(2);
    expect(frameGrabber.grabFrame).toHaveBeenCalledWith(expect.objectContaining({ id: 'cam-2' }));
  });

  it('caps concurrent analysis jobs at maxConcurrency and runs queued jobs once a slot frees up', async () => {
    const cameras = [makeCamera({ id: 'cam-1' }), makeCamera({ id: 'cam-2' }), makeCamera({ id: 'cam-3' }), makeCamera({ id: 'cam-4' })];
    const source = makeSource(cameras);
    const { scheduler, scheduled } = makeFakeScheduler();

    let concurrent = 0;
    let maxObserved = 0;
    const frameGrabber = makeFrameGrabber(
      jest.fn(async () => {
        concurrent++;
        maxObserved = Math.max(maxObserved, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent--;
        return errFrame('unused');
      }),
    );

    const service = new TrafficAnalysisService(source, frameGrabber, makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      maxConcurrency: 2,
      createAnalyzer: makeAnalyzerFactory().createAnalyzer,
    });

    await service.start();
    expect(scheduled).toHaveLength(4);

    await Promise.all(scheduled.slice(0, 4).map((entry) => entry.fn() as unknown as Promise<void>));

    expect(maxObserved).toBe(2);
    expect(frameGrabber.grabFrame).toHaveBeenCalledTimes(4);
  });

  // An analyzer holds one camera's background model, tracks and learned
  // roadway - all of which describe a single fixed viewpoint. Sharing one
  // across cameras would corrupt it with frames from unrelated feeds, so the
  // factory must be called once per camera and its result reused.
  it('keeps one analyzer per camera rather than one shared across all of them', async () => {
    const source = makeSource([makeCamera({ id: 'cam-1' }), makeCamera({ id: 'cam-2' })]);
    const { scheduler, fire } = makeFakeScheduler();
    const { createAnalyzer } = makeAnalyzerFactory();
    const service = new TrafficAnalysisService(
      source,
      makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame')))),
      makeHistoryStore(),
      { scheduler, now: () => FIXED_NOW, createAnalyzer },
    );

    await service.start();
    await fire(0);
    await fire(1);
    // Watching cam-1 triggers a second tick for it (its one-time initial
    // pass doesn't repeat on its own - see the class docstring); that
    // second tick must reuse its existing analyzer, not rebuild it.
    service.subscribeCameraDetail('cam-1', () => undefined);
    await fire(2);

    expect(createAnalyzer.mock.calls.map(([cameraId]) => cameraId)).toEqual(['cam-1', 'cam-2']);
  });

  it('getLatestOverview seeds from the history store on construction', () => {
    const source = makeSource([makeCamera()]);
    const historyStore = makeHistoryStore();
    (historyStore.getLatestForAllCameras as jest.Mock).mockReturnValue([
      { cameraId: 'cam-1', timestamp: FIXED_NOW.toISOString(), totalCount: 4, trafficLevel: 'light' },
    ]);
    const service = new TrafficAnalysisService(source, makeFrameGrabber(), historyStore);

    expect(service.getLatestOverview()).toEqual([
      { cameraId: 'cam-1', timestamp: FIXED_NOW.toISOString(), totalCount: 4, trafficLevel: 'light' },
    ]);
  });

  it('getHistory delegates to the history store', () => {
    const source = makeSource([makeCamera()]);
    const historyStore = makeHistoryStore();
    const service = new TrafficAnalysisService(source, makeFrameGrabber(), historyStore);

    service.getHistory('cam-1', { limit: 5 });

    expect(historyStore.getHistory).toHaveBeenCalledWith('cam-1', { limit: 5 });
  });

  it('stop() clears pending timers so no further ticks occur', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, scheduled } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const service = new TrafficAnalysisService(source, frameGrabber, makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      createAnalyzer: makeAnalyzerFactory().createAnalyzer,
    });

    await service.start();
    expect(scheduled).toHaveLength(1);

    service.stop();

    expect(scheduled).toHaveLength(0);
  });

  // A camera's learned state is worthless once sampling stops - a restarted
  // service may be looking at a re-aimed camera - so stopping must release
  // every analyzer, not just cancel the timers pointing at them.
  it('stop() disposes every camera\'s analyzer', async () => {
    const source = makeSource([makeCamera({ id: 'cam-1' }), makeCamera({ id: 'cam-2' })]);
    const { scheduler } = makeFakeScheduler();
    const { createAnalyzer, created } = makeAnalyzerFactory();
    const service = new TrafficAnalysisService(source, makeFrameGrabber(), makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      createAnalyzer,
    });

    await service.start();
    service.stop();

    expect(created.get('cam-1')!.dispose).toHaveBeenCalledTimes(1);
    expect(created.get('cam-2')!.dispose).toHaveBeenCalledTimes(1);
  });
});
