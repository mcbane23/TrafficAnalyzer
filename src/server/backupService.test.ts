import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TrafficStatsStore } from '../analysis/trafficStatsStore';
import type { AnalysisSettings } from '../types/admin';
import type { CameraEntry } from '../types/camera';
import { BackupError, BackupService } from './backupService';

const camera = (id: string): CameraEntry =>
  ({ id, name: id, location: { address: 'x' }, source: 's', url: `http://cam/${id}.m3u8`, protocol: 'hls' as never, status: 'active', lastVerifiedAt: null }) as CameraEntry;

function passage(cameraId: string, at: string) {
  return { cameraId, trackId: 1, firstSeen: at, lastSeen: at, dx: 0.3, dy: 0, direction: 'A' as const, sizeClass: 'car' as const };
}

describe('BackupService', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function setup(name: string, cameras: CameraEntry[], settings: AnalysisSettings) {
    const stats = new TrafficStatsStore(path.join(dir, `${name}.db`));
    const state = { cameras, settings, restored: 0 };
    const service = new BackupService({
      stats,
      settings: { current: () => state.settings, apply: async (s) => void (state.settings = s) },
      cameras: { load: async () => state.cameras, replaceAll: async (entries) => void (state.cameras = entries) },
      onStatsRestored: () => void state.restored++,
      tmpDir: dir,
      now: () => new Date('2026-10-23T08:00:00Z'),
    });
    return { stats, state, service };
  }

  it('restores statistics, cameras and settings from a backup into another server', async () => {
    const source = setup('source', [camera('slavija'), camera('autokomanda')], { enabledCameras: ['slavija'], analysisFps: 2 });
    source.stats.recordPassage(passage('slavija', '2026-10-22T07:00:10Z'));
    source.stats.recordPassage(passage('slavija', '2026-10-22T07:05:10Z'));
    source.stats.recordMinutes([{ cameraId: 'slavija', minute: 29_000_000, frames: 180, occupancySum: 9, occupancyFrames: 180 }]);
    const file = await source.service.create();

    const target = setup('target', [camera('other')], { enabledCameras: [] });
    target.stats.recordPassage(passage('other', '2026-10-01T07:00:00Z'));
    const summary = await target.service.restore(file);

    expect(summary).toEqual({ createdAt: '2026-10-23T08:00:00.000Z', passages: 2, cameras: 2 });
    expect(target.state.cameras.map((c) => c.id)).toEqual(['slavija', 'autokomanda']);
    expect(target.state.settings).toEqual({ enabledCameras: ['slavija'], analysisFps: 2 });
    expect(target.state.restored).toBe(1);
    const rows = target.stats.passageBuckets({ fromMs: 0, toMs: Date.parse('2026-10-23T00:00:00Z'), bucketMs: 86_400_000 });
    expect(rows.map((r) => [r.cameraId, r.total])).toEqual([['slavija', 2]]);
    source.stats.close();
    target.stats.close();
  });

  it('refuses a file that is not a backup and changes nothing', async () => {
    const target = setup('target', [camera('other')], { enabledCameras: [] });
    const junk = path.join(dir, 'junk.sqlite');
    fs.writeFileSync(junk, 'not a database at all');
    await expect(target.service.restore(junk)).rejects.toBeInstanceOf(BackupError);
    const plainDb = new TrafficStatsStore(path.join(dir, 'plain.db'));
    plainDb.close();
    await expect(target.service.restore(path.join(dir, 'plain.db'))).rejects.toThrow('not a TrafficAnalyzer backup');
    expect(target.state.cameras.map((c) => c.id)).toEqual(['other']);
    target.stats.close();
  });
});
