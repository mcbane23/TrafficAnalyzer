import { LumaExtractor, OccupancyEstimator } from './occupancyEstimator';

const W = 20;
const H = 10;
const N = W * H;

/** A synthetic scene generator: pixels are driven directly, no image decoding involved. */
function makeExtractor(): { extractor: LumaExtractor; setFrame: (pixels: Uint8Array) => void } {
  let current: Uint8Array = new Uint8Array(N).fill(100);
  return {
    extractor: async () => current,
    setFrame: (pixels: Uint8Array) => {
      current = pixels;
    },
  };
}

/** An empty road: uniform mid-grey. */
function emptyScene(): Uint8Array {
  return new Uint8Array(N).fill(100);
}

/** The same road with `count` of its first pixels covered by something bright. */
function sceneWithCoverage(count: number): Uint8Array {
  const f = emptyScene();
  for (let i = 0; i < count; i++) f[i] = 240;
  return f;
}

function makeEstimator(extractor: LumaExtractor, overrides = {}) {
  return new OccupancyEstimator({
    width: W,
    height: H,
    warmupFrames: 5,
    learningRate: 0.02,
    lumaExtractor: extractor,
    ...overrides,
  });
}

const FRAME = Buffer.from('unused - the extractor is injected');

describe('OccupancyEstimator', () => {
  it('reports no estimate until it has warmed up', async () => {
    const { extractor } = makeExtractor();
    const est = makeEstimator(extractor);

    for (let i = 0; i < 5; i++) {
      const r = await est.update(FRAME);
      expect(r.occupancy).toBeNull();
    }
  });

  it('reports near-zero occupancy for a road that is consistently empty', async () => {
    const { extractor } = makeExtractor();
    const est = makeEstimator(extractor);

    let last = await est.update(FRAME);
    for (let i = 0; i < 30; i++) last = await est.update(FRAME);

    // Nothing ever moves, so no pixel qualifies as roadway and there is
    // nothing meaningful to report - which is correct, not a failure.
    expect(last.occupancy === null || last.occupancy < 0.05).toBe(true);
  });

  it('rises as more of the learned roadway is covered', async () => {
    const { extractor, setFrame } = makeExtractor();
    const est = makeEstimator(extractor);

    // Teach it a roadway: a band of pixels that is occasionally covered, the
    // way a real road is mostly empty with vehicles passing through.
    // Settle on the empty road first, then show traffic passing over it.
    for (let i = 0; i < 8; i++) await est.update(FRAME);
    for (let i = 0; i < 40; i++) {
      setFrame(i % 4 === 0 ? sceneWithCoverage(40) : emptyScene());
      await est.update(FRAME);
    }

    setFrame(sceneWithCoverage(10));
    const light = await est.update(FRAME);
    setFrame(sceneWithCoverage(40));
    const heavy = await est.update(FRAME);

    expect(light.occupancy).not.toBeNull();
    expect(heavy.occupancy).not.toBeNull();
    expect(heavy.occupancy!).toBeGreaterThan(light.occupancy!);
  });

  it('excludes perpetually-changing pixels such as water or foliage', async () => {
    const { extractor, setFrame } = makeExtractor();
    const est = makeEstimator(extractor, { maxActivityRate: 0.5 });

    // First half of the frame flickers every single frame (a river); the rest
    // is static. Nothing here is roadway, so nothing should qualify.
    for (let i = 0; i < 40; i++) {
      const f = emptyScene();
      for (let p = 0; p < N / 2; p++) f[p] = i % 2 === 0 ? 20 : 230;
      setFrame(f);
      await est.update(FRAME);
    }

    const r = await est.update(FRAME);
    // The flickering region is above maxActivityRate and therefore ignored;
    // with no qualifying pixels the estimator declines to guess.
    expect(r.occupancy === null || r.occupancy < 0.2).toBe(true);
  });

  it('lets a stopped vehicle fade into the background rather than reporting it forever', async () => {
    const { extractor, setFrame } = makeExtractor();
    // A brisk foreground rate keeps the test short; production uses a tenth of
    // the background rate, so this takes minutes of footage rather than frames.
    const est = makeEstimator(extractor, { learningRate: 0.2, foregroundLearningRate: 0.1 });

    // Settle on the empty road first, then show traffic passing over it.
    for (let i = 0; i < 8; i++) await est.update(FRAME);
    for (let i = 0; i < 40; i++) {
      setFrame(i % 4 === 0 ? sceneWithCoverage(40) : emptyScene());
      await est.update(FRAME);
    }

    setFrame(sceneWithCoverage(40));
    const whenItArrives = await est.update(FRAME);
    for (let i = 0; i < 60; i++) await est.update(FRAME);
    const afterItSettles = await est.update(FRAME);

    expect(whenItArrives.occupancy).not.toBeNull();
    expect(afterItSettles.occupancy!).toBeLessThan(whenItArrives.occupancy!);
  });

  it('rejects a luma plane smaller than the configured working size', async () => {
    const est = makeEstimator(async () => new Uint8Array(4));

    await expect(est.update(FRAME)).rejects.toThrow(/luma samples/);
  });
});
