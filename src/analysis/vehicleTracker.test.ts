import { VehicleTracker } from './vehicleTracker';
import { BoundingBox, VehicleDetection } from '../types/analysis';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function det(box: Partial<BoundingBox> = {}, confidence = 0.9): VehicleDetection {
  return { class: 'vehicle', confidence, box: { x: 0.1, y: 0.1, width: 0.05, height: 0.05, ...box } };
}

/** Feeds `frames` (one detection list per frame) at a fixed interval, returning every update. */
function run(tracker: VehicleTracker, frames: VehicleDetection[][], intervalMs = 200, startMs = T0) {
  return frames.map((detections, i) => tracker.update(detections, startMs + i * intervalMs));
}

/** One vehicle moving at constant velocity, in normalized units per frame. */
function movingVehicle(frames: number, start: { x: number; y: number }, step: { x: number; y: number }, size = 0.05): VehicleDetection[][] {
  return Array.from({ length: frames }, (_, i) => [det({ x: start.x + step.x * i, y: start.y + step.y * i, width: size, height: size })]);
}

describe('VehicleTracker', () => {
  it('does not report a new track until it has been seen on minHits frames', () => {
    const tracker = new VehicleTracker({ minHits: 3 });
    const updates = run(tracker, movingVehicle(3, { x: 0.1, y: 0.5 }, { x: 0.01, y: 0 }));

    expect(updates[0].tracks).toEqual([]);
    expect(updates[1].tracks).toEqual([]);
    expect(updates[2].tracks).toHaveLength(1);
  });

  it('keeps one id for a vehicle moving steadily across the frame', () => {
    const tracker = new VehicleTracker();
    const updates = run(tracker, movingVehicle(20, { x: 0.05, y: 0.5 }, { x: 0.04, y: 0 }));

    const ids = new Set(updates.flatMap((u) => u.tracks.map((t) => t.trackId)));
    expect(ids.size).toBe(1);
  });

  it('keeps the id of a small vehicle that moves more than its own length per frame (zero box overlap)', () => {
    const tracker = new VehicleTracker();
    // 0.03-wide box moving 0.04 per frame: consecutive boxes never overlap.
    const updates = run(tracker, movingVehicle(15, { x: 0.05, y: 0.5 }, { x: 0.04, y: 0 }, 0.03));

    const ids = new Set(updates.flatMap((u) => u.tracks.map((t) => t.trackId)));
    expect(ids.size).toBe(1);
    expect(updates.slice(2).every((u) => u.tracks.length === 1)).toBe(true);
  });

  it('uses real elapsed time, so an uneven frame gap does not break the track', () => {
    const tracker = new VehicleTracker();
    // 0.2/s rightward. Frames at 0, 200, 400, 600ms, then a 1.4s gap, then normal again.
    const times = [0, 200, 400, 600, 2000, 2200, 2400];
    const updates = times.map((t) => tracker.update([det({ x: 0.1 + 0.2 * (t / 1000), y: 0.5 })], T0 + t));

    const ids = new Set(updates.flatMap((u) => u.tracks.map((t) => t.trackId)));
    expect(ids.size).toBe(1);
    expect(updates[4].tracks).toHaveLength(1);
  });

  it('coasts a confirmed track through a brief occlusion and keeps its id', () => {
    const tracker = new VehicleTracker({ maxLostMs: 1500 });
    const frames = movingVehicle(12, { x: 0.1, y: 0.5 }, { x: 0.03, y: 0 });
    frames[5] = [];
    frames[6] = [];
    const updates = run(tracker, frames);

    expect(updates[5].tracks).toEqual([]); // Never drawn while undetected.
    const ids = new Set(updates.flatMap((u) => u.tracks.map((t) => t.trackId)));
    expect(ids.size).toBe(1);
    expect(updates.flatMap((u) => u.finished)).toEqual([]);
  });

  it('finishes a confirmed track exactly once after it has been lost for longer than maxLostMs', () => {
    const tracker = new VehicleTracker({ maxLostMs: 1000 });
    const frames = [...movingVehicle(5, { x: 0.3, y: 0.5 }, { x: 0.01, y: 0 }), ...Array.from({ length: 10 }, () => [])];
    const updates = run(tracker, frames);

    const finished = updates.flatMap((u) => u.finished);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      trackId: 1,
      hits: 5,
      firstSeen: new Date(T0).toISOString(),
      lastSeen: new Date(T0 + 4 * 200).toISOString(),
    });
    expect(finished[0].firstBox.x).toBeCloseTo(0.3);
    expect(finished[0].lastBox.x).toBeCloseTo(0.34);
  });

  it('finishes a track as soon as it is predicted to have left the frame', () => {
    const tracker = new VehicleTracker({ maxLostMs: 10_000 });
    // Moving right fast, last seen near the right edge.
    const frames = [...movingVehicle(6, { x: 0.7, y: 0.5 }, { x: 0.05, y: 0 }), [], [], []];
    const updates = run(tracker, frames);

    expect(updates.flatMap((u) => u.finished)).toHaveLength(1);
  });

  it('never finishes (or reports) a tentative noise blob', () => {
    const tracker = new VehicleTracker({ minHits: 3 });
    const updates = run(tracker, [[det({ x: 0.5, y: 0.5 })], [], [det({ x: 0.2, y: 0.2 })], [], [], []]);

    expect(updates.flatMap((u) => u.tracks)).toEqual([]);
    expect(updates.flatMap((u) => u.finished)).toEqual([]);
  });

  it('keeps two vehicles passing side by side on separate ids', () => {
    const tracker = new VehicleTracker();
    const a = movingVehicle(15, { x: 0.05, y: 0.4 }, { x: 0.04, y: 0 });
    const b = movingVehicle(15, { x: 0.05, y: 0.48 }, { x: 0.04, y: 0 });
    const updates = run(
      tracker,
      a.map((frame, i) => [...frame, ...b[i]]),
    );

    const last = updates[updates.length - 1].tracks;
    expect(last).toHaveLength(2);
    const top = last.find((t) => t.box.y < 0.44)!;
    const bottom = last.find((t) => t.box.y >= 0.44)!;
    // Ids never swap between lanes over the run.
    for (const u of updates.slice(2)) {
      expect(u.tracks.find((t) => t.box.y < 0.44)?.trackId).toBe(top.trackId);
      expect(u.tracks.find((t) => t.box.y >= 0.44)?.trackId).toBe(bottom.trackId);
    }
  });

  it('keeps ids correct for two vehicles crossing in opposite directions', () => {
    const tracker = new VehicleTracker();
    const right = movingVehicle(16, { x: 0.1, y: 0.5 }, { x: 0.05, y: 0 }, 0.04);
    const left = movingVehicle(16, { x: 0.85, y: 0.53 }, { x: -0.05, y: 0 }, 0.04);
    const updates = run(
      tracker,
      right.map((frame, i) => [...frame, ...left[i]]),
    );

    const rightIds = new Set<number>();
    const leftIds = new Set<number>();
    updates.forEach((u, i) => {
      for (const t of u.tracks) {
        const expectedRightX = 0.1 + 0.05 * i;
        (Math.abs(t.box.x - expectedRightX) < Math.abs(t.box.x - (0.85 - 0.05 * i)) ? rightIds : leftIds).add(t.trackId);
      }
    });
    expect(rightIds.size).toBe(1);
    expect(leftIds.size).toBe(1);
    expect([...rightIds][0]).not.toBe([...leftIds][0]);
  });

  it('uses low-confidence detections to keep a confirmed track alive, but never to start one', () => {
    const tracker = new VehicleTracker({ highConfidence: 0.5, maxLostMs: 300 });
    const frames = movingVehicle(10, { x: 0.1, y: 0.5 }, { x: 0.03, y: 0 }).map((frame, i) =>
      i >= 4 ? frame.map((d) => ({ ...d, confidence: 0.3 })) : frame,
    );
    // A low-confidence blob elsewhere that would otherwise become a track.
    frames.forEach((frame) => frame.push(det({ x: 0.6, y: 0.1 }, 0.3)));
    const updates = run(tracker, frames);

    const ids = new Set(updates.flatMap((u) => u.tracks.map((t) => t.trackId)));
    expect(ids.size).toBe(1);
    expect(updates[9].tracks).toHaveLength(1);
  });

  it('finishes every track across a stream gap longer than maxFrameGapMs', () => {
    const tracker = new VehicleTracker({ maxFrameGapMs: 5000 });
    run(tracker, movingVehicle(4, { x: 0.3, y: 0.5 }, { x: 0.01, y: 0 }));

    const afterGap = tracker.update([det({ x: 0.34, y: 0.5 })], T0 + 60_000);

    expect(afterGap.finished.map((f) => f.trackId)).toEqual([1]);
    expect(afterGap.tracks).toEqual([]); // The new detection starts a fresh, tentative track.
  });

  it('flush() finishes all confirmed tracks', () => {
    const tracker = new VehicleTracker();
    run(tracker, [...movingVehicle(4, { x: 0.3, y: 0.5 }, { x: 0.01, y: 0 })]);

    expect(tracker.flush().map((f) => f.trackId)).toEqual([1]);
    expect(tracker.flush()).toEqual([]);
  });

  it('smooths the reported box rather than snapping to each noisy detection', () => {
    const tracker = new VehicleTracker({ minHits: 1 });
    const jitter = [0, 0.01, -0.01, 0.01, -0.01, 0.01, -0.01, 0.01];
    const updates = run(
      tracker,
      jitter.map((j) => [det({ x: 0.5 + j, y: 0.5 })]),
    );

    const reportedXs = updates.slice(3).map((u) => u.tracks[0].box.x);
    for (const x of reportedXs) expect(Math.abs(x - 0.5)).toBeLessThan(0.01);
  });
});
