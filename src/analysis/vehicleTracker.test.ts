import { VehicleTracker } from './vehicleTracker';
import { VehicleDetection } from '../types/analysis';

function makeDetection(overrides: Partial<VehicleDetection> = {}): VehicleDetection {
  return { class: 'vehicle', confidence: 0.9, box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 }, ...overrides };
}

describe('VehicleTracker', () => {
  it('assigns a new incrementing id to each detection the first time it is seen', () => {
    const tracker = new VehicleTracker();

    const results = tracker.update([makeDetection({ box: { x: 0, y: 0, width: 0.1, height: 0.1 } }), makeDetection({ box: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } })]);

    expect(results.map((r) => r.trackId)).toEqual([1, 2]);
  });

  it('keeps the same id for a detection that moves slightly (overlapping box) across ticks', () => {
    const tracker = new VehicleTracker();
    const [first] = tracker.update([makeDetection({ box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } })]);

    const [second] = tracker.update([makeDetection({ box: { x: 0.12, y: 0.1, width: 0.1, height: 0.1 } })]);

    expect(second.trackId).toBe(first.trackId);
  });

  it('smooths a matched track toward the new detection instead of snapping straight to it', () => {
    const tracker = new VehicleTracker();
    const [first] = tracker.update([makeDetection({ box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } })]);

    const [second] = tracker.update([makeDetection({ box: { x: 0.13, y: 0.1, width: 0.1, height: 0.1 } })]);

    expect(second.trackId).toBe(first.trackId);
    // Default positionSmoothing (0.6) blends 60% of the way from the
    // (stationary, since velocity starts at 0) predicted position toward
    // the raw detection - the reported box lands between the two rather
    // than snapping straight to the noisy per-frame blob.
    expect(second.box.x).toBeCloseTo(0.118, 5);
    expect(second.box.x).not.toBeCloseTo(0.13, 5);
  });

  it('predicts a steadily moving track forward so it keeps its id even after a missed detection', () => {
    const tracker = new VehicleTracker({ maxMissedTicks: 2 });
    // Establish a steady rightward velocity over a few consecutive matches.
    tracker.update([makeDetection({ box: { x: 0, y: 0.1, width: 0.2, height: 0.2 } })]);
    tracker.update([makeDetection({ box: { x: 0.06, y: 0.1, width: 0.2, height: 0.2 } })]);
    const [third] = tracker.update([makeDetection({ box: { x: 0.12, y: 0.1, width: 0.2, height: 0.2 } })]);

    tracker.update([]); // missed tick - the vehicle keeps moving off-camera-detector, box extrapolates forward instead of freezing.

    // Reappears further along the same trajectory than its last confirmed
    // box - matching still succeeds because the track's predicted position
    // advanced during the miss instead of staying put.
    const [reappeared] = tracker.update([makeDetection({ box: { x: 0.24, y: 0.1, width: 0.2, height: 0.2 } })]);

    expect(reappeared.trackId).toBe(third.trackId);
  });

  it('assigns a different id to a detection that does not sufficiently overlap the previous tick', () => {
    const tracker = new VehicleTracker();
    const [first] = tracker.update([makeDetection({ box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } })]);

    const [second] = tracker.update([makeDetection({ box: { x: 0.8, y: 0.8, width: 0.1, height: 0.1 } })]);

    expect(second.trackId).not.toBe(first.trackId);
  });

  it('never returns unmatched tracks - a tick with no detections returns an empty array', () => {
    const tracker = new VehicleTracker();
    tracker.update([makeDetection()]);

    const results = tracker.update([]);

    expect(results).toEqual([]);
  });

  it('keeps a track alive (same id on reappearance) across a brief gap within maxMissedTicks', () => {
    const tracker = new VehicleTracker({ maxMissedTicks: 2 });
    const box = { x: 0.1, y: 0.1, width: 0.1, height: 0.1 };
    const [first] = tracker.update([makeDetection({ box })]);

    tracker.update([]); // missed tick 1
    tracker.update([]); // missed tick 2 (at the limit, not yet forgotten)
    const [reappeared] = tracker.update([makeDetection({ box })]);

    expect(reappeared.trackId).toBe(first.trackId);
  });

  it('forgets a track once it exceeds maxMissedTicks, assigning a new id even at the same position', () => {
    const tracker = new VehicleTracker({ maxMissedTicks: 1 });
    const box = { x: 0.1, y: 0.1, width: 0.1, height: 0.1 };
    const [first] = tracker.update([makeDetection({ box })]);

    tracker.update([]); // missed tick 1 (at the limit)
    tracker.update([]); // missed tick 2 (exceeds limit -> forgotten)
    const [reappeared] = tracker.update([makeDetection({ box })]);

    expect(reappeared.trackId).not.toBe(first.trackId);
  });

  it('assigns distinct ids to two simultaneously detected vehicles of the same class in the same tick', () => {
    const tracker = new VehicleTracker();

    const results = tracker.update([
      makeDetection({ box: { x: 0, y: 0, width: 0.1, height: 0.1 } }),
      makeDetection({ box: { x: 0.3, y: 0.3, width: 0.1, height: 0.1 } }),
    ]);

    expect(new Set(results.map((r) => r.trackId)).size).toBe(2);
  });
});
