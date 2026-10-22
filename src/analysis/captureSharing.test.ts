import { EventEmitter } from 'node:events';
import { CaptureSharing, SharedSource, SharingCapture, canShrinkTo } from './captureSharing';
import { FrameCapture, FrameGrabber, GrabFrameResult, GrabFrameSuccess } from './frameGrabber';
import { FfmpegStreamHandle } from './ffmpegRunner';
import { yuv420pFrameSize } from './videoFrame';
import { CameraEntry } from '../types/camera';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A yuv420p frame of one flat value, so a shrunk copy is recognisable by its size and value. */
function flatFrame(width: number, height: number, value: number, capturedAt: number, streamTime?: number): GrabFrameSuccess {
  return {
    ok: true,
    frame: { width, height, data: new Uint8Array(yuv420pFrameSize(width, height)).fill(value) },
    capturedAt,
    ...(streamTime === undefined ? {} : { streamTime }),
  };
}

/** An own capture whose frames the test pushes. */
class FakeOwn implements FrameCapture {
  closed = false;
  private pending: GrabFrameResult[] = [];
  private waiter: ((result: GrabFrameResult) => void) | null = null;

  next(): Promise<GrabFrameResult> {
    if (this.closed) return Promise.resolve({ ok: false, error: 'capture closed' });
    const queued = this.pending.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => (this.waiter = resolve));
  }

  push(result: GrabFrameResult): void {
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) waiter(result);
    else this.pending.push(result);
  }

  close(): void {
    this.closed = true;
    this.push({ ok: false, error: 'capture closed' });
  }

  counters() {
    return { starts: 1, stalls: 0, dropped: 0, lastFrameAt: null, lastError: null };
  }
}

/** A shared source whose frames the test emits. */
function makeSource(width: number, height: number, fps = 3, lastFrameAt = 0) {
  const listeners = new Set<(frame: GrabFrameSuccess) => void>();
  const source: SharedSource = {
    width,
    height,
    fps: () => fps,
    lastFrameAt: () => lastFrameAt,
    onFrame: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { source, emit: (frame: GrabFrameSuccess) => listeners.forEach((l) => l(frame)), listeners };
}

function setup(options: { fps?: number; now?: number } = {}) {
  const sharing = new CaptureSharing();
  const owns: FakeOwn[] = [];
  const capture = new SharingCapture({
    cameraId: 'cam-1',
    sharing,
    openOwn: () => {
      const own = new FakeOwn();
      owns.push(own);
      return own;
    },
    width: 320,
    height: 240,
    fps: () => options.fps ?? 3,
    timeoutMs: 1000,
    maxQueuedFrames: 12,
    now: () => options.now ?? 10_000,
  });
  return { sharing, owns, capture };
}

describe('canShrinkTo', () => {
  it('takes any source at least as large as the target, whole multiple or not', () => {
    expect(canShrinkTo({ width: 704, height: 576 }, 320, 240)).toBe(true);
    expect(canShrinkTo({ width: 960, height: 720 }, 320, 240)).toBe(true);
    expect(canShrinkTo({ width: 320, height: 240 }, 320, 240)).toBe(true);
    expect(canShrinkTo({ width: 320, height: 200 }, 320, 240)).toBe(false);
  });
});

describe('SharingCapture', () => {
  it('decodes the stream itself while no source runs', async () => {
    const { owns, capture } = setup();
    const next = capture.next();
    expect(owns).toHaveLength(1);
    owns[0].push(flatFrame(320, 240, 7, 1));
    expect(await next).toEqual(flatFrame(320, 240, 7, 1));
    expect(capture.counters()).toEqual(expect.objectContaining({ starts: 1, shared: false }));
    capture.close();
    expect(owns[0].closed).toBe(true);
  });

  it('switches to a source on its first frame, shrinking it and stopping its own ffmpeg, and back when it closes', async () => {
    const { sharing, owns, capture } = setup();
    const first = capture.next();
    const { source, emit } = makeSource(960, 720);
    sharing.publish('cam-1', source);
    expect(owns[0].closed).toBe(false);

    emit(flatFrame(960, 720, 90, 2, 100));
    expect(owns[0].closed).toBe(true);
    const shared = await first;
    expect(shared).toEqual(expect.objectContaining({ ok: true, capturedAt: 2, streamTime: 100 }));
    expect((shared as GrabFrameSuccess).frame).toEqual({ width: 320, height: 240, data: new Uint8Array(yuv420pFrameSize(320, 240)).fill(90) });
    expect(capture.counters()).toEqual(expect.objectContaining({ starts: 1, shared: true }));

    sharing.unpublish('cam-1', source);
    expect(owns).toHaveLength(2);
    const next = capture.next();
    owns[1].push(flatFrame(320, 240, 5, 3));
    expect(await next).toEqual(flatFrame(320, 240, 5, 3));
    expect(capture.counters()).toEqual(expect.objectContaining({ starts: 1, shared: false }));
    capture.close();
  });

  it('thins a faster source to its own frame rate', async () => {
    const { sharing, capture } = setup({ fps: 3 });
    void capture.next().then(() => undefined);
    const { source, emit } = makeSource(640, 480, 6);
    sharing.publish('cam-1', source);
    for (let i = 0; i < 6; i++) emit(flatFrame(640, 480, i, i, 50 + i / 6));
    const times: number[] = [];
    for (let i = 0; i < 2; i++) times.push(((await capture.next()) as GrabFrameSuccess).streamTime!);
    expect(times.map((t) => Math.round(t * 6))).toEqual([302, 304]);
    capture.close();
  });

  it('keeps its own ffmpeg for a source it cannot use', async () => {
    const { sharing, owns, capture } = setup({ fps: 3 });
    void capture.next();
    const slow = makeSource(960, 720, 2);
    sharing.publish('cam-1', slow.source);
    slow.emit(flatFrame(960, 720, 1, 1, 1));
    expect(owns[0].closed).toBe(false);

    const small = makeSource(160, 120, 3);
    sharing.publish('cam-1', small.source);
    expect(slow.listeners.size).toBe(0);
    small.emit(flatFrame(160, 120, 1, 2, 2));
    expect(owns[0].closed).toBe(false);
    capture.close();
  });

  it('never starts its own ffmpeg when a live source is already running', async () => {
    const { sharing, owns, capture } = setup({ now: 10_000 });
    const { source, emit } = makeSource(960, 720, 3, 9_000);
    sharing.publish('cam-1', source);
    const next = capture.next();
    expect(owns).toHaveLength(0);
    emit(flatFrame(960, 720, 4, 5, 5));
    expect(await next).toEqual(expect.objectContaining({ ok: true, capturedAt: 5 }));
    capture.close();
  });
});

describe('FrameGrabber capture sharing', () => {
  /** A fake ffmpeg stream per spawn, recorded in `handles`. */
  function fakeRunner() {
    const handles: Array<{ stdout: EventEmitter; kill: jest.Mock }> = [];
    const runner = jest.fn(() => {
      const stdout = new EventEmitter();
      const kill = jest.fn();
      handles.push({ stdout, kill });
      const handle: FfmpegStreamHandle = {
        stdout: stdout as unknown as NodeJS.ReadableStream,
        stderr: new EventEmitter() as unknown as NodeJS.ReadableStream,
        onExit: () => undefined,
        kill,
      };
      return handle;
    });
    return { runner, handles };
  }

  const camera = { id: 'cam-1', name: 'Cam', location: { address: 'x' }, source: 's', url: 'https://x/a.m3u8', protocol: 'HLS', status: 'active', lastVerifiedAt: null } as CameraEntry;

  it('feeds the analysis capture from the overlay capture of the same camera, and its own ffmpeg again once the overlay closes', async () => {
    let now = 1_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const sharing = new CaptureSharing();
    const analysisFfmpeg = fakeRunner();
    const overlayFfmpeg = fakeRunner();
    const analysis = new FrameGrabber({ frameWidth: 2, frameHeight: 2, shareFrom: sharing, ffmpegStreamRunner: analysisFfmpeg.runner, stallTimeoutMs: 60_000 });
    const overlay = new FrameGrabber({ frameWidth: 4, frameHeight: 4, shareTo: sharing, ffmpegStreamRunner: overlayFfmpeg.runner, stallTimeoutMs: 60_000 });

    const analysisCapture = analysis.openCapture(camera);
    void analysisCapture.next();
    await flush();
    expect(analysisFfmpeg.runner).toHaveBeenCalledTimes(1);

    const overlayCapture = overlay.openCapture(camera);
    void overlayCapture.next();
    overlayFfmpeg.handles[0].stdout.emit('data', Buffer.alloc(yuv420pFrameSize(4, 4), 200));
    await flush();
    expect(analysisFfmpeg.handles[0].kill).toHaveBeenCalled();
    expect(analysisCapture.counters?.()).toEqual(expect.objectContaining({ shared: true }));

    now += 1000;
    overlayFfmpeg.handles[0].stdout.emit('data', Buffer.alloc(yuv420pFrameSize(4, 4), 100));
    const frame = (await analysisCapture.next()) as GrabFrameSuccess;
    expect(frame.frame.width).toBe(2);
    expect(Array.from(frame.frame.data)).toEqual([100, 100, 100, 100, 100, 100]);

    overlayCapture.close();
    void analysisCapture.next();
    await flush();
    expect(analysisFfmpeg.runner).toHaveBeenCalledTimes(2);
    expect(analysisCapture.counters?.()).toEqual(expect.objectContaining({ shared: false, starts: 1 }));
    analysisCapture.close();
    clock.mockRestore();
  });
});
