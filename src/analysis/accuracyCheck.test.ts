import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CameraEntry } from '../types/camera';
import { CameraAnalysisResult } from '../types/analysis';
import { countEvents } from '../types/accuracy';
import { AccuracyCheckDeps, AccuracyCheckService } from './accuracyCheck';
import { CameraAnalyzer } from './cameraAnalyzer';
import { decodeClip } from './clipFfmpeg';
import { bundledFfmpegPath } from './ffmpegRunner';
import { CameraPassageModel } from './passageModel';
import { SYNTHETIC_CLIP_PATH } from './__fixtures__/syntheticFootage';

const T0 = new Date('2026-10-22T10:00:00.000Z');

function makeCamera(overrides: Partial<CameraEntry> = {}): CameraEntry {
  return {
    id: 'cam-1',
    name: 'Camera 1',
    location: { address: 'Square 1' },
    source: 'Test',
    url: 'https://example.com/cam-1.m3u8',
    protocol: 'HLS',
    status: 'active',
    lastVerifiedAt: null,
    ...overrides,
  };
}

/** A passage model that already knows the road runs left-right, so A is rightward and B leftward. */
function horizontalModel(cameraId: string): CameraPassageModel {
  const model = new CameraPassageModel(cameraId);
  model.direction.seed({ sxx: 1, syy: 0, sxy: 0, n: 10 });
  return model;
}

function fakeResult(overrides: Partial<CameraAnalysisResult> = {}): CameraAnalysisResult {
  return { finishedTracks: [], warmingUp: false, ...overrides } as unknown as CameraAnalysisResult;
}

describe('AccuracyCheckService', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accuracy-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function setup(overrides: Partial<AccuracyCheckDeps> = {}) {
    const cameras = [makeCamera(), makeCamera({ id: 'off', status: 'inactive' }), makeCamera({ id: 'hid', hidden: true })];
    const deps: AccuracyCheckDeps = {
      dir,
      getCamera: async (id) => cameras.find((c) => c.id === id),
      record: async (_camera, file) => fs.writeFileSync(file, 'clip'),
      // 30 s of frames at 1 fps; warm from the third.
      decode: async (_file, _fps, onFrame) => {
        for (let i = 0; i < 30; i++) await onFrame({ width: 1, height: 1, data: new Uint8Array(1) }, i);
      },
      createAnalyzer: () => ({ analyze: async () => fakeResult() }),
      passageModel: horizontalModel,
      analysisFps: () => 1,
      now: () => T0,
      ...overrides,
    };
    return new AccuracyCheckService(deps);
  }

  it('counts the vehicles on a recorded clip with the live analysis, labelled by the learned road axis', async () => {
    const service = setup({
      record: async (_camera, file) => fs.copyFileSync(SYNTHETIC_CLIP_PATH, file),
      decode: (file, fps, onFrame) => decodeClip(file, fps, onFrame, bundledFfmpegPath()),
      createAnalyzer: (camera) => new CameraAnalyzer(camera.id),
      analysisFps: () => 3,
    });

    const started = await service.start('cam-1', 120);
    expect(started).toEqual(expect.objectContaining({ state: 'recording', cameraId: 'cam-1', durationSec: 120, warmupSec: 15 }));
    await service.idle();

    const check = service.get(started.id)!;
    expect(check.state).toBe('ready');
    expect(check.hasClip).toBe(true);
    expect(check.axis).toEqual({ x: 1, y: 0 });
    // Every synthetic vehicle, each once; the clip is 40 s, so the compared stretch ends 5 s before that.
    expect(check.passages).toHaveLength(7);
    expect(check.countFrom).toBe(15);
    expect(check.countTo).toBe(34);
    expect(countEvents(check.passages, check.countFrom, check.countTo)).toEqual({ total: 5, a: 3, b: 2 });
    expect(service.clipFile(check.id)).toBe(path.join(dir, check.id, 'clip.mp4'));
  }, 60_000);

  it('runs one check at a time, and only on an active, shown camera', async () => {
    const service = setup();
    await expect(service.start('off', 300)).rejects.toMatchObject({ status: 400, code: 'no-camera' });
    await expect(service.start('hid', 300)).rejects.toMatchObject({ status: 400 });
    await expect(service.start('nope', 300)).rejects.toMatchObject({ status: 400 });

    const first = await service.start('cam-1', 999);
    expect(first.durationSec).toBe(300);
    await expect(service.start('cam-1', 300)).rejects.toMatchObject({ status: 409, code: 'busy' });
    await service.idle();
    expect(service.get(first.id)!.state).toBe('ready');
  });

  it('keeps a failed recording with its reason', async () => {
    const service = setup({ record: async () => Promise.reject(new Error('Server returned 404 Not Found')) });
    const check = await service.start('cam-1', 300);
    await service.idle();
    expect(service.get(check.id)).toEqual(expect.objectContaining({ state: 'failed', error: 'Server returned 404 Not Found', hasClip: false }));
  });

  it('saves the user count, clamped into the clip and sorted, and sums both in the list', async () => {
    const service = setup({
      createAnalyzer: () => ({
        analyze: async (_frame, timestamp) => {
          const at = (Date.parse(timestamp) - T0.getTime()) / 1000;
          if (at !== 20) return fakeResult({ warmingUp: at < 2 });
          const box = { width: 0.1, height: 0.1, y: 0.5 };
          return fakeResult({
            finishedTracks: [
              { trackId: 1, firstSeen: new Date(T0.getTime() + 18_000).toISOString(), lastSeen: timestamp, firstBox: { ...box, x: 0.1 }, lastBox: { ...box, x: 0.8 }, hits: 5 },
            ],
          });
        },
      }),
    });
    const check = await service.start('cam-1', 300);
    await expect(Promise.resolve().then(() => service.saveManual(check.id, { clicks: [] }))).rejects.toMatchObject({ code: 'not-ready' });
    await service.idle();

    const saved = service.saveManual(check.id, {
      clicks: [{ t: 19.234, direction: 'A' }, { t: 16, direction: 'B' }, { t: -3, direction: 'A' }, { t: 'x' }, { t: 21, direction: 'sideways' }],
    });
    expect(saved.manual).toEqual([{ t: 0, direction: 'A' }, { t: 16, direction: 'B' }, { t: 19.23, direction: 'A' }, { t: 21, direction: null }]);
    expect(service.list()).toEqual([
      expect.objectContaining({ id: check.id, state: 'ready', app: { total: 1, a: 1, b: 0 }, manual: { total: 3, a: 1, b: 1 } }),
    ]);
    expect(() => service.saveManual('nope', {})).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('marks a check the server stopped in the middle of as failed', async () => {
    const service = setup({ record: () => new Promise(() => undefined) });
    const check = await service.start('cam-1', 300);

    const restarted = setup();
    expect(restarted.get(check.id)).toEqual(expect.objectContaining({ state: 'failed' }));
    expect(service.get(check.id)!.state).toBe('recording');
  });
});
