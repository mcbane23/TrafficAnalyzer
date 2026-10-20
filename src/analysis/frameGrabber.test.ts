import { EventEmitter } from 'node:events';
import { FrameCapture, FrameGrabber } from './frameGrabber';
import { FfmpegOutcome, FfmpegRunner, FfmpegStreamHandle, FfmpegStreamRunner } from './ffmpegRunner';
import { CameraEntry } from '../types/camera';

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

function makeFakeRunner(outcome: FfmpegOutcome | (() => Promise<FfmpegOutcome>)): FfmpegRunner {
  return jest.fn(async () => (typeof outcome === 'function' ? outcome() : outcome));
}

/** Tests run the grabber at a 2x2 frame size, so one raw yuv420p frame is 4 luma + 1 U + 1 V = 6 bytes. */
const SIZE = { frameWidth: 2, frameHeight: 2 };
const FRAME_BYTES = 6;

/** The raw bytes of one frame, distinguishable by `label` (its last 6 characters). */
function raw(label: string): Buffer {
  return Buffer.from(label.padStart(FRAME_BYTES).slice(-FRAME_BYTES));
}

/** The `VideoFrame` the grabber should hand out for `raw(label)`. */
function frameOf(label: string) {
  return { width: 2, height: 2, data: new Uint8Array(raw(label)) };
}

/** A fake long-running ffmpeg process for streaming-mode tests: exposes its stdout/stderr as real EventEmitters and a way to simulate the process exiting. */
function makeFakeStreamRunner() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let exitCallback: ((reason: string) => void) | null = null;
  const kill = jest.fn();
  const handle: FfmpegStreamHandle = {
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    onExit: (cb) => {
      exitCallback = cb;
    },
    kill,
  };
  const runner: FfmpegStreamRunner = jest.fn(() => handle);
  return {
    runner,
    stdout,
    stderr,
    kill,
    fireExit: (reason: string) => exitCallback?.(reason),
  };
}

describe('FrameGrabber', () => {
  // Every capture a test opens is closed afterwards, so its supervision
  // timers (stall watchdog, restart backoff) never outlive the test.
  const openCaptures: FrameCapture[] = [];
  const originalOpenCapture = FrameGrabber.prototype.openCapture;
  beforeEach(() => {
    jest.spyOn(FrameGrabber.prototype, 'openCapture').mockImplementation(function (this: FrameGrabber, camera: CameraEntry) {
      const capture = originalOpenCapture.call(this, camera);
      openCaptures.push(capture);
      return capture;
    });
  });
  afterEach(() => {
    openCaptures.splice(0).forEach((capture) => capture.close());
    jest.restoreAllMocks();
  });

  it('returns the captured frame on success', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: raw('one'), stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ...SIZE, ffmpegRunner: runner });

    const result = await grabber.grabFrame(makeCamera());

    expect(result).toMatchObject({ ok: true, frame: frameOf('one') });
  });

  it('includes -i <url> and the single-frame raw video output options, scaled to the frame size', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: Buffer.from('x'), stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ...SIZE, ffmpegRunner: runner });

    await grabber.grabFrame(makeCamera({ url: 'https://example.com/live.m3u8' }));

    expect(runner).toHaveBeenCalledWith(
      expect.arrayContaining(['-i', 'https://example.com/live.m3u8', '-frames:v', '1', '-vf', 'scale=2:2,format=yuv420p', '-f', 'rawvideo']),
      expect.any(Number),
    );
  });

  it('adds the -rtsp_transport tcp flag for RTSP cameras', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: Buffer.from('x'), stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ...SIZE, ffmpegRunner: runner });

    await grabber.grabFrame(makeCamera({ protocol: 'RTSP', url: 'rtsp://example.com/stream' }));

    expect(runner).toHaveBeenCalledWith(expect.arrayContaining(['-rtsp_transport', 'tcp']), expect.any(Number));
  });

  it('does not add the -rtsp_transport flag for non-RTSP cameras', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: Buffer.from('x'), stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ...SIZE, ffmpegRunner: runner });

    await grabber.grabFrame(makeCamera({ protocol: 'HLS' }));

    expect(runner).toHaveBeenCalledWith(expect.not.arrayContaining(['-rtsp_transport']), expect.any(Number));
  });

  it('passes configured headers to ffmpeg via -headers when set', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: Buffer.from('x'), stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ...SIZE, ffmpegRunner: runner });

    await grabber.grabFrame(makeCamera({ headers: { Referer: 'https://uzivokamere.com/' } }));

    expect(runner).toHaveBeenCalledWith(
      expect.arrayContaining(['-headers', 'Referer: https://uzivokamere.com/\r\n']),
      expect.any(Number),
    );
  });

  it('does not add the -headers flag when no headers are configured', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: Buffer.from('x'), stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ...SIZE, ffmpegRunner: runner });

    await grabber.grabFrame(makeCamera());

    expect(runner).toHaveBeenCalledWith(expect.not.arrayContaining(['-headers']), expect.any(Number));
  });

  it('returns a failure when the capture times out', async () => {
    const runner = makeFakeRunner({ exitCode: null, stdout: Buffer.alloc(0), stderr: '', timedOut: true });
    const grabber = new FrameGrabber({ ...SIZE, ffmpegRunner: runner });

    const result = await grabber.grabFrame(makeCamera());

    expect(result).toEqual({ ok: false, error: 'frame capture timed out' });
  });

  it('returns a failure with the stderr reason when ffmpeg exits non-zero', async () => {
    const runner = makeFakeRunner({ exitCode: 1, stdout: Buffer.alloc(0), stderr: 'Connection refused\nsome detail', timedOut: false });
    const grabber = new FrameGrabber({ ...SIZE, ffmpegRunner: runner });

    const result = await grabber.grabFrame(makeCamera());

    expect(result).toEqual({ ok: false, error: 'Connection refused' });
  });

  it('returns a failure when ffmpeg produces less than a whole frame', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: Buffer.alloc(FRAME_BYTES - 1), stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ...SIZE, ffmpegRunner: runner });

    const result = await grabber.grabFrame(makeCamera());

    expect(result).toEqual({ ok: false, error: 'ffmpeg produced no frame data' });
  });

  it('returns a failure when the ffmpeg runner throws', async () => {
    const runner: FfmpegRunner = jest.fn(async () => {
      throw new Error('spawn ENOENT');
    });
    const grabber = new FrameGrabber({ ...SIZE, ffmpegRunner: runner });

    const result = await grabber.grabFrame(makeCamera());

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain('spawn ENOENT');
  });

  describe('streaming mode', () => {
    it('starts a persistent stream and resolves once the first frame is decoded', async () => {
      const { runner, stdout } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner });
      const capture = grabber.openCapture(makeCamera());

      const pending = capture.next();
      stdout.emit('data', raw('frame-1'));

      const result = await pending;
      expect(result).toMatchObject({ ok: true, frame: frameOf('frame-1') });
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('reuses the same stream (does not re-spawn), and waits for a genuinely new frame rather than re-serving an already-consumed one', async () => {
      const { runner, stdout } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner });
      const capture = grabber.openCapture(makeCamera());

      const first = capture.next();
      stdout.emit('data', raw('frame-1'));
      await first;

      // This is the regression this test guards: these HLS relays deliver
      // video in bursts (a whole fetched segment decodes in under 100ms)
      // separated by multi-second silent gaps with no new data at all. A
      // call landing in that gap must wait for the next real frame, not
      // instantly resolve with frame-1 again - re-serving it silently
      // reproduced the exact same stale detection result for the entire
      // gap in production, sometimes for 7+ seconds at a stretch.
      let secondResolved = false;
      const second = capture.next().then((r) => {
        secondResolved = true;
        return r;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(secondResolved).toBe(false);

      stdout.emit('data', raw('frame-2'));
      expect(await second).toMatchObject({ ok: true, frame: frameOf('frame-2') });
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('returns the most recently decoded frame, not a stale earlier one', async () => {
      const { runner, stdout } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner });
      const capture = grabber.openCapture(makeCamera());

      const first = capture.next();
      stdout.emit('data', raw('frame-1'));
      await first;

      stdout.emit('data', raw('frame-2'));
      const second = await capture.next();
      expect(second).toMatchObject({ ok: true, frame: frameOf('frame-2') });
    });

    it('assembles a frame split across multiple stdout data chunks', async () => {
      const { runner, stdout } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner });
      const capture = grabber.openCapture(makeCamera());
      const bytes = raw('split-frame');

      const pending = capture.next();
      stdout.emit('data', bytes.subarray(0, 3));
      stdout.emit('data', bytes.subarray(3));

      expect(await pending).toMatchObject({ ok: true, frame: frameOf('split-frame') });
    });

    it('keeps frame boundaries when a chunk ends partway into the next frame', async () => {
      const { runner, stdout } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner });
      const capture = grabber.openCapture(makeCamera());
      const both = Buffer.concat([raw('frame-1'), raw('frame-2')]);

      const pending = capture.next();
      stdout.emit('data', both.subarray(0, FRAME_BYTES + 2));
      expect(await pending).toMatchObject({ ok: true, frame: frameOf('frame-1') });

      const second = capture.next();
      stdout.emit('data', both.subarray(FRAME_BYTES + 2));
      expect(await second).toMatchObject({ ok: true, frame: frameOf('frame-2') });
    });

    it('drops a partial frame left by a process that died, rather than gluing it onto the restarted process output', async () => {
      jest.useFakeTimers();
      try {
        const { runner, stdout, fireExit } = makeFakeStreamRunner();
        const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner, restartDelayMs: 1000 });
        const capture = grabber.openCapture(makeCamera());

        const first = capture.next();
        stdout.emit('data', Buffer.concat([raw('frame-1'), raw('frame-2').subarray(0, 4)]));
        await first;
        fireExit('ffmpeg stream exited with code 1');

        const restarted = capture.next();
        jest.advanceTimersByTime(1000);
        stdout.emit('data', raw('frame-3'));
        expect(await restarted).toMatchObject({ ok: true, frame: frameOf('frame-3') });
        capture.close();
      } finally {
        jest.useRealTimers();
      }
    });

    // A burst is one fetched HLS segment's worth of frames, arriving within
    // a single stdout chunk (or a handful of them) essentially all at once.
    // Collapsing that to only the newest would throw away everything but
    // one frame per segment fetch; queueing plays the burst back across
    // successive calls instead.
    it('serves frames from a single burst in arrival order across successive calls, rather than collapsing to only the newest', async () => {
      const { runner, stdout } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner });
      const capture = grabber.openCapture(makeCamera());

      const pending = capture.next();
      stdout.emit('data', Buffer.concat([raw('frame-1'), raw('frame-2'), raw('frame-3')]));

      expect(await pending).toMatchObject({ ok: true, frame: frameOf('frame-1') });
      expect(await capture.next()).toMatchObject({ ok: true, frame: frameOf('frame-2') });
      expect(await capture.next()).toMatchObject({ ok: true, frame: frameOf('frame-3') });
    });

    it('drops the oldest queued frames once more than maxQueuedFrames arrive unconsumed, keeping the ones closest to live', async () => {
      const { runner, stdout } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner, maxQueuedFrames: 2 });
      const capture = grabber.openCapture(makeCamera());

      // Establish the stream and drain a warm-up frame first, so the burst
      // below arrives with no waiter already pending to claim its first
      // frame directly - otherwise all three would fit under the cap and
      // the drop this test is checking for would never happen.
      const warmup = capture.next();
      stdout.emit('data', raw('warmup'));
      await warmup;

      // Nobody is waiting now, so all three of these frames would queue -
      // only the newest `maxQueuedFrames` should survive the cap.
      stdout.emit('data', Buffer.concat([raw('frame-1'), raw('frame-2'), raw('frame-3')]));

      expect(await capture.next()).toMatchObject({ ok: true, frame: frameOf('frame-2') });
      expect(await capture.next()).toMatchObject({ ok: true, frame: frameOf('frame-3') });
    });

    it('uses -vf fps=<streamFps> (then scales) instead of -frames:v 1 for streaming captures, with one decoding thread', async () => {
      const { runner, stdout } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner, streamFps: 4 });
      const capture = grabber.openCapture(makeCamera({ url: 'https://example.com/live.m3u8' }));

      const pending = capture.next();
      stdout.emit('data', raw('frame-1'));
      await pending;

      expect(runner).toHaveBeenCalledWith(
        expect.arrayContaining(['-threads', '1', '-i', 'https://example.com/live.m3u8', '-vf', 'fps=4,scale=2:2,format=yuv420p', '-f', 'rawvideo']),
      );
      expect(runner).toHaveBeenCalledWith(expect.not.arrayContaining(['-frames:v']));
    });

    it('resolves with a failure if the stream process exits before any frame is decoded', async () => {
      const { runner, fireExit } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner });
      const capture = grabber.openCapture(makeCamera());

      const pending = capture.next();
      fireExit('ffmpeg stream exited with code 1');

      expect(await pending).toEqual({ ok: false, error: 'ffmpeg stream exited with code 1' });
    });

    it('kills the underlying process when the capture is closed, and refuses to serve frames afterwards', async () => {
      const { runner, stdout, kill } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner });
      const capture = grabber.openCapture(makeCamera());

      const pending = capture.next();
      stdout.emit('data', raw('frame-1'));
      await pending;

      capture.close();
      expect(kill).toHaveBeenCalledTimes(1);

      // A closed capture stays closed - it must never quietly respawn the
      // process its holder just asked to stop.
      expect(await capture.next()).toEqual({ ok: false, error: 'capture closed' });
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('fails a pending next() when the capture is closed while it is waiting', async () => {
      const { runner } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner });
      const capture = grabber.openCapture(makeCamera());

      const pending = capture.next();
      capture.close();

      expect(await pending).toEqual({ ok: false, error: 'capture closed' });
    });

    it('close() is idempotent', () => {
      const { runner, kill } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner });
      const capture = grabber.openCapture(makeCamera());

      capture.next();
      capture.close();
      capture.close();

      expect(kill).toHaveBeenCalledTimes(1);
    });

    it('does not spawn a process until the first frame is requested', () => {
      const { runner } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner });

      grabber.openCapture(makeCamera());

      expect(runner).not.toHaveBeenCalled();
    });

    describe('supervision', () => {
      beforeEach(() => jest.useFakeTimers());
      afterEach(() => jest.useRealTimers());

      // A network blip that kills ffmpeg mid-capture must not leave the
      // capture permanently dead - its holder has no way to tell, and would
      // otherwise sit on a broken stream until the viewer closed the page.
      it('restarts the process after restartDelayMs if it dies mid-capture', async () => {
        const { runner, stdout, fireExit } = makeFakeStreamRunner();
        const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner, restartDelayMs: 1000 });
        const capture = grabber.openCapture(makeCamera());

        const pending = capture.next();
        stdout.emit('data', raw('frame-1'));
        await pending;

        fireExit('ffmpeg stream exited with code 1');
        expect(runner).toHaveBeenCalledTimes(1);

        const restarted = capture.next();
        jest.advanceTimersByTime(1000);
        expect(runner).toHaveBeenCalledTimes(2);
        stdout.emit('data', raw('frame-2'));
        expect(await restarted).toMatchObject({ ok: true, frame: frameOf('frame-2') });
        capture.close();
      });

      it('backs off exponentially while the process keeps dying without producing a frame', () => {
        const { runner, fireExit } = makeFakeStreamRunner();
        const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner, restartDelayMs: 1000, maxRestartDelayMs: 4000 });
        const capture = grabber.openCapture(makeCamera());
        capture.next();

        const spawnsAfter = (ms: number) => {
          jest.advanceTimersByTime(ms);
          return (runner as jest.Mock).mock.calls.length;
        };

        fireExit('404'); // 1st failed run -> 1s
        expect(spawnsAfter(999)).toBe(1);
        expect(spawnsAfter(1)).toBe(2);
        fireExit('404'); // 2nd -> 2s
        expect(spawnsAfter(1999)).toBe(2);
        expect(spawnsAfter(1)).toBe(3);
        fireExit('404'); // 3rd -> 4s
        expect(spawnsAfter(4000)).toBe(4);
        fireExit('404'); // 4th -> capped at 4s
        expect(spawnsAfter(4000)).toBe(5);
        capture.close();
      });

      it('kills and restarts a process that stays running but stops producing frames', async () => {
        const { runner, stdout, kill } = makeFakeStreamRunner();
        const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner, stallTimeoutMs: 5000, restartDelayMs: 1000, timeoutMs: 60_000 });
        const capture = grabber.openCapture(makeCamera());

        const first = capture.next();
        stdout.emit('data', raw('frame-1'));
        await first;

        const waiting = capture.next();
        jest.advanceTimersByTime(5000);
        expect(kill).toHaveBeenCalledTimes(1);
        expect(await waiting).toEqual({ ok: false, error: 'stream stalled: no frames for 5s' });

        jest.advanceTimersByTime(1000);
        expect(runner).toHaveBeenCalledTimes(2);
        capture.close();
      });

      it('does not treat a steadily-producing process as stalled', () => {
        const { runner, stdout, kill } = makeFakeStreamRunner();
        const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner, stallTimeoutMs: 5000 });
        const capture = grabber.openCapture(makeCamera());
        capture.next();

        for (let i = 0; i < 10; i++) {
          jest.advanceTimersByTime(2000);
          stdout.emit('data', raw(`frame-${i}`));
        }

        expect(kill).not.toHaveBeenCalled();
        expect(runner).toHaveBeenCalledTimes(1);
        capture.close();
      });

      it('never restarts after close(), even with a restart pending', () => {
        const { runner, fireExit } = makeFakeStreamRunner();
        const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner, restartDelayMs: 1000 });
        const capture = grabber.openCapture(makeCamera());
        capture.next();

        fireExit('boom');
        capture.close();
        jest.advanceTimersByTime(60_000);

        expect(runner).toHaveBeenCalledTimes(1);
      });

      it('stamps each frame with the time it was decoded', async () => {
        jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const { runner, stdout } = makeFakeStreamRunner();
        const grabber = new FrameGrabber({ ...SIZE, ffmpegStreamRunner: runner });
        const capture = grabber.openCapture(makeCamera());

        const pending = capture.next();
        jest.advanceTimersByTime(1500);
        stdout.emit('data', raw('frame-1'));

        expect((await pending as { capturedAt: number }).capturedAt).toBe(Date.parse('2026-01-01T00:00:01.500Z'));
        capture.close();
      });
    });

    it('paces input in real time with -re by default, and not when realtime is off', async () => {
      const paced = makeFakeStreamRunner();
      new FrameGrabber({ ...SIZE, ffmpegStreamRunner: paced.runner }).openCapture(makeCamera()).next();
      const unpaced = makeFakeStreamRunner();
      new FrameGrabber({ ...SIZE, ffmpegStreamRunner: unpaced.runner, realtime: false }).openCapture(makeCamera()).next();

      expect(paced.runner).toHaveBeenCalledWith(expect.arrayContaining(['-re']));
      expect(unpaced.runner).toHaveBeenCalledWith(expect.not.arrayContaining(['-re']));
    });

    it('sets an I/O timeout and HTTP reconnects for http(s) streams only', () => {
      const http = makeFakeStreamRunner();
      new FrameGrabber({ ...SIZE, ffmpegStreamRunner: http.runner }).openCapture(makeCamera({ url: 'https://example.com/a.m3u8' })).next();
      const rtsp = makeFakeStreamRunner();
      new FrameGrabber({ ...SIZE, ffmpegStreamRunner: rtsp.runner }).openCapture(makeCamera({ protocol: 'RTSP', url: 'rtsp://example.com/a' })).next();

      expect(http.runner).toHaveBeenCalledWith(expect.arrayContaining(['-rw_timeout', '15000000', '-reconnect', '1']));
      expect(rtsp.runner).toHaveBeenCalledWith(expect.not.arrayContaining(['-reconnect']));
    });
  });
});
