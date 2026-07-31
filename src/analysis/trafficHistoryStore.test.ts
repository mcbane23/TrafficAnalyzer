import { TrafficHistoryStore } from './trafficHistoryStore';
import { StoredAnalysisResult, emptyClassCounts } from '../types/analysis';

function makeResult(overrides: Partial<StoredAnalysisResult> = {}): StoredAnalysisResult {
  return {
    cameraId: 'cam-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    totalCount: 3,
    countsByClass: { ...emptyClassCounts(), car: 3 },
    trafficLevel: 'light',
    ...overrides,
  };
}

describe('TrafficHistoryStore', () => {
  let store: TrafficHistoryStore;

  beforeEach(() => {
    store = new TrafficHistoryStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('returns an empty array when nothing has been recorded', () => {
    expect(store.getLatestForAllCameras()).toEqual([]);
    expect(store.getHistory('cam-1')).toEqual([]);
  });

  it('records a result and returns it back via getHistory', () => {
    const result = makeResult();
    store.record(result);

    expect(store.getHistory('cam-1')).toEqual([result]);
  });

  it('getLatestForAllCameras returns one row per camera - the most recently recorded', () => {
    store.record(makeResult({ cameraId: 'cam-1', timestamp: '2026-01-01T00:00:00.000Z', totalCount: 1 }));
    store.record(makeResult({ cameraId: 'cam-1', timestamp: '2026-01-01T00:00:10.000Z', totalCount: 5 }));
    store.record(makeResult({ cameraId: 'cam-2', timestamp: '2026-01-01T00:00:05.000Z', totalCount: 2 }));

    const latest = store.getLatestForAllCameras();

    expect(latest).toHaveLength(2);
    expect(latest.find((r) => r.cameraId === 'cam-1')).toMatchObject({ totalCount: 5, timestamp: '2026-01-01T00:00:10.000Z' });
    expect(latest.find((r) => r.cameraId === 'cam-2')).toMatchObject({ totalCount: 2 });
  });

  it('getHistory returns results for a camera ordered oldest-first', () => {
    store.record(makeResult({ cameraId: 'cam-1', timestamp: '2026-01-01T00:00:10.000Z', totalCount: 2 }));
    store.record(makeResult({ cameraId: 'cam-1', timestamp: '2026-01-01T00:00:00.000Z', totalCount: 1 }));
    store.record(makeResult({ cameraId: 'cam-1', timestamp: '2026-01-01T00:00:20.000Z', totalCount: 3 }));

    const history = store.getHistory('cam-1');

    expect(history.map((r) => r.totalCount)).toEqual([1, 2, 3]);
  });

  it('getHistory only returns results for the requested camera', () => {
    store.record(makeResult({ cameraId: 'cam-1', totalCount: 1 }));
    store.record(makeResult({ cameraId: 'cam-2', totalCount: 9 }));

    expect(store.getHistory('cam-1')).toHaveLength(1);
    expect(store.getHistory('cam-1')[0].totalCount).toBe(1);
  });

  it('getHistory filters by sinceIso when provided', () => {
    store.record(makeResult({ timestamp: '2026-01-01T00:00:00.000Z', totalCount: 1 }));
    store.record(makeResult({ timestamp: '2026-01-01T00:00:10.000Z', totalCount: 2 }));
    store.record(makeResult({ timestamp: '2026-01-01T00:00:20.000Z', totalCount: 3 }));

    const history = store.getHistory('cam-1', { sinceIso: '2026-01-01T00:00:10.000Z' });

    expect(history.map((r) => r.totalCount)).toEqual([2, 3]);
  });

  it('getHistory respects the limit option, keeping the most recent results', () => {
    for (let i = 0; i < 5; i++) {
      store.record(makeResult({ timestamp: `2026-01-01T00:00:0${i}.000Z`, totalCount: i }));
    }

    const history = store.getHistory('cam-1', { limit: 2 });

    expect(history.map((r) => r.totalCount)).toEqual([3, 4]);
  });

  it('round-trips countsByClass as a full per-class breakdown', () => {
    const result = makeResult({ countsByClass: { car: 2, bus: 1, truck: 0, tram: 0, motorcycle: 1 } });
    store.record(result);

    expect(store.getHistory('cam-1')[0].countsByClass).toEqual({ car: 2, bus: 1, truck: 0, tram: 0, motorcycle: 1 });
  });
});
