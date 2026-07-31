import { VehicleTracker } from './vehicleTracker';
import { VehicleDetection } from '../types/analysis';

function makeDetection(overrides: Partial<VehicleDetection> = {}): VehicleDetection {
  return { class: 'car', confidence: 0.9, box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 }, ...overrides };
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

  it('assigns a different id to a detection that does not sufficiently overlap the previous tick', () => {
    const tracker = new VehicleTracker();
    const [first] = tracker.update([makeDetection({ box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } })]);

    const [second] = tracker.update([makeDetection({ box: { x: 0.8, y: 0.8, width: 0.1, height: 0.1 } })]);

    expect(second.trackId).not.toBe(first.trackId);
  });

  it('does not match tracks of a different vehicle class even with full overlap', () => {
    const tracker = new VehicleTracker();
    const box = { x: 0.1, y: 0.1, width: 0.1, height: 0.1 };
    const [first] = tracker.update([makeDetection({ class: 'car', box })]);

    const [second] = tracker.update([makeDetection({ class: 'truck', box })]);

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
