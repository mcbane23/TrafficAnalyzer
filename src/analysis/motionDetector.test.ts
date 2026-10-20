import { LumaExtractor, MotionDetector } from './motionDetector';
import { VideoFrame } from './videoFrame';

const W = 40;
const H = 20;
const N = W * H;
const BACKGROUND_VALUE = 100;
const OBJECT_VALUE = 240;

/** A synthetic scene generator: pixels are driven directly, no image decoding involved. */
function makeExtractor(): { extractor: LumaExtractor; setFrame: (pixels: Uint8Array) => void } {
  let current: Uint8Array = new Uint8Array(N).fill(BACKGROUND_VALUE);
  return {
    extractor: () => current,
    setFrame: (pixels: Uint8Array) => {
      current = pixels;
    },
  };
}

function emptyScene(): Uint8Array {
  return new Uint8Array(N).fill(BACKGROUND_VALUE);
}

/** An empty scene with one bright rectangle painted at (x, y, w, h) - stands in for a vehicle. */
function sceneWithRect(x: number, y: number, w: number, h: number, value = OBJECT_VALUE): Uint8Array {
  const f = emptyScene();
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      f[row * W + col] = value;
    }
  }
  return f;
}

function makeDetector(extractor: LumaExtractor, overrides = {}) {
  return new MotionDetector({
    width: W,
    height: H,
    warmupFrames: 5,
    learningRate: 0.2,
    lumaExtractor: extractor,
    ...overrides,
  });
}

/**
 * Runs a few empty ticks past `warmupFrames` (5) before any activity
 * starts. Margin matters, not just the count: the "warming" flag used to
 * pick the background's adaptation rate is read *before* the sample
 * counter for this same tick is incremented, so a tick landing exactly on
 * the warmup boundary still updates at the fast rate. If that tick is also
 * the very first time a pixel goes foreground, the background jumps most
 * of the way there in one step and then, being foreground, is stuck
 * correcting back down only at the slow foreground rate - never
 * re-settling. A few extra empty ticks of margin (matching
 * OccupancyEstimator's own tests) ensures warmup has unambiguously ended
 * before the first real activity, so that first jump uses the slow rate
 * like every other foreground tick.
 */
async function warmUp(detector: MotionDetector) {
  for (let i = 0; i < 8; i++) (await detector.detect(FRAME)).detections;
}

/** Runs `ticks` calls alternating a "vehicle present" scene (every 4th tick) with an empty one, teaching the region a recurring roadway-like activity pattern - the same prerequisite OccupancyEstimator's own tests rely on for the identical gating logic. */
async function teachRoadway(detector: MotionDetector, setFrame: (pixels: Uint8Array) => void, activeScene: () => Uint8Array, ticks = 20) {
  for (let i = 0; i < ticks; i++) {
    setFrame(i % 4 === 0 ? activeScene() : emptyScene());
    (await detector.detect(FRAME)).detections;
  }
}

// Never read - the extractor is injected.
const FRAME: VideoFrame = { width: 0, height: 0, data: new Uint8Array(0) };

describe('MotionDetector', () => {
  it('suppresses detections until warmupFrames have been observed, even if something is already moving', async () => {
    const { extractor, setFrame } = makeExtractor();
    const detector = makeDetector(extractor);

    setFrame(emptyScene());
    (await detector.detect(FRAME)).detections; // seeds the background model

    setFrame(sceneWithRect(10, 5, 6, 6));
    for (let i = 0; i < 4; i++) {
      expect(await detector.detect(FRAME)).toEqual({ detections: [], warmingUp: true });
    }
  });

  it('detects a moving object and boxes it roughly where it is', async () => {
    const { extractor, setFrame } = makeExtractor();
    const detector = makeDetector(extractor);

    await warmUp(detector);
    await teachRoadway(detector, setFrame, () => sceneWithRect(10, 5, 6, 6));

    setFrame(sceneWithRect(10, 5, 6, 6));
    const { detections: result, warmingUp } = await detector.detect(FRAME);

    expect(warmingUp).toBe(false);
    expect(result).toHaveLength(1);
    expect(result[0].class).toBe('vehicle');
    expect(result[0].box.x).toBeCloseTo(10 / W, 1);
    expect(result[0].box.y).toBeCloseTo(5 / H, 1);
    expect(result[0].box.width).toBeCloseTo(6 / W, 1);
    expect(result[0].box.height).toBeCloseTo(6 / H, 1);
  });

  it('ignores noise smaller than the minimum blob area', async () => {
    const { extractor, setFrame } = makeExtractor();
    const detector = makeDetector(extractor, { minBlobAreaRatio: 0.01 }); // 0.01 * 800px = 8px

    await warmUp(detector);
    await teachRoadway(detector, setFrame, () => sceneWithRect(10, 5, 1, 1));

    setFrame(sceneWithRect(10, 5, 1, 1));
    expect((await detector.detect(FRAME)).detections).toEqual([]);
  });

  it('ignores a frame-wide brightness shift as implausibly large to be a vehicle', async () => {
    const { extractor, setFrame } = makeExtractor();
    const detector = makeDetector(extractor, { maxBlobAreaRatio: 0.5 });

    await warmUp(detector);
    await teachRoadway(detector, setFrame, () => new Uint8Array(N).fill(OBJECT_VALUE));

    setFrame(new Uint8Array(N).fill(OBJECT_VALUE));
    expect((await detector.detect(FRAME)).detections).toEqual([]);
  });

  it('excludes perpetually-changing pixels such as water or foliage', async () => {
    const { extractor, setFrame } = makeExtractor();
    const detector = makeDetector(extractor, { maxActivityRate: 0.5 });

    // Half the frame flickers every single tick (a river); nothing here is
    // roadway, so nothing should be reported no matter how "in motion" it is.
    for (let i = 0; i < 40; i++) {
      const f = emptyScene();
      for (let p = 0; p < N / 2; p++) f[p] = i % 2 === 0 ? 20 : 230;
      setFrame(f);
      (await detector.detect(FRAME)).detections;
    }

    expect((await detector.detect(FRAME)).detections).toEqual([]);
  });

  it('keeps reporting a vehicle for a while after it stops moving', async () => {
    const { extractor, setFrame } = makeExtractor();
    const detector = makeDetector(extractor, { foregroundLearningRate: 0.005 });

    await warmUp(detector);
    await teachRoadway(detector, setFrame, () => sceneWithRect(10, 5, 6, 6));

    setFrame(sceneWithRect(10, 5, 6, 6));
    const whenItStops = (await detector.detect(FRAME)).detections;
    // Several more ticks with the vehicle motionless in the same spot -
    // still reported, unlike frame-differencing which would drop it the
    // instant it stopped moving.
    let stillThere;
    for (let i = 0; i < 15; i++) stillThere = (await detector.detect(FRAME)).detections;

    expect(whenItStops).toHaveLength(1);
    expect(stillThere).toHaveLength(1);
  });

  it('eventually lets a permanently-stationary object fade out rather than counting it forever', async () => {
    const { extractor, setFrame } = makeExtractor();
    // A brisk foreground rate keeps the test short - production uses a much
    // slower one so a real stop lasts a full light cycle, not a few ticks.
    const detector = makeDetector(extractor, { foregroundLearningRate: 0.3 });

    await warmUp(detector);
    await teachRoadway(detector, setFrame, () => sceneWithRect(10, 5, 6, 6));

    setFrame(sceneWithRect(10, 5, 6, 6));
    let last: unknown;
    for (let i = 0; i < 60; i++) last = (await detector.detect(FRAME)).detections;

    expect(last).toEqual([]);
  });

  it('reports two well-separated moving objects as two distinct boxes', async () => {
    const { extractor, setFrame } = makeExtractor();
    const detector = makeDetector(extractor);
    const twoRects = () => {
      const f = sceneWithRect(2, 5, 6, 6);
      for (let row = 5; row < 11; row++) {
        for (let col = 30; col < 36; col++) f[row * W + col] = OBJECT_VALUE;
      }
      return f;
    };

    await warmUp(detector);
    await teachRoadway(detector, setFrame, twoRects);

    setFrame(twoRects());
    const result = (await detector.detect(FRAME)).detections;

    expect(result).toHaveLength(2);
  });

  it('rejects a luma plane smaller than the configured working size', async () => {
    const detector = makeDetector(() => new Uint8Array(4));

    await expect(detector.detect(FRAME)).rejects.toThrow(/luma samples/);
  });
});
