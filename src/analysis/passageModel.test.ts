import { FinishedTrack } from '../types/analysis';
import { CameraPassageModel, DirectionModel, SizeClassifier } from './passageModel';

function track(id: number, from: [number, number], to: [number, number], size = 0.05): FinishedTrack {
  const box = ([x, y]: [number, number]) => ({ x: x - size / 2, y: y - size / 2, width: size, height: size });
  return {
    trackId: id,
    firstSeen: '2026-10-20T08:00:00.000Z',
    lastSeen: '2026-10-20T08:00:05.000Z',
    firstBox: box(from),
    lastBox: box(to),
    hits: 10,
  };
}

describe('DirectionModel', () => {
  it('labels the first passages by their own heading, A pointing down the frame', () => {
    const model = new DirectionModel();
    expect(model.classify(0.02, 0.4)).toBe('A');
    expect(model.classify(-0.01, -0.3)).toBe('B');
    expect(model.axis()).toBeNull();
  });

  it('labels left-to-right as A on a near-horizontal road', () => {
    const model = new DirectionModel();
    expect(model.classify(0.5, 0.02)).toBe('A');
    expect(model.classify(-0.5, 0.05)).toBe('B');
  });

  it('learns the dominant axis of a diagonal road from both directions of traffic', () => {
    const model = new DirectionModel({ minSamples: 4 });
    for (let i = 0; i < 4; i++) {
      model.classify(0.3, 0.3);
      model.classify(-0.3, -0.3);
    }
    const axis = model.axis()!;
    expect(axis.x).toBeCloseTo(Math.SQRT1_2, 3);
    expect(axis.y).toBeCloseTo(Math.SQRT1_2, 3);
    // A vehicle drifting mostly sideways is still labelled by its movement along the road.
    expect(model.classify(0.25, 0.1)).toBe('A');
    expect(model.classify(-0.1, -0.25)).toBe('B');
  });

  it('gives no direction to a vehicle that barely moved along the road', () => {
    const model = new DirectionModel({ minSamples: 2 });
    model.classify(0, 0.5);
    model.classify(0, -0.5);
    // Moves across the road axis, not along it.
    expect(model.classify(0.3, 0.01)).toBeNull();
    expect(model.classify(0.01, 0.01)).toBeNull();
  });

  it('keeps its labels after a restart when seeded with persisted moments', () => {
    const original = new DirectionModel({ minSamples: 2 });
    original.classify(0, 0.4);
    original.classify(0, -0.4);
    const restored = new DirectionModel({ minSamples: 2 });
    restored.seed({ sxx: 0, syy: 0.32, sxy: 0, n: 2 });
    expect(restored.axis()).toEqual(original.axis());
  });
});

describe('SizeClassifier', () => {
  it('uses an absolute area threshold while a band is still learning', () => {
    const classifier = new SizeClassifier({ minSamples: 10, absoluteLargeArea: 0.06 });
    expect(classifier.classify({ x: 0.1, y: 0.1, width: 0.1, height: 0.1 })).toBe('car');
    expect(classifier.classify({ x: 0.1, y: 0.1, width: 0.3, height: 0.3 })).toBe('large');
  });

  it('compares a vehicle with others at the same height in the frame', () => {
    const classifier = new SizeClassifier({ bands: 2, minSamples: 5, largeRatio: 2.5 });
    // Far band (top): small cars. Near band (bottom): big cars.
    for (let i = 0; i < 5; i++) {
      classifier.classify({ x: 0, y: 0.1, width: 0.04, height: 0.04 });
      classifier.classify({ x: 0, y: 0.7, width: 0.15, height: 0.15 });
    }
    // A bus far away is smaller than a car up close, but large for its band.
    expect(classifier.classify({ x: 0, y: 0.1, width: 0.08, height: 0.08 })).toBe('large');
    expect(classifier.classify({ x: 0, y: 0.7, width: 0.16, height: 0.16 })).toBe('car');
  });
});

describe('CameraPassageModel', () => {
  it('turns a finished track into a passage with displacement, direction and size class', () => {
    const model = new CameraPassageModel('cam-1');
    const passage = model.toPassage(track(7, [0.5, 0.2], [0.5, 0.8]));
    expect(passage).toMatchObject({
      cameraId: 'cam-1',
      trackId: 7,
      firstSeen: '2026-10-20T08:00:00.000Z',
      lastSeen: '2026-10-20T08:00:05.000Z',
      direction: 'A',
      sizeClass: 'car',
    });
    expect(passage.dx).toBeCloseTo(0);
    expect(passage.dy).toBeCloseTo(0.6);
  });
});
