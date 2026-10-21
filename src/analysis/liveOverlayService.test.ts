import { CameraEntry } from '../types/camera';
import { LiveOverlayResult, VehicleDetection } from '../types/analysis';
import { LiveOverlayService, OverlayPipeline } from './liveOverlayService';
import { FrameCapture, GrabFrameResult } from './frameGrabber';
import { VideoFrame } from './videoFrame';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const FRAME: VideoFrame = { width: 2, height: 2, data: new Uint8Array(6) };

function makeCamera(overrides: Partial<CameraEntry> = {}): CameraEntry {
  return {
    id: 'cam-1',
    name: 'Camera 1',
    location: { lat: 0, lng: 0 },
    protocol: 'HLS',
    url: 'https://example.com/live.m3u8',
    status: 'active',
    lastVerifiedAt: null,
    lastError: null,
    ...overrides,
  } as CameraEntry;
}

/** A capture whose frames are pushed by the test. */
class FakeCapture implements FrameCapture {
  private readonly pending: GrabFrameResult[] = [];
  private waiter: ((r: GrabFrameResult) => void) | null = null;
  closed = false;

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

  frame(atMs: number, streamTime?: number): void {
    this.deliver({ ok: true, frame: FRAME, capturedAt: T0 + atMs, ...(streamTime === undefined ? {} : { streamTime }) });
  }

  private deliver(result: GrabFrameResult): void {
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) waiter(result);
    else if (!this.closed) this.pending.push(result);
  }
}

const CAR: VehicleDetection = { class: 'car', confidence: 0.9, box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } };

function makeFakeScheduler() {
  const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    scheduler: {
      setTimeout: (fn: () => void, ms: number) => {
        const entry = { fn, ms, cleared: false };
        scheduled.push(entry);
        return entry;
      },
      clearTimeout: (handle: unknown) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
    fireAll: () => scheduled.filter((s) => !s.cleared).forEach((s) => s.fn()),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(cameras: CameraEntry[] = [makeCamera()], options: { maxCameras?: number } = {}) {
  const captures = new Map<string, FakeCapture>();
  const grabber = {
    openCapture: jest.fn((camera: CameraEntry) => {
      const capture = new FakeCapture();
      captures.set(camera.id, capture);
      return capture;
    }),
  };
  const createPipeline = jest.fn(
    (): OverlayPipeline => ({
      detector: { detect: async () => ({ detections: [CAR], warmingUp: false }) },
      tracker: { update: (detections) => ({ tracks: detections.map((d) => ({ ...d, trackId: 7 })), finished: [] }) },
    }),
  );
  const { scheduler, fireAll } = makeFakeScheduler();
  const service = new LiveOverlayService({ load: async () => cameras }, grabber, createPipeline, {
    scheduler,
    idleStopMs: 1000,
    recentResultsMs: 1000,
    ...options,
  });
  return { service, grabber, captures, createPipeline, fireAll };
}

describe('LiveOverlayService', () => {
  it('starts nothing until a camera has a viewer, then publishes tracked detections with their stream time', async () => {
    const ctx = setup();
    expect(ctx.grabber.openCapture).not.toHaveBeenCalled();

    const received: LiveOverlayResult[] = [];
    ctx.service.subscribe('cam-1', (r) => received.push(r));
    await settle();
    ctx.captures.get('cam-1')!.frame(0, 1234.5);
    await settle();

    expect(ctx.grabber.openCapture).toHaveBeenCalledTimes(1);
    expect(received).toEqual([
      { cameraId: 'cam-1', timestamp: new Date(T0).toISOString(), streamTime: 1234.5, detections: [{ ...CAR, trackId: 7 }] },
    ]);
    ctx.service.stop();
  });

  it('reports watched cameras with their viewers and boxes per frame for the Admin page', async () => {
    const ctx = setup();
    expect(ctx.service.getMetrics()).toEqual({ maxCameras: 2, cameras: [] });
    ctx.service.subscribe('cam-1', () => undefined);
    ctx.service.subscribe('cam-1', () => undefined);
    await settle();
    ctx.captures.get('cam-1')!.frame(0, 10);
    await settle();

    expect(ctx.service.getMetrics().cameras).toEqual([
      expect.objectContaining({ cameraId: 'cam-1', name: 'Camera 1', viewers: 2, vehiclesPerFrame: 1, capture: null }),
    ]);
    ctx.service.stop();
  });

  it('shares one pipeline between viewers of the same camera and sends a late viewer the recent results first', async () => {
    const ctx = setup();
    const first: LiveOverlayResult[] = [];
    ctx.service.subscribe('cam-1', (r) => first.push(r));
    await settle();
    const capture = ctx.captures.get('cam-1')!;
    capture.frame(0, 10);
    await settle();
    capture.frame(1500, 11.5);
    await settle();

    const late: LiveOverlayResult[] = [];
    ctx.service.subscribe('cam-1', (r) => late.push(r));
    await settle();

    expect(ctx.grabber.openCapture).toHaveBeenCalledTimes(1);
    expect(ctx.createPipeline).toHaveBeenCalledTimes(1);
    // Only the result inside the 1s recent window is replayed.
    expect(late.map((r) => r.streamTime)).toEqual([11.5]);
    ctx.service.stop();
  });

  it('keeps the pipeline through a brief absence, and stops it idleStopMs after the last viewer leaves', async () => {
    const ctx = setup();
    const unsubscribe = ctx.service.subscribe('cam-1', () => undefined);
    await settle();
    unsubscribe();
    // A reload: the viewer is back before the linger runs out.
    const again = ctx.service.subscribe('cam-1', () => undefined);
    await settle();
    ctx.fireAll();
    expect(ctx.captures.get('cam-1')!.closed).toBe(false);

    again();
    ctx.fireAll();
    expect(ctx.captures.get('cam-1')!.closed).toBe(true);
    await ctx.service.idle();
  });

  it('tells a viewer when it cannot serve a camera, and over maxCameras', async () => {
    const ctx = setup([makeCamera(), makeCamera({ id: 'cam-2' }), makeCamera({ id: 'off', status: 'inactive' })], { maxCameras: 1 });
    const results: Record<string, LiveOverlayResult[]> = { 'cam-1': [], 'cam-2': [], off: [], missing: [] };
    for (const id of Object.keys(results)) {
      ctx.service.subscribe(id, (r) => results[id].push(r));
      await settle();
    }

    expect(ctx.grabber.openCapture).toHaveBeenCalledTimes(1);
    expect(results['cam-2'][0].error).toMatch(/busy/);
    expect(results.off[0].error).toMatch(/not active/);
    expect(results.missing[0].error).toMatch(/not active/);
    ctx.service.stop();
  });

  it('publishes a detection failure as an error result and keeps going', async () => {
    const ctx = setup();
    let calls = 0;
    ctx.createPipeline.mockImplementation(() => ({
      detector: {
        detect: async () => {
          calls += 1;
          if (calls === 1) throw new Error('model exploded');
          return { detections: [CAR], warmingUp: false };
        },
      },
      tracker: { update: (detections: VehicleDetection[]) => ({ tracks: detections.map((d) => ({ ...d, trackId: 1 })), finished: [] }) },
    }));
    const received: LiveOverlayResult[] = [];
    ctx.service.subscribe('cam-1', (r) => received.push(r));
    await settle();
    ctx.captures.get('cam-1')!.frame(0);
    await settle();
    ctx.captures.get('cam-1')!.frame(300);
    await settle();

    expect(received.map((r) => r.error ?? r.detections.length)).toEqual(['model exploded', 1]);
    ctx.service.stop();
  });
});
