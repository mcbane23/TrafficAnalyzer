import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileThumbnailStore, StillGrabber, StillThumbnailService, StillThumbnailServiceOptions, Thumbnail } from './stillThumbnailService';
import { AnalysisScheduler } from './trafficAnalysisService';
import { CameraEntry } from '../types/camera';
import { GrabFrameResult } from './frameGrabber';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const MINUTE = 60_000;

function makeCamera(id: string, overrides: Partial<CameraEntry> = {}): CameraEntry {
  return {
    id,
    name: id,
    location: { address: 'Test Square' },
    resolution: null,
    source: 'Test Source',
    url: `https://example.com/${id}.m3u8`,
    protocol: 'HLS',
    status: 'active',
    lastVerifiedAt: null,
    lastError: null,
    ...overrides,
  };
}

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
  const fireAll = () => scheduled.splice(0).forEach((s) => s.fn());
  return { scheduler, scheduled, fireAll };
}

/** A grabber whose grabs the test resolves one by one, recording how many run at once. */
class FakeGrabber implements StillGrabber {
  readonly calls: string[] = [];
  private readonly pending: Array<{ cameraId: string; resolve: (r: GrabFrameResult) => void }> = [];
  inFlight = 0;
  maxInFlight = 0;

  grabFrame(camera: CameraEntry): Promise<GrabFrameResult> {
    this.calls.push(camera.id);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise((resolve) => this.pending.push({ cameraId: camera.id, resolve }));
  }

  /** Settles the oldest pending grab, with a frame stamped `atMs` or a failure. */
  async settle(result: { atMs: number } | { error: string }): Promise<void> {
    const next = this.pending.shift();
    if (!next) throw new Error('no grab pending');
    this.inFlight--;
    next.resolve('error' in result ? { ok: false, error: result.error } : { ok: true, frame: { width: 1, height: 1, data: Uint8Array.of(1) }, capturedAt: result.atMs });
    await flush();
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(cameras: CameraEntry[], options: Partial<StillThumbnailServiceOptions> = {}) {
  const grabber = new FakeGrabber();
  const { scheduler, scheduled, fireAll } = makeFakeScheduler();
  const live = new Map<string, Thumbnail>();
  let nowMs = T0;
  const service = new StillThumbnailService({ load: async () => cameras }, grabber, {
    liveFrame: (id) => live.get(id) ?? null,
    encode: async () => Buffer.from('jpeg'),
    scheduler,
    now: () => nowMs,
    ...options,
  });
  return {
    service,
    grabber,
    scheduled,
    live,
    setNow: (ms: number) => (nowMs = ms),
    /** Fires the next check and lets its camera list load. */
    nextCheck: async () => {
      fireAll();
      await flush();
    },
  };
}

describe('StillThumbnailService', () => {
  it('grabs a still for every active, shown camera without a live thumbnail, one at a time, at start', async () => {
    const t = setup([makeCamera('a'), makeCamera('b'), makeCamera('off', { status: 'inactive' }), makeCamera('hid', { hidden: true }), makeCamera('live')]);
    t.live.set('live', { buffer: Buffer.from('live'), capturedAt: new Date(T0).toISOString() });
    t.service.start();
    await flush();

    expect(t.grabber.calls).toEqual(['a']);
    await t.grabber.settle({ atMs: T0 });
    expect(t.grabber.calls).toEqual(['a', 'b']);
    await t.grabber.settle({ atMs: T0 });
    await t.service.idle();

    expect(t.grabber.calls).toEqual(['a', 'b']);
    expect(t.grabber.maxInFlight).toBe(1);
    expect(t.service.getThumbnail('a')).toEqual({ buffer: Buffer.from('jpeg'), capturedAt: new Date(T0).toISOString() });
    expect(t.service.getThumbnail('off')).toBeNull();
  });

  it('runs up to `concurrency` grabs at once', async () => {
    const t = setup([makeCamera('a'), makeCamera('b'), makeCamera('c')], { concurrency: 2 });
    t.service.start();
    await flush();
    expect(t.grabber.calls).toEqual(['a', 'b']);
    await t.grabber.settle({ atMs: T0 });
    expect(t.grabber.calls).toEqual(['a', 'b', 'c']);
    expect(t.grabber.maxInFlight).toBe(2);
  });

  it('serves the live thumbnail while a camera is analyzed, and keeps it once analysis stops', async () => {
    const t = setup([makeCamera('a')]);
    const live = { buffer: Buffer.from('live'), capturedAt: new Date(T0).toISOString() };
    t.live.set('a', live);
    t.service.start();
    await t.service.idle();
    expect(t.grabber.calls).toEqual([]);

    expect(t.service.getThumbnail('a')).toBe(live);
    t.live.delete('a');
    expect(t.service.getThumbnail('a')).toBe(live);
  });

  it('reports when each thumbnail was captured, live ones included', async () => {
    const t = setup([makeCamera('a'), makeCamera('live')]);
    t.live.set('live', { buffer: Buffer.from('live'), capturedAt: new Date(T0 + 5000).toISOString() });
    t.service.start();
    await flush();
    await t.grabber.settle({ atMs: T0 });
    await t.service.idle();
    expect(t.service.capturedTimes(['a', 'live', 'none'])).toEqual({ a: new Date(T0).toISOString(), live: new Date(T0 + 5000).toISOString() });
  });

  it('grabs a still again once it is older than the refresh interval, not before', async () => {
    const t = setup([makeCamera('a')], { refreshIntervalMs: 30 * MINUTE });
    t.service.start();
    await flush();
    await t.grabber.settle({ atMs: T0 });
    await t.service.idle();

    t.setNow(T0 + 29 * MINUTE);
    await t.nextCheck();
    expect(t.grabber.calls).toEqual(['a']);

    t.setNow(T0 + 30 * MINUTE);
    await t.nextCheck();
    expect(t.grabber.calls).toEqual(['a', 'a']);
    await t.grabber.settle({ atMs: T0 + 30 * MINUTE });
    expect(t.service.getThumbnail('a')?.capturedAt).toBe(new Date(T0 + 30 * MINUTE).toISOString());
  });

  it('does not refresh a camera that is analyzed by the time its turn comes', async () => {
    const t = setup([makeCamera('a'), makeCamera('b')]);
    t.service.start();
    await flush();
    t.live.set('b', { buffer: Buffer.from('live'), capturedAt: new Date(T0).toISOString() });
    await t.grabber.settle({ atMs: T0 });
    await t.service.idle();
    expect(t.grabber.calls).toEqual(['a']);
  });

  it('retries a failed grab after the retry delay, and keeps the previous still meanwhile', async () => {
    const t = setup([makeCamera('a')], { retryDelayMs: 5 * MINUTE, refreshIntervalMs: 30 * MINUTE });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    t.service.start();
    await flush();
    await t.grabber.settle({ atMs: T0 });
    await t.service.idle();

    t.setNow(T0 + 30 * MINUTE);
    await t.nextCheck();
    await t.grabber.settle({ error: 'frame capture timed out' });
    await t.service.idle();
    expect(t.service.getThumbnail('a')?.capturedAt).toBe(new Date(T0).toISOString());

    t.setNow(T0 + 34 * MINUTE);
    await t.nextCheck();
    expect(t.grabber.calls).toHaveLength(2);
    t.setNow(T0 + 35 * MINUTE);
    await t.nextCheck();
    expect(t.grabber.calls).toHaveLength(3);
  });

  it('starts with the kept stills and keeps new ones', async () => {
    const kept = new Map([['a', { buffer: Buffer.from('kept'), capturedAt: new Date(T0 - MINUTE).toISOString() }]]);
    const store = { loadAll: () => kept, save: jest.fn() };
    const t = setup([makeCamera('a'), makeCamera('b')], { store });
    t.service.start();
    expect(t.service.getThumbnail('a')?.buffer.toString()).toBe('kept');
    await flush();

    expect(t.grabber.calls).toEqual(['b']);
    await t.grabber.settle({ atMs: T0 });
    expect(store.save).toHaveBeenCalledWith('b', { buffer: Buffer.from('jpeg'), capturedAt: new Date(T0).toISOString() });
  });

  it('stops scheduling checks once stopped', async () => {
    const t = setup([]);
    t.service.start();
    await t.service.idle();
    expect(t.scheduled).toHaveLength(1);
    t.service.stop();
    expect(t.scheduled).toHaveLength(0);
  });
});

describe('FileThumbnailStore', () => {
  it('round-trips stills, capture time included', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-'));
    try {
      const store = new FileThumbnailStore(path.join(dir, 'thumbnails'));
      expect(store.loadAll().size).toBe(0);
      const thumbnail = { buffer: Buffer.from('jpeg'), capturedAt: '2026-01-01T00:00:00.000Z' };
      store.save('cam/1', thumbnail);
      expect(store.loadAll()).toEqual(new Map([['cam/1', thumbnail]]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
