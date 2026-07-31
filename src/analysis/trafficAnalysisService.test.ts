import {
  AnalysisScheduler,
  FrameGrabberLike,
  TrafficAnalysisService,
  TrafficHistoryStoreLike,
  VehicleColorEstimatorLike,
  VehicleDetectorLike,
} from './trafficAnalysisService';
import { CameraSource } from '../server/cameraService';
import { CameraEntry } from '../types/camera';
import { CameraAnalysisOverview, CameraAnalysisResult, StoredAnalysisResult, VehicleDetection, emptyClassCounts } from '../types/analysis';
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

function makeFrameGrabber(impl: FrameGrabberLike['grabFrame'] = jest.fn(async () => errFrame('not configured'))): FrameGrabberLike {
  return { grabFrame: jest.fn(impl) };
}

function makeDetector(detections: VehicleDetection[] = []): VehicleDetectorLike {
  return { detect: jest.fn(async () => detections) };
}

function makeColorEstimator(): VehicleColorEstimatorLike {
  return { estimateColor: jest.fn(async () => 'silver') };
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
    const frameGrabber = makeFrameGrabber();
    const service = new TrafficAnalysisService(source, frameGrabber, makeDetector(), makeColorEstimator(), makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
    });

    await service.start();

    expect(scheduled).toHaveLength(1);
  });

  it('runs analysis on tick, persists the result, and schedules the next tick at the background interval', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, scheduled, fire } = makeFakeScheduler();
    const detection: VehicleDetection = { class: 'car', confidence: 0.9, box: { x: 0, y: 0, width: 0.1, height: 0.1 } };
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const historyStore = makeHistoryStore();
    const service = new TrafficAnalysisService(source, frameGrabber, makeDetector([detection]), makeColorEstimator(), historyStore, {
      scheduler,
      now: () => FIXED_NOW,
      backgroundIntervalMs: 10_000,
      boostedIntervalMs: 500,
    });

    await service.start();
    await fire(0);

    expect(frameGrabber.grabFrame).toHaveBeenCalledTimes(1);
    expect(historyStore.records).toEqual([
      {
        cameraId: 'cam-1',
        timestamp: FIXED_NOW.toISOString(),
        totalCount: 1,
        countsByClass: { ...emptyClassCounts(), car: 1 },
        trafficLevel: 'light',
      },
    ]);
    // The initial tick fires at delay 0; the next one should use the background interval.
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1].ms).toBe(10_000);
  });

  it('publishes a result with an error and does not persist it when frame capture fails', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, fire } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => errFrame('stream unreachable')));
    const historyStore = makeHistoryStore();
    const overviewUpdates: CameraAnalysisOverview[] = [];
    const service = new TrafficAnalysisService(source, frameGrabber, makeDetector(), makeColorEstimator(), historyStore, {
      scheduler,
      now: () => FIXED_NOW,
    });
    service.subscribeOverview((overview) => overviewUpdates.push(overview));

    await service.start();
    await fire(0);

    expect(historyStore.records).toHaveLength(0);
    expect(overviewUpdates).toEqual([
      { cameraId: 'cam-1', timestamp: FIXED_NOW.toISOString(), totalCount: 0, trafficLevel: 'light', error: 'stream unreachable' },
    ]);
  });

  it('notifies camera-detail subscribers with the full result, including detections', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, fire } = makeFakeScheduler();
    const detection: VehicleDetection = { class: 'bus', confidence: 0.8, box: { x: 0, y: 0, width: 0.3, height: 0.3 } };
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const service = new TrafficAnalysisService(source, frameGrabber, makeDetector([detection]), makeColorEstimator(), makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
    });

    const results: CameraAnalysisResult[] = [];
    service.subscribeCameraDetail('cam-1', (result) => results.push(result));

    await service.start();
    await fire(0);

    expect(results).toHaveLength(1);
    expect(results[0].detections).toEqual([{ ...detection, trackId: 1 }]);
  });

  it('boosts the sampling rate while a camera has a detail subscriber, and reverts once unsubscribed', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, scheduled, fire } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const service = new TrafficAnalysisService(source, frameGrabber, makeDetector(), makeColorEstimator(), makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      backgroundIntervalMs: 10_000,
      boostedIntervalMs: 500,
    });

    await service.start();

    const unsubscribe = service.subscribeCameraDetail('cam-1', () => undefined);
    await fire(0);
    expect(scheduled[1].ms).toBe(500);

    unsubscribe();
    await fire(1);
    expect(scheduled[2].ms).toBe(10_000);
  });

  it('requests a streaming capture for boosted ticks, and stops it once the last subscriber unsubscribes', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, fire } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame')))) as FrameGrabberLike & {
      stopStreaming: jest.Mock;
    };
    frameGrabber.stopStreaming = jest.fn();
    const service = new TrafficAnalysisService(source, frameGrabber, makeDetector(), makeColorEstimator(), makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      backgroundIntervalMs: 10_000,
      boostedIntervalMs: 500,
    });

    await service.start();

    const unsubscribe = service.subscribeCameraDetail('cam-1', () => undefined);
    await fire(0);
    expect(frameGrabber.grabFrame).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'cam-1' }), { streaming: true });
    expect(frameGrabber.stopStreaming).not.toHaveBeenCalled();

    unsubscribe();
    expect(frameGrabber.stopStreaming).toHaveBeenCalledWith('cam-1');
  });

  it('passes fastMode: true to the detector for a boosted (subscribed) tick, and false for a background tick', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, fire } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const detector = makeDetector();
    const service = new TrafficAnalysisService(source, frameGrabber, detector, makeColorEstimator(), makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      backgroundIntervalMs: 10_000,
      boostedIntervalMs: 500,
    });

    await service.start();

    // First tick (index 0): no subscriber yet -> background/full-tiling mode.
    await fire(0);
    expect(detector.detect).toHaveBeenLastCalledWith(expect.any(Buffer), { fastMode: false });

    // Second tick (index 1): boosted while subscribed -> fastMode enabled.
    service.subscribeCameraDetail('cam-1', () => undefined);
    await fire(1);
    expect(detector.detect).toHaveBeenLastCalledWith(expect.any(Buffer), { fastMode: true });
  });

  it('skips analysis entirely for unwatched cameras while a different camera is being watched, and resumes once watching stops', async () => {
    const cameras = [makeCamera({ id: 'cam-1' }), makeCamera({ id: 'cam-2' })];
    const source = makeSource(cameras);
    const { scheduler, scheduled, fire } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const service = new TrafficAnalysisService(source, frameGrabber, makeDetector(), makeColorEstimator(), makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      backgroundIntervalMs: 10_000,
      boostedIntervalMs: 500,
    });

    await service.start();
    // scheduled[0] = cam-1 initial tick, scheduled[1] = cam-2 initial tick.

    const unsubscribe = service.subscribeCameraDetail('cam-1', () => undefined);

    // cam-2's tick fires while cam-1 is being watched - should be skipped entirely.
    await fire(1);
    expect(frameGrabber.grabFrame).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'cam-2' }), expect.anything());
    expect(scheduled[2].ms).toBe(10_000);

    unsubscribe();

    // cam-2's next tick fires after watching stopped - should analyze normally.
    await fire(2);
    expect(frameGrabber.grabFrame).toHaveBeenCalledWith(expect.objectContaining({ id: 'cam-2' }), { streaming: false });
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

    const service = new TrafficAnalysisService(source, frameGrabber, makeDetector(), makeColorEstimator(), makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      maxConcurrency: 2,
    });

    await service.start();
    expect(scheduled).toHaveLength(4);

    await Promise.all(scheduled.slice(0, 4).map((entry) => entry.fn() as unknown as Promise<void>));

    expect(maxObserved).toBe(2);
    expect(frameGrabber.grabFrame).toHaveBeenCalledTimes(4);
  });

  it.each([
    [0, 'light'],
    [5, 'light'],
    [6, 'moderate'],
    [14, 'moderate'],
    [15, 'heavy'],
    [30, 'heavy'],
  ])('derives traffic level for a total count of %i as "%s"', async (count, expectedLevel) => {
    const source = makeSource([makeCamera()]);
    const { scheduler, fire } = makeFakeScheduler();
    const detections: VehicleDetection[] = Array.from({ length: count as number }, () => ({
      class: 'car',
      confidence: 0.9,
      box: { x: 0, y: 0, width: 0.1, height: 0.1 },
    }));
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const results: CameraAnalysisResult[] = [];
    const service = new TrafficAnalysisService(source, frameGrabber, makeDetector(detections), makeColorEstimator(), makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
      moderateThreshold: 6,
      heavyThreshold: 15,
    });
    service.subscribeCameraDetail('cam-1', (result) => results.push(result));

    await service.start();
    await fire(0);

    expect(results[0].trafficLevel).toBe(expectedLevel);
  });

  it('getLatestOverview seeds from the history store on construction', () => {
    const source = makeSource([makeCamera()]);
    const historyStore = makeHistoryStore();
    (historyStore.getLatestForAllCameras as jest.Mock).mockReturnValue([
      { cameraId: 'cam-1', timestamp: FIXED_NOW.toISOString(), totalCount: 4, countsByClass: emptyClassCounts(), trafficLevel: 'light' },
    ]);
    const service = new TrafficAnalysisService(source, makeFrameGrabber(), makeDetector(), makeColorEstimator(), historyStore);

    expect(service.getLatestOverview()).toEqual([
      { cameraId: 'cam-1', timestamp: FIXED_NOW.toISOString(), totalCount: 4, trafficLevel: 'light' },
    ]);
  });

  it('getHistory delegates to the history store', () => {
    const source = makeSource([makeCamera()]);
    const historyStore = makeHistoryStore();
    const service = new TrafficAnalysisService(source, makeFrameGrabber(), makeDetector(), makeColorEstimator(), historyStore);

    service.getHistory('cam-1', { limit: 5 });

    expect(historyStore.getHistory).toHaveBeenCalledWith('cam-1', { limit: 5 });
  });

  it('stop() clears pending timers so no further ticks occur', async () => {
    const source = makeSource([makeCamera()]);
    const { scheduler, scheduled } = makeFakeScheduler();
    const frameGrabber = makeFrameGrabber(jest.fn(async () => okFrame(Buffer.from('frame'))));
    const service = new TrafficAnalysisService(source, frameGrabber, makeDetector(), makeColorEstimator(), makeHistoryStore(), {
      scheduler,
      now: () => FIXED_NOW,
    });

    await service.start();
    expect(scheduled).toHaveLength(1);

    service.stop();

    expect(scheduled).toHaveLength(0);
  });
});
