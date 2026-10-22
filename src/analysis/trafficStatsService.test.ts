import { CameraAnalysisResult, FinishedTrack } from '../types/analysis';
import { StatsQueryError, TrafficStatsService, parseBucket, parseRange } from './trafficStatsService';
import { TrafficStatsStore } from './trafficStatsStore';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function finished(id: number, lastSeen: number, down = true, size = 0.05): FinishedTrack {
  const top = { x: 0.5, y: 0.1, width: size, height: size };
  const bottom = { x: 0.5, y: 0.8, width: size, height: size };
  return {
    trackId: id,
    firstSeen: new Date(lastSeen - 4000).toISOString(),
    lastSeen: new Date(lastSeen).toISOString(),
    firstBox: down ? top : bottom,
    lastBox: down ? bottom : top,
    hits: 12,
  };
}

function result(cameraId: string, atMs: number, overrides: Partial<CameraAnalysisResult> = {}): CameraAnalysisResult {
  return {
    cameraId,
    timestamp: new Date(atMs).toISOString(),
    totalCount: 0,
    trafficLevel: 'light',
    detections: [],
    finishedTracks: [],
    ...overrides,
  };
}

/** Feeds one frame per `stepMs` from `fromMs` to `toMs`, simulating the camera being analyzed over that span. */
function analyze(service: TrafficStatsService, cameraId: string, fromMs: number, toMs: number, stepMs = 20_000, occupancy = 0.2): void {
  for (let t = fromMs; t < toMs; t += stepMs) service.handleResult(result(cameraId, t, { occupancy }));
}

describe('TrafficStatsService', () => {
  // A Tuesday, 10:30 in Belgrade (CEST, UTC+2).
  const NOW = Date.parse('2026-10-20T08:30:00.000Z');
  let store: TrafficStatsStore;
  let service: TrafficStatsService;
  let now: number;

  beforeEach(() => {
    store = new TrafficStatsStore(':memory:');
    now = NOW;
    service = new TrafficStatsService(store, { now: () => new Date(now) });
  });

  afterEach(() => store.close());

  it('persists one passage per finished track, bucketed by when the vehicle left', () => {
    analyze(service, 'cam', NOW - HOUR, NOW);
    service.handleResult(result('cam', NOW - 50 * MINUTE, { finishedTracks: [finished(1, NOW - 50 * MINUTE), finished(2, NOW - 50 * MINUTE, false)] }));
    service.handleResult(result('cam', NOW - 3 * MINUTE, { finishedTracks: [finished(3, NOW - 3 * MINUTE)] }));
    service.flush();

    const stats = service.getCameraStats('cam', '1h', '5m');
    expect(stats.buckets).toHaveLength(12);
    expect(stats.totals).toEqual({ total: 3, a: 2, b: 1, unknown: 0, car: 3, large: 0 });
    const nonEmpty = stats.buckets.filter((b) => b.total > 0);
    expect(nonEmpty.map((b) => b.total)).toEqual([2, 1]);
    expect(stats.buckets[stats.buckets.length - 1].start).toBe('2026-10-20T08:30:00.000Z');
  });

  it('reports coverage and occupancy so an unanalyzed bucket reads as a gap, not as zero traffic', () => {
    // Only the last half hour was analyzed.
    analyze(service, 'cam', NOW - 30 * MINUTE, NOW, 20_000, 0.4);
    service.flush();

    const stats = service.getCameraStats('cam', '1h', '15m');
    // Buckets: 07:45, 08:00, 08:15 and the just-started 08:30.
    expect(stats.buckets.map((b) => b.start.slice(11, 16))).toEqual(['07:45', '08:00', '08:15', '08:30']);
    const [first, second, third] = stats.buckets;
    expect(first.coverage).toBe(0);
    expect(first.occupancy).toBeNull();
    expect(second.coverage).toBe(1);
    expect(third.coverage).toBe(1);
    expect(third.occupancy).toBeCloseTo(0.4);
    expect(stats.coverage).toBeCloseTo(30 / 45, 2);
  });

  it('ignores error and warm-up results entirely', () => {
    service.handleResult(result('cam', NOW - MINUTE, { error: 'stream down', finishedTracks: [finished(1, NOW - MINUTE)] }));
    service.handleResult(result('cam', NOW - MINUTE, { warmingUp: true, finishedTracks: [finished(2, NOW - MINUTE)] }));
    service.flush();
    const stats = service.getCameraStats('cam', '1h');
    expect(stats.totals.total).toBe(0);
    expect(stats.coverage).toBe(0);
  });

  it('builds day buckets on local (Belgrade) midnights', () => {
    // 23:30 local on Oct 18 = 21:30Z, and 00:30 local on Oct 19 = 22:30Z: different local days.
    const lateEvening = Date.parse('2026-10-18T21:30:00.000Z');
    const afterMidnight = Date.parse('2026-10-18T22:30:00.000Z');
    service.handleResult(result('cam', lateEvening, { finishedTracks: [finished(1, lateEvening)] }));
    service.handleResult(result('cam', afterMidnight, { finishedTracks: [finished(2, afterMidnight)] }));
    service.flush();

    const stats = service.getCameraStats('cam', '7d', '1d');
    expect(stats.buckets).toHaveLength(7);
    expect(stats.buckets[6].start).toBe('2026-10-19T22:00:00.000Z');
    const byStart = Object.fromEntries(stats.buckets.map((b) => [b.start, b.total]));
    expect(byStart['2026-10-17T22:00:00.000Z']).toBe(1);
    expect(byStart['2026-10-18T22:00:00.000Z']).toBe(1);
  });

  it('counts live totals for the last 5 minutes, hour and local day', () => {
    const atMidnight = Date.parse('2026-10-19T22:10:00.000Z'); // 00:10 local today
    const yesterday = Date.parse('2026-10-19T21:50:00.000Z'); // 23:50 local yesterday
    for (const [id, at] of [[1, yesterday], [2, atMidnight], [3, NOW - 30 * MINUTE], [4, NOW - 2 * MINUTE]] as const) {
      service.handleResult(result('cam', at, { finishedTracks: [finished(id, at)] }));
    }
    const live = service.getLiveCounts('cam');
    expect(live.last5m.total).toBe(1);
    expect(live.last1h.total).toBe(2);
    expect(live.today.total).toBe(3);
  });

  it('averages vehicles per analyzed hour by local weekday and hour', () => {
    // Tuesday 09:00-10:00 local = 07:00-08:00Z, half of it analyzed, 10 vehicles.
    const start = Date.parse('2026-10-20T07:00:00.000Z');
    analyze(service, 'cam', start, start + 30 * MINUTE);
    for (let i = 0; i < 10; i++) {
      const at = start + i * MINUTE;
      service.handleResult(result('cam', at, { finishedTracks: [finished(i, at)] }));
    }
    service.flush();

    const heatmap = service.getHeatmap('cam', 7);
    expect(heatmap.cells).toHaveLength(7 * 24);
    const tuesdayNine = heatmap.cells.find((c) => c.weekday === 1 && c.hour === 9)!;
    expect(tuesdayNine.vehiclesPerHour).toBe(20);
    expect(heatmap.cells.find((c) => c.weekday === 1 && c.hour === 8)!.vehiclesPerHour).toBeNull();
  });

  it('summarizes every camera with totals, coverage and a 24-hour sparkline, busiest first', () => {
    analyze(service, 'quiet', NOW - 2 * HOUR, NOW);
    analyze(service, 'busy', NOW - 2 * HOUR, NOW);
    service.handleResult(result('quiet', NOW - 10 * MINUTE, { finishedTracks: [finished(1, NOW - 10 * MINUTE)] }));
    for (let i = 0; i < 3; i++) {
      service.handleResult(result('busy', NOW - HOUR, { finishedTracks: [finished(i, NOW - HOUR)] }));
    }
    service.flush();

    const summary = service.getSummary('24h');
    expect(summary.cameras.map((c) => c.cameraId)).toEqual(['busy', 'quiet']);
    expect(summary.totals.total).toBe(4);
    const busy = summary.cameras[0];
    expect(busy.sparkline).toHaveLength(24);
    expect(busy.sparkline.slice(-3)).toEqual([0, 3, 0]);
    expect(busy.sparkline[0]).toBeNull();
    expect(busy.coverage).toBeCloseTo(2 / 24, 2);
  });

  it('compares traffic with the usual for the same hour on the same kind of day', () => {
    /** `count` vehicles evenly spread over [from, to), with the camera analyzed throughout. */
    const traffic = (from: number, to: number, count: number) => {
      analyze(service, 'cam', from, to);
      for (let i = 0; i < count; i++) {
        const at = from + Math.floor(((i + 0.5) * (to - from)) / count);
        service.handleResult(result('cam', at, { finishedTracks: [finished(i, at)] }));
      }
    };
    // Working days before today (Mon 19, Fri 16, Thu 15): 20 vehicles an hour, 08:00-11:00 local (06:00-09:00 UTC).
    // A weekend day at the same hours is far busier and must not count.
    for (const day of ['2026-10-19', '2026-10-16', '2026-10-15']) traffic(Date.parse(`${day}T06:00:00Z`), Date.parse(`${day}T09:00:00Z`), 60);
    traffic(Date.parse('2026-10-18T06:00:00Z'), Date.parse('2026-10-18T09:00:00Z'), 600);
    // Today, 09:00-10:30: twice the usual.
    traffic(NOW - 90 * MINUTE, NOW, 60);
    service.flush();

    const summary = service.getSummary('24h').cameras.find((c) => c.cameraId === 'cam')!;
    expect(summary.vsUsual).toBeCloseTo(1, 1);

    const stats = service.getCameraStats('cam', '24h', '1h');
    const at = (iso: string) => stats.buckets.find((b) => b.start === iso)!;
    expect(at('2026-10-20T07:00:00.000Z').usual).toBe(20);
    expect(at('2026-10-20T03:00:00.000Z').usual).toBeNull(); // never analyzed at 05:00 local
  });

  it('has no usual without history', () => {
    analyze(service, 'cam', NOW - HOUR, NOW);
    service.flush();
    expect(service.getSummary('24h').cameras[0].vsUsual).toBeNull();
    expect(service.getCameraStats('cam', '1h', '15m').buckets.every((b) => b.usual === null)).toBe(true);
  });

  it('re-seeds a camera road axis from persisted passages after a restart', () => {
    for (let i = 0; i < 6; i++) {
      const at = NOW - (i + 1) * MINUTE;
      service.handleResult(result('cam', at, { finishedTracks: [finished(i, at, i % 2 === 0)] }));
    }
    const restarted = new TrafficStatsService(store, { now: () => new Date(now) });
    const axis = restarted.getCameraStats('cam', '1h').axis!;
    expect(axis.x).toBeCloseTo(0);
    expect(axis.y).toBeCloseTo(1);
  });

  it('gives the same totals from the hourly roll-up as from individual passages', () => {
    for (let i = 0; i < 40; i++) {
      const at = NOW - i * 31 * MINUTE;
      service.handleResult(result('cam', at, { finishedTracks: [finished(i, at, i % 3 !== 0, i % 5 === 0 ? 0.3 : 0.05)] }));
    }
    const hourly = service.getCameraStats('cam', '24h', '1h'); // served from passage_hours
    const fine = service.getCameraStats('cam', '24h', '15m'); // served from vehicle_passages
    expect(hourly.totals.total).toBeGreaterThan(0);
    expect(hourly.totals).toEqual(fine.totals);
  });

  it('exports buckets as CSV', () => {
    service.handleResult(result('cam', NOW - MINUTE, { occupancy: 0.25, finishedTracks: [finished(1, NOW - MINUTE)] }));
    service.flush();
    const csv = service.toCsv(service.getCameraStats('cam', '1h', '15m'));
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('bucket_start,total,direction_a,direction_b,direction_unknown,car,large,occupancy,coverage');
    expect(lines).toHaveLength(5);
    expect(lines[3]).toMatch(/^2026-10-20T08:15:00.000Z,1,1,0,0,1,0,0.2500,/);
  });

  it('validates range and bucket parameters', () => {
    expect(parseRange(undefined)).toBe('24h');
    expect(parseBucket('24h', undefined)).toBe('1h');
    expect(() => parseRange('1y')).toThrow(StatsQueryError);
    expect(() => parseBucket('30d', '5m')).toThrow(StatsQueryError);
    expect(() => service.getHeatmap('cam', 0)).toThrow(StatsQueryError);
  });
});
