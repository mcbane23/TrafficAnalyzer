import { execFileSync } from 'node:child_process';
import { BUNDLED_FFMPEG_PATH } from './ffmpegRunner';
import { CameraAnalyzer } from './cameraAnalyzer';
import { FrameGrabber, GrabFrameSuccess } from './frameGrabber';
import { VideoFrame, yuv420pFrameSize } from './videoFrame';
import { CameraAnalysisResult, FinishedTrack } from '../types/analysis';
import { SCENE, SYNTHETIC_CLIP_PATH, crossingSeconds } from './__fixtures__/syntheticFootage';

const FPS = 3;
const W = 320;
const H = 240;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * End-to-end: real ffmpeg decode -> real MotionDetector -> real tracker ->
 * real occupancy, on synthetic footage with a known ground truth (see
 * `__fixtures__/syntheticFootage.ts`). Asserts the properties the old
 * pipeline failed on: each vehicle counted exactly once, one id per
 * vehicle for its whole crossing (no id switches as vehicles pass each
 * other), and travel direction recoverable from the finished tracks.
 */
describe('vehicle analysis pipeline on synthetic footage', () => {
  let results: CameraAnalysisResult[];
  let finished: FinishedTrack[];

  beforeAll(async () => {
    // Decoded exactly as a live capture would be: scaled to FrameGrabber's
    // default frame size, as raw yuv420p.
    const raw = execFileSync(
      BUNDLED_FFMPEG_PATH,
      [
        '-hide_banner', '-loglevel', 'error', '-i', SYNTHETIC_CLIP_PATH,
        '-vf', `fps=${FPS},scale=${W}:${H},format=yuv420p`, '-f', 'rawvideo', 'pipe:1',
      ],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    const frameBytes = yuv420pFrameSize(W, H);

    const analyzer = new CameraAnalyzer('synthetic');
    results = [];
    for (let i = 0; (i + 1) * frameBytes <= raw.length; i++) {
      const frame: VideoFrame = { width: W, height: H, data: new Uint8Array(raw.subarray(i * frameBytes, (i + 1) * frameBytes)) };
      results.push(await analyzer.analyze(frame, new Date(T0 + (i * 1000) / FPS).toISOString()));
    }
    finished = results.flatMap((r) => r.finishedTracks);
  }, 60_000);

  it('produces no errors and stops warming up within the first ~8 seconds', () => {
    expect(results.every((r) => !r.error)).toBe(true);
    const firstWarm = results.findIndex((r) => !r.warmingUp);
    expect(firstWarm).toBeGreaterThan(0);
    expect(firstWarm / FPS).toBeLessThan(SCENE.vehicles[0].enterAt);
  });

  it('counts every vehicle exactly once', () => {
    expect(finished).toHaveLength(SCENE.vehicles.length);
  });

  it('keeps one id per vehicle for its whole crossing', () => {
    const ids = new Set(results.flatMap((r) => r.detections.map((d) => d.trackId)));
    expect(ids.size).toBe(SCENE.vehicles.length);
  });

  it('recovers each vehicle travel direction and lane from its finished track', () => {
    const observed = finished
      .map((t) => ({
        enteredAt: (Date.parse(t.firstSeen) - T0) / 1000,
        rightward: t.lastBox.x > t.firstBox.x,
        laneY: (t.firstBox.y + t.firstBox.height / 2) * SCENE.height,
      }))
      .sort((a, b) => a.enteredAt - b.enteredAt);

    observed.forEach((o, i) => {
      const truth = SCENE.vehicles[i];
      expect(o.rightward).toBe(truth.speed > 0);
      expect(Math.abs(o.laneY - truth.y)).toBeLessThan(25);
      // First seen within a second of entering the frame.
      expect(o.enteredAt).toBeGreaterThanOrEqual(truth.enterAt - 0.5);
      expect(o.enteredAt).toBeLessThan(truth.enterAt + 1.5);
    });
  });

  it('tracks each vehicle for most of the time it is in frame', () => {
    const byEntry = [...finished].sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen));
    byEntry.forEach((t, i) => {
      const trackedFor = (Date.parse(t.lastSeen) - Date.parse(t.firstSeen)) / 1000;
      expect(trackedFor).toBeGreaterThan(crossingSeconds(SCENE.vehicles[i]) * 0.6);
    });
  });
});

describe('FrameGrabber against real ffmpeg', () => {
  // The tracker's motion model runs on frame timestamps, which are decode
  // times - so they are only meaningful if decoding is paced in real time
  // rather than bursting a whole segment out at once.
  it('delivers a continuous capture evenly paced at the configured fps', async () => {
    const grabber = new FrameGrabber({ streamFps: 5 });
    const capture = grabber.openCapture({
      id: 'synthetic',
      name: 'Synthetic',
      location: { address: 'n/a' },
      resolution: null,
      source: 'test',
      url: SYNTHETIC_CLIP_PATH,
      protocol: 'HTTP',
      status: 'active',
      lastVerifiedAt: null,
      lastError: null,
    });
    try {
      const frames: GrabFrameSuccess[] = [];
      while (frames.length < 8) {
        const frame = await capture.next();
        if (!frame.ok) throw new Error(frame.error);
        frames.push(frame);
      }
      const gaps = frames.slice(3).map((f, i) => f.capturedAt - frames[i + 2].capturedAt);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      expect(mean).toBeGreaterThan(120);
      expect(mean).toBeLessThan(300);
    } finally {
      capture.close();
    }
  }, 20_000);
});
