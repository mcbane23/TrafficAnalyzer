import { BackgroundModel, LumaExtractor } from './backgroundModel';
import { VideoFrame } from './videoFrame';

const W = 20;
const H = 10;
const N = W * H;
const WARMUP = 5;
// Never read - the extractor is injected.
const FRAME: VideoFrame = { width: 0, height: 0, data: new Uint8Array(0) };

/** A synthetic scene generator: pixels are driven directly, no image decoding involved. */
function makeExtractor(): { extractor: LumaExtractor; setFrame: (pixels: Uint8Array) => void } {
  let current: Uint8Array = new Uint8Array(N).fill(100);
  return {
    extractor: () => current,
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
  const scene = emptyScene();
  for (let i = 0; i < count; i++) scene[i] = 240;
  return scene;
}

function makeModel(extractor: LumaExtractor, overrides = {}) {
  return new BackgroundModel({
    width: W,
    height: H,
    warmupFrames: WARMUP,
    learningRate: 0.02,
    lumaExtractor: extractor,
    ...overrides,
  });
}

/** Runs the model past warmup on an empty scene, leaving nothing marked as roadway yet. */
async function warmUp(model: BackgroundModel): Promise<void> {
  for (let i = 0; i <= WARMUP; i++) await model.observe(FRAME);
}

describe('BackgroundModel', () => {
  it('reports nothing until it has warmed up', async () => {
    const { extractor } = makeExtractor();
    const model = makeModel(extractor);

    for (let i = 0; i < WARMUP; i++) {
      const observation = await model.observe(FRAME);
      expect(observation.warming).toBe(true);
      expect(observation.foreground).toHaveLength(0);
      expect(observation.roadway).toHaveLength(0);
    }

    expect((await model.observe(FRAME)).warming).toBe(false);
  });

  it('seeds the background from the first frame rather than from zero', async () => {
    const { extractor, setFrame } = makeExtractor();
    const model = makeModel(extractor);
    // A bright scene throughout. Seeded from zero, every pixel would read as
    // foreground forever; seeded from the first frame, none does.
    setFrame(new Uint8Array(N).fill(240));

    await warmUp(model);
    const observation = await model.observe(FRAME);

    expect(Array.from(observation.foreground).some((v) => v === 1)).toBe(false);
  });

  it('marks pixels that differ from the learned background as foreground', async () => {
    const { extractor, setFrame } = makeExtractor();
    const model = makeModel(extractor);

    await warmUp(model);
    setFrame(sceneWithCoverage(30));
    const observation = await model.observe(FRAME);

    expect(observation.foreground.subarray(0, 30).every((v) => v === 1)).toBe(true);
    expect(observation.foreground.subarray(30).every((v) => v === 0)).toBe(true);
  });

  it('excludes never-active pixels from the roadway region', async () => {
    const { extractor, setFrame } = makeExtractor();
    const model = makeModel(extractor);

    await warmUp(model);
    // Only the first 30 pixels ever see anything; the rest are static scenery.
    for (let i = 0; i < 10; i++) {
      setFrame(sceneWithCoverage(30));
      await model.observe(FRAME);
      setFrame(emptyScene());
      await model.observe(FRAME);
    }

    const observation = await model.observe(FRAME);
    expect(observation.roadway.subarray(0, 30).every((v) => v === 1)).toBe(true);
    expect(observation.roadway.subarray(30).every((v) => v === 0)).toBe(true);
    expect(observation.roadwayPixels).toBe(30);
  });

  // A pixel that is foreground in almost every frame is a river or wind-blown
  // foliage, not a road - the upper bound of the band is what excludes it.
  it('excludes perpetually-active pixels from the roadway region', async () => {
    const { extractor, setFrame } = makeExtractor();
    const model = makeModel(extractor, { maxActivityRate: 0.5, foregroundLearningRate: 0 });

    await warmUp(model);
    // The first 30 pixels are covered in every single frame from here on.
    for (let i = 0; i < 20; i++) {
      setFrame(sceneWithCoverage(30));
      await model.observe(FRAME);
    }

    const observation = await model.observe(FRAME);
    expect(observation.roadway.subarray(0, 30).every((v) => v === 0)).toBe(true);
  });

  // The reason selective adaptation exists: at one rate everywhere, the
  // background settles between empty asphalt and vehicle on a busy road, both
  // then read as foreground, and the busiest roads drop out of the roadway
  // region first - exactly backwards.
  it('adapts far more slowly where something is present than where nothing is', async () => {
    const { extractor, setFrame } = makeExtractor();
    const slow = makeModel(extractor, { learningRate: 0.2, foregroundLearningRate: 0.001 });

    await warmUp(slow);
    // Hold something over the first 30 pixels for a long stretch.
    setFrame(sceneWithCoverage(30));
    for (let i = 0; i < 30; i++) await slow.observe(FRAME);

    // Still reported as present, rather than having been absorbed into the
    // background and gone quiet.
    const observation = await slow.observe(FRAME);
    expect(observation.foreground.subarray(0, 30).every((v) => v === 1)).toBe(true);
  });

  it('rejects a frame that yields fewer luma samples than the working resolution', () => {
    const model = makeModel(() => new Uint8Array(N - 1));

    expect(() => model.observe(FRAME)).toThrow(`Expected at least ${N} luma samples, got ${N - 1}`);
  });
});
