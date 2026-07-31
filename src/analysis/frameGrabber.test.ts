import { EventEmitter } from 'node:events';
import { FrameGrabber } from './frameGrabber';
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

/** A JPEG byte sequence with valid SOI/EOI markers, so the streaming-mode frame extractor recognizes it as a complete frame. */
function makeJpeg(label: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(label), Buffer.from([0xff, 0xd9])]);
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
  it('returns the captured frame buffer on success', async () => {
    const frameBuffer = Buffer.from('jpeg-bytes');
    const runner = makeFakeRunner({ exitCode: 0, stdout: frameBuffer, stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ffmpegRunner: runner });

    const result = await grabber.grabFrame(makeCamera());

    expect(result).toEqual({ ok: true, buffer: frameBuffer });
  });

  it('includes -i <url> and the single-frame mjpeg output options', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: Buffer.from('x'), stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ffmpegRunner: runner });

    await grabber.grabFrame(makeCamera({ url: 'https://example.com/live.m3u8' }));

    expect(runner).toHaveBeenCalledWith(
      expect.arrayContaining(['-i', 'https://example.com/live.m3u8', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg']),
      expect.any(Number),
    );
  });

  it('adds the -rtsp_transport tcp flag for RTSP cameras', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: Buffer.from('x'), stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ffmpegRunner: runner });

    await grabber.grabFrame(makeCamera({ protocol: 'RTSP', url: 'rtsp://example.com/stream' }));

    expect(runner).toHaveBeenCalledWith(expect.arrayContaining(['-rtsp_transport', 'tcp']), expect.any(Number));
  });

  it('does not add the -rtsp_transport flag for non-RTSP cameras', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: Buffer.from('x'), stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ffmpegRunner: runner });

    await grabber.grabFrame(makeCamera({ protocol: 'HLS' }));

    expect(runner).toHaveBeenCalledWith(expect.not.arrayContaining(['-rtsp_transport']), expect.any(Number));
  });

  it('passes configured headers to ffmpeg via -headers when set', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: Buffer.from('x'), stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ffmpegRunner: runner });

    await grabber.grabFrame(makeCamera({ headers: { Referer: 'https://uzivokamere.com/' } }));

    expect(runner).toHaveBeenCalledWith(
      expect.arrayContaining(['-headers', 'Referer: https://uzivokamere.com/\r\n']),
      expect.any(Number),
    );
  });

  it('does not add the -headers flag when no headers are configured', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: Buffer.from('x'), stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ffmpegRunner: runner });

    await grabber.grabFrame(makeCamera());

    expect(runner).toHaveBeenCalledWith(expect.not.arrayContaining(['-headers']), expect.any(Number));
  });

  it('returns a failure when the capture times out', async () => {
    const runner = makeFakeRunner({ exitCode: null, stdout: Buffer.alloc(0), stderr: '', timedOut: true });
    const grabber = new FrameGrabber({ ffmpegRunner: runner });

    const result = await grabber.grabFrame(makeCamera());

    expect(result).toEqual({ ok: false, error: 'frame capture timed out' });
  });

  it('returns a failure with the stderr reason when ffmpeg exits non-zero', async () => {
    const runner = makeFakeRunner({ exitCode: 1, stdout: Buffer.alloc(0), stderr: 'Connection refused\nsome detail', timedOut: false });
    const grabber = new FrameGrabber({ ffmpegRunner: runner });

    const result = await grabber.grabFrame(makeCamera());

    expect(result).toEqual({ ok: false, error: 'Connection refused' });
  });

  it('returns a failure when ffmpeg produces no frame data', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: Buffer.alloc(0), stderr: '', timedOut: false });
    const grabber = new FrameGrabber({ ffmpegRunner: runner });

    const result = await grabber.grabFrame(makeCamera());

    expect(result).toEqual({ ok: false, error: 'ffmpeg produced no frame data' });
  });

  it('returns a failure when the ffmpeg runner throws', async () => {
    const runner: FfmpegRunner = jest.fn(async () => {
      throw new Error('spawn ENOENT');
    });
    const grabber = new FrameGrabber({ ffmpegRunner: runner });

    const result = await grabber.grabFrame(makeCamera());

    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain('spawn ENOENT');
  });

  describe('streaming mode', () => {
    it('starts a persistent stream and resolves once the first frame is decoded', async () => {
      const { runner, stdout } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ffmpegStreamRunner: runner });

      const pending = grabber.grabFrame(makeCamera(), { streaming: true });
      stdout.emit('data', makeJpeg('frame-1'));

      const result = await pending;
      expect(result).toEqual({ ok: true, buffer: makeJpeg('frame-1') });
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('reuses the same stream (does not re-spawn) across repeated calls for the same camera', async () => {
      const { runner, stdout } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ffmpegStreamRunner: runner });

      const first = grabber.grabFrame(makeCamera(), { streaming: true });
      stdout.emit('data', makeJpeg('frame-1'));
      await first;

      const second = await grabber.grabFrame(makeCamera(), { streaming: true });
      expect(second).toEqual({ ok: true, buffer: makeJpeg('frame-1') });
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('returns the most recently decoded frame, not a stale earlier one', async () => {
      const { runner, stdout } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ffmpegStreamRunner: runner });

      const first = grabber.grabFrame(makeCamera(), { streaming: true });
      stdout.emit('data', makeJpeg('frame-1'));
      await first;

      stdout.emit('data', makeJpeg('frame-2'));
      const second = await grabber.grabFrame(makeCamera(), { streaming: true });
      expect(second).toEqual({ ok: true, buffer: makeJpeg('frame-2') });
    });

    it('assembles a JPEG frame split across multiple stdout data chunks', async () => {
      const { runner, stdout } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ffmpegStreamRunner: runner });
      const jpeg = makeJpeg('split-frame');

      const pending = grabber.grabFrame(makeCamera(), { streaming: true });
      stdout.emit('data', jpeg.subarray(0, 3));
      stdout.emit('data', jpeg.subarray(3));

      expect(await pending).toEqual({ ok: true, buffer: jpeg });
    });

    it('uses -vf fps=<streamFps> instead of -frames:v 1 for streaming captures', async () => {
      const { runner, stdout } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ffmpegStreamRunner: runner, streamFps: 4 });

      const pending = grabber.grabFrame(makeCamera({ url: 'https://example.com/live.m3u8' }), { streaming: true });
      stdout.emit('data', makeJpeg('frame-1'));
      await pending;

      expect(runner).toHaveBeenCalledWith(
        expect.arrayContaining(['-i', 'https://example.com/live.m3u8', '-vf', 'fps=4', '-f', 'image2pipe', '-vcodec', 'mjpeg']),
      );
      expect(runner).toHaveBeenCalledWith(expect.not.arrayContaining(['-frames:v']));
    });

    it('resolves with a failure if the stream process exits before any frame is decoded', async () => {
      const { runner, fireExit } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ffmpegStreamRunner: runner });

      const pending = grabber.grabFrame(makeCamera(), { streaming: true });
      fireExit('ffmpeg stream exited with code 1');

      expect(await pending).toEqual({ ok: false, error: 'ffmpeg stream exited with code 1' });
    });

    it('kills the underlying process and clears cached state when stopStreaming is called', async () => {
      const { runner, stdout, kill } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ffmpegStreamRunner: runner });

      const pending = grabber.grabFrame(makeCamera(), { streaming: true });
      stdout.emit('data', makeJpeg('frame-1'));
      await pending;

      grabber.stopStreaming('cam-1');
      expect(kill).toHaveBeenCalledTimes(1);

      // A subsequent streaming call for the same camera must start a fresh process, not reuse the killed one.
      const restarted = grabber.grabFrame(makeCamera(), { streaming: true });
      stdout.emit('data', makeJpeg('frame-2'));
      expect(await restarted).toEqual({ ok: true, buffer: makeJpeg('frame-2') });
      expect(runner).toHaveBeenCalledTimes(2);
    });

    it('is a no-op when stopStreaming is called for a camera with no active stream', () => {
      const { runner } = makeFakeStreamRunner();
      const grabber = new FrameGrabber({ ffmpegStreamRunner: runner });

      expect(() => grabber.stopStreaming('unknown-cam')).not.toThrow();
    });
  });
});
