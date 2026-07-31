import { BoundingBox, VehicleClass, VehicleDetection } from '../types/analysis';

/** A vehicle detection annotated with a stable id, unique to a single vehicle instance across consecutive ticks for one camera. */
export interface TrackedVehicleDetection extends VehicleDetection {
  trackId: number;
}

export interface VehicleTrackerOptions {
  /** Minimum IoU between a detection and a track's last-known box to be considered the same vehicle. Defaults to 0.3. */
  iouThreshold?: number;
  /** How many consecutive ticks a track may go unmatched before being forgotten. Defaults to 2. */
  maxMissedTicks?: number;
}

interface Track {
  box: BoundingBox;
  vehicleClass: VehicleClass;
  missedTicks: number;
}

const DEFAULT_IOU_THRESHOLD = 0.3;
const DEFAULT_MAX_MISSED_TICKS = 2;

/**
 * VehicleTracker assigns a stable numeric id to each vehicle across
 * consecutive detection ticks for the same camera, by greedily matching
 * each tick's detections to the previous tick's tracked boxes (same
 * vehicle class + sufficient IoU overlap, highest-overlap match wins).
 * This lets the frontend render a consistent color per vehicle instance
 * - and follow individual vehicles across frames - rather than every
 * detection looking like a brand new, unrelated box each tick.
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
  private readonly tracks = new Map<number, Track>();
  private nextId = 1;

  constructor(options: VehicleTrackerOptions = {}) {
    this.iouThreshold = options.iouThreshold ?? DEFAULT_IOU_THRESHOLD;
    this.maxMissedTicks = options.maxMissedTicks ?? DEFAULT_MAX_MISSED_TICKS;
  }

  /** Matches this tick's detections against known tracks and returns them annotated with a stable `trackId`. */
  update(detections: VehicleDetection[]): TrackedVehicleDetection[] {
    const candidateMatches: Array<{ trackId: number; detectionIndex: number; iou: number }> = [];
    for (const [trackId, track] of this.tracks) {
      detections.forEach((detection, detectionIndex) => {
        if (detection.class !== track.vehicleClass) return;
        const overlap = iou(track.box, detection.box);
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
      const trackId = detectionTrackIds.get(detectionIndex) ?? this.nextId++;
      this.tracks.set(trackId, { box: detection.box, vehicleClass: detection.class, missedTicks: 0 });
      // A brand new track is "seen" this tick too - it must not be aged below alongside truly unmatched tracks.
      matchedTrackIds.add(trackId);
      return { ...detection, trackId };
    });

    for (const [trackId, track] of this.tracks) {
      if (matchedTrackIds.has(trackId)) continue;
      track.missedTicks += 1;
      if (track.missedTicks > this.maxMissedTicks) {
        this.tracks.delete(trackId);
      }
    }

    return results;
  }
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
