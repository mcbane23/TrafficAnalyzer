import { DataRetentionService } from './dataRetention';
import { TrafficHistoryStore } from './trafficHistoryStore';
import { HOUR_MS, TrafficStatsStore, WHOLE_RANGE_BUCKET } from './trafficStatsStore';

const DAY_MS = 24 * HOUR_MS;
const NOW = Date.parse('2026-10-22T12:00:00.000Z');

function passage(cameraId: string, tsMs: number, trackId: number) {
  const iso = new Date(tsMs).toISOString();
  return { cameraId, trackId, firstSeen: iso, lastSeen: iso, dx: 0.3, dy: 0, direction: 'A' as const, sizeClass: 'car' as const };
}

function setup(passageDays = 30, batchSize = 3) {
  const history = new TrafficHistoryStore(':memory:');
  const stats = new TrafficStatsStore(':memory:');
  const service = new DataRetentionService({
    history,
    passages: stats,
    historyDays: 2,
    passageDays: () => passageDays,
    batchSize,
    now: () => NOW,
    log: () => {},
  });
  return { history, stats, service };
}

function record(history: TrafficHistoryStore, cameraId: string, tsMs: number) {
  history.record({ cameraId, timestamp: new Date(tsMs).toISOString(), totalCount: 1, trafficLevel: 'light' });
}

describe('DataRetentionService', () => {
  it('deletes history rows older than the retention, in batches', async () => {
    const { history, service } = setup();
    for (let i = 0; i < 10; i++) record(history, 'a', NOW - 5 * DAY_MS + i * 1000);
    record(history, 'a', NOW - HOUR_MS);

    const result = await service.runOnce();

    expect(result.history).toBe(10);
    expect(history.getHistory('a', { limit: 1000 })).toHaveLength(1);
  });

  it("keeps every camera's latest row, however old", async () => {
    const { history, service } = setup();
    record(history, 'off', NOW - 40 * DAY_MS);
    record(history, 'off', NOW - 30 * DAY_MS);

    await service.runOnce();

    expect(history.getLatestForAllCameras().map((r) => r.timestamp)).toEqual([new Date(NOW - 30 * DAY_MS).toISOString()]);
  });

  it('deletes old individual passages but keeps their hourly counts', async () => {
    const { stats, service } = setup(30);
    for (let i = 0; i < 7; i++) stats.recordPassage(passage('a', NOW - 40 * DAY_MS + i, i));
    stats.recordPassage(passage('a', NOW - DAY_MS, 99));

    const result = await service.runOnce();

    expect(result.passages).toBe(7);
    const fromMs = Math.floor((NOW - 60 * DAY_MS) / HOUR_MS) * HOUR_MS;
    const raw = stats.passageBuckets({ fromMs: fromMs + 1, toMs: NOW, bucketMs: DAY_MS });
    expect(raw.reduce((sum, row) => sum + row.total, 0)).toBe(1);
    const hourly = stats.passageBuckets({ fromMs, toMs: NOW, bucketMs: WHOLE_RANGE_BUCKET });
    expect(hourly[0].total).toBe(8);
  });

  it('keeps passages forever when the setting is 0', async () => {
    const { stats, service } = setup(0);
    stats.recordPassage(passage('a', NOW - 400 * DAY_MS, 1));

    expect((await service.runOnce()).passages).toBe(0);
  });
});
