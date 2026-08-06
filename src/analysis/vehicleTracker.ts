import { BoundingBox, VehicleDetection } from '../types/analysis';

/** A vehicle detection annotated with a stable id, unique to a single vehicle instance across consecutive ticks for one camera. */
export interface TrackedVehicleDetection extends VehicleDetection {
  trackId: number;
}

export interface VehicleTrackerOptions {
  /** Minimum IoU between a detection and a track's predicted box to be considered the same vehicle. Defaults to 0.3. */
  iouThreshold?: number;
  /** How many consecutive ticks a track may go unmatched before being forgotten. Defaults to 2. */
  maxMissedTicks?: number;
  /**
   * Weight (0-1) given to a tick's raw detection position versus the
   * track's motion-predicted position when settling on the box reported to
   * clients. Defaults to 0.6.
   *
   * `MotionDetector`'s per-frame blob is noisy - glare, compression
   * artifacts and partial occlusion all nudge a real vehicle's silhouette a
   * few pixels every frame even when its actual motion is smooth - and
   * reporting that raw box straight through is what made boxes look like
   * they were jumping around rather than following the vehicle. Blending
   * it against the predicted position damps that per-frame noise. Kept
   * below 1 (full trust in the raw detection) so genuine direction/speed
   * changes still show up quickly rather than lagging behind, and above 0
   * (full trust in the prediction, which would never correct itself).
   */
  positionSmoothing?: number;
  /** Weight (0-1) given to a tick's raw detected size versus the track's last reported size. Defaults to 0.5 - a vehicle's on-screen size changes slowly, so this can lean more conservative than `positionSmoothing` without adding perceptible lag. */
  sizeSmoothing?: number;
  /**
   * Weight (0-1) given to a tick's newly observed velocity (this tick's
   * smoothed position minus last tick's) versus the track's previously
   * held velocity. Defaults to 0.5. This is what lets a track's motion
   * prediction actually track acceleration/turns instead of assuming
   * whatever direction the vehicle first appeared to be moving in forever.
   */
  velocitySmoothing?: number;
}

interface Track {
  /** Last reported (already smoothed) box. */
  box: BoundingBox;
  /** Per-tick position velocity, in the same normalized units as `box`. */
  velocity: { x: number; y: number };
  missedTicks: number;
}

const DEFAULT_IOU_THRESHOLD = 0.3;
const DEFAULT_MAX_MISSED_TICKS = 2;
const DEFAULT_POSITION_SMOOTHING = 0.6;
const DEFAULT_SIZE_SMOOTHING = 0.5;
const DEFAULT_VELOCITY_SMOOTHING = 0.5;

/**
 * VehicleTracker assigns a stable numeric id to each vehicle across
 * consecutive detection ticks for the same camera, by greedily matching
 * each tick's detections to where a previous tick's tracked vehicles are
 * now predicted to be (sufficient IoU overlap, highest-overlap match
 * wins). This lets the frontend render a consistent color per vehicle
 * instance - and follow individual vehicles across frames - rather than
 * every detection looking like a brand new, unrelated box each tick.
 *
 * Two refinements beyond plain frame-to-frame IoU matching, both aimed at
 * the same problem: `MotionDetector`'s raw per-frame blob is a noisy
 * silhouette, not a stable object outline, so matching and reporting
 * straight off it makes tracked vehicles look like they're jittering
 * around rather than moving smoothly:
 *
 * - Motion prediction: each track carries a velocity (its last observed
 *   per-tick position delta), and matching is done against *where the
 *   track should be now* (last box + velocity), not where it last was.
 *   This is what keeps a fast-moving vehicle's id stable tick to tick -
 *   without it, a vehicle that moved far enough between ticks would fall
 *   below the IoU threshold against its own stale last-known box and get
 *   treated as a brand new one. It also keeps an unmatched-but-not-yet-
 *   forgotten track advancing along its trajectory while missed, so it's
 *   still findable if it reappears a tick or two later.
 * - Smoothing: the box reported for a matched track blends the predicted
 *   position with the new raw detection (see `positionSmoothing`) rather
 *   than replacing it outright, damping frame-to-frame blob noise while
 *   still following genuine movement closely.
 *
 * A track that isn't matched by any detection in a tick is aged (not
 * immediately discarded) so a vehicle briefly missed by the detector for
 * a frame or two keeps its id when it reappears. But - critically - an
 * unmatched track is NEVER included in `update()`'s return value: only
 * detections actually present in the current tick are emitted, so a
 * vehicle that has genuinely left the frame stops being drawn
 * immediately rather than leaving a stale bounding box stuck on-screen.
 * Once a track exceeds `maxMissedTicks` consecutive misses it's
 * forgotten entirely, so its id (and last-known position) isn't reused
 * for whatever unrelated vehicle happens to occupy a similar spot later.
 *
 * One instance should be created per camera - tracking is meaningless
 * across different cameras' independent frames.
 */
export class VehicleTracker {
  private readonly iouThreshold: number;
  private readonly maxMissedTicks: number;
  private readonly positionSmoothing: number;
  private readonly sizeSmoothing: number;
  private readonly velocitySmoothing: number;
  private readonly tracks = new Map<number, Track>();
  private nextId = 1;

  constructor(options: VehicleTrackerOptions = {}) {
    this.iouThreshold = options.iouThreshold ?? DEFAULT_IOU_THRESHOLD;
    this.maxMissedTicks = options.maxMissedTicks ?? DEFAULT_MAX_MISSED_TICKS;
    this.positionSmoothing = options.positionSmoothing ?? DEFAULT_POSITION_SMOOTHING;
    this.sizeSmoothing = options.sizeSmoothing ?? DEFAULT_SIZE_SMOOTHING;
    this.velocitySmoothing = options.velocitySmoothing ?? DEFAULT_VELOCITY_SMOOTHING;
  }

  /** Matches this tick's detections against known tracks and returns them annotated with a stable `trackId`. */
  update(detections: VehicleDetection[]): TrackedVehicleDetection[] {
    // Predict each track's current position before matching, so a vehicle
    // that moved between ticks is matched against where it's likely to be
    // now, not where it was last seen.
    const predictedBoxes = new Map<number, BoundingBox>();
    for (const [trackId, track] of this.tracks) {
      predictedBoxes.set(trackId, {
        x: track.box.x + track.velocity.x,
        y: track.box.y + track.velocity.y,
        width: track.box.width,
        height: track.box.height,
      });
    }

    const candidateMatches: Array<{ trackId: number; detectionIndex: number; iou: number }> = [];
    for (const [trackId, predictedBox] of predictedBoxes) {
      detections.forEach((detection, detectionIndex) => {
        const overlap = iou(predictedBox, detection.box);
        if (overlap >= this.iouThreshold) {
          candidateMatches.push({ trackId, detectionIndex, iou: overlap });
        }
      });
    }
    // Highest-overlap matches win first, so the best pairing is claimed before weaker ones.
    candidateMatches.sort((a, b) => b.iou - a.iou);

    const matchedTrackIds = new Set<number>();
    const detectionTrackIds = new Map<number, number>();

    for (const match of candidateMatches) {
      if (matchedTrackIds.has(match.trackId) || detectionTrackIds.has(match.detectionIndex)) continue;
      matchedTrackIds.add(match.trackId);
      detectionTrackIds.set(match.detectionIndex, match.trackId);
    }

    const results: TrackedVehicleDetection[] = detections.map((detection, detectionIndex) => {
      const existingTrackId = detectionTrackIds.get(detectionIndex);
      if (existingTrackId !== undefined) {
        const existing = this.tracks.get(existingTrackId)!;
        const predictedBox = predictedBoxes.get(existingTrackId)!;
        const box: BoundingBox = {
          x: lerp(predictedBox.x, detection.box.x, this.positionSmoothing),
          y: lerp(predictedBox.y, detection.box.y, this.positionSmoothing),
          width: lerp(existing.box.width, detection.box.width, this.sizeSmoothing),
          height: lerp(existing.box.height, detection.box.height, this.sizeSmoothing),
        };
        const velocity = {
          x: lerp(existing.velocity.x, box.x - existing.box.x, this.velocitySmoothing),
          y: lerp(existing.velocity.y, box.y - existing.box.y, this.velocitySmoothing),
        };
        this.tracks.set(existingTrackId, { box, velocity, missedTicks: 0 });
        matchedTrackIds.add(existingTrackId);
        return { ...detection, trackId: existingTrackId, box };
      }

      // A brand new vehicle - nothing to predict from or smooth against yet,
      // so it's reported exactly as detected and starts with zero velocity.
      const trackId = this.nextId++;
      this.tracks.set(trackId, { box: detection.box, velocity: { x: 0, y: 0 }, missedTicks: 0 });
      matchedTrackIds.add(trackId);
      return { ...detection, trackId };
    });

    for (const [trackId, track] of this.tracks) {
      if (matchedTrackIds.has(trackId)) continue;
      track.missedTicks += 1;
      if (track.missedTicks > this.maxMissedTicks) {
        this.tracks.delete(trackId);
      } else {
        // Keep an unmatched-but-not-yet-forgotten track advancing along its
        // last known trajectory, so if it reappears a tick or two later (a
        // brief occlusion, a missed detection) it's matched against where
        // it actually is now rather than where it went missing.
        track.box = { ...track.box, x: track.box.x + track.velocity.x, y: track.box.y + track.velocity.y };
      }
    }

    return results;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function iou(a: BoundingBox, b: BoundingBox): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(ax2, bx2);
  const y2 = Math.min(ay2, by2);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - intersection;
  return union <= 0 ? 0 : intersection / union;
}
