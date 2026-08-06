import { CameraAnalysisResult, TrafficLevel, VehicleDetection } from '../types/analysis';
import { MotionDetector } from './motionDetector';
import { OccupancyEstimator } from './occupancyEstimator';
import { VehicleTracker } from './vehicleTracker';

/** Narrow seam over MotionDetector so tests can inject canned detections without running real background-subtraction. */
export interface VehicleDetectorLike {
  detect(frameBuffer: Buffer): Promise<VehicleDetection[]>;
}

/** Narrow seam over OccupancyEstimator. */
export interface OccupancyEstimatorLike {
  update(frame: Buffer): Promise<{ occupancy: number | null }>;
}

/** Narrow seam over VehicleTracker. */
export interface VehicleTrackerLike {
  update(detections: VehicleDetection[]): VehicleDetection[];
}

export interface CameraAnalyzerOptions {
  /** Total vehicle count at/above which the traffic-level badge becomes "moderate". Defaults to 6. */
  moderateThreshold?: number;
  /** Total vehicle count at/above which the traffic-level badge becomes "heavy". Defaults to 15. */
  heavyThreshold?: number;
  /** Roadway occupancy (0-1) at/above which the badge becomes "moderate". Defaults to 0.15. */
  moderateOccupancy?: number;
  /** Roadway occupancy (0-1) at/above which the badge becomes "heavy". Defaults to 0.35. */
  heavyOccupancy?: number;
  /** Detector for this camera. Defaults to a fresh `MotionDetector`. */
  detector?: VehicleDetectorLike;
  /** Tracker for this camera. Defaults to a fresh `VehicleTracker`. */
  tracker?: VehicleTrackerLike;
  /**
   * Occupancy estimator for this camera. Defaults to a fresh
   * `OccupancyEstimator`; pass null to switch occupancy off and derive the
   * badge from the vehicle count alone.
   */
  occupancyEstimator?: OccupancyEstimatorLike | null;
}

const DEFAULTS = {
  moderateThreshold: 6,
  heavyThreshold: 15,
  moderateOccupancy: 0.15,
  heavyOccupancy: 0.35,
};

/** Stand-in used when occupancy is switched off, so the analyzer needs no null checks. */
const DISABLED_OCCUPANCY: OccupancyEstimatorLike = { update: async () => ({ occupancy: null }) };

/**
 * CameraAnalyzer turns one frame from one camera into one analysis result.
 *
 * It exists because everything downstream of "we have a frame" is
 * per-camera *stateful*, and that state used to be spread across four
 * parallel maps in `TrafficAnalysisService` under three different creation
 * rules. A detector's background model, a tracker's assigned ids and an
 * occupancy estimator's learned roadway all describe one fixed viewpoint,
 * are meaningless if shared across cameras, and must be discarded together
 * when a camera stops being sampled - which makes them one thing with one
 * lifetime, not three parallel lookups. Holding them behind a single
 * `analyze(frame)` means creating and disposing a camera's analysis state
 * is one construction and one `dispose()`, and adding a further per-camera
 * signal later changes this module only.
 *
 * `TrafficAnalysisService` keeps what is genuinely *not* per-camera:
 * scheduling, boosting, the concurrency pool, persistence and subscriber
 * fan-out. It hands frames in and gets results out.
 *
 * The pipeline is: detect moving objects -> assign stable track ids ->
 * measure roadway occupancy from the same frame -> derive the
 * Light/Moderate/Heavy badge. Occupancy is deliberately measured
 * independently of the detections rather than derived from them - see
 * `deriveTrafficLevel`.
 *
 * One instance per camera. Detector, tracker and occupancy estimator are
 * all injectable so a whole tick's logic can be asserted from canned
 * detections, with no image decoding in the loop.
 */
export class CameraAnalyzer {
  private readonly moderateThreshold: number;
  private readonly heavyThreshold: number;
  private readonly moderateOccupancy: number;
  private readonly heavyOccupancy: number;
  private readonly detector: VehicleDetectorLike;
  private readonly tracker: VehicleTrackerLike;
  private readonly occupancyEstimator: OccupancyEstimatorLike;

  constructor(
    private readonly cameraId: string,
    options: CameraAnalyzerOptions = {},
  ) {
    this.moderateThreshold = options.moderateThreshold ?? DEFAULTS.moderateThreshold;
    this.heavyThreshold = options.heavyThreshold ?? DEFAULTS.heavyThreshold;
    this.moderateOccupancy = options.moderateOccupancy ?? DEFAULTS.moderateOccupancy;
    this.heavyOccupancy = options.heavyOccupancy ?? DEFAULTS.heavyOccupancy;
    this.detector = options.detector ?? new MotionDetector();
    this.tracker = options.tracker ?? new VehicleTracker();
    // `undefined` means "not specified, use the default"; an explicit null
    // means "occupancy off" - so the two can't collapse into one `??`.
    this.occupancyEstimator =
      options.occupancyEstimator === undefined
        ? new OccupancyEstimator()
        : (options.occupancyEstimator ?? DISABLED_OCCUPANCY);
  }

  /**
   * Analyzes one frame, returning the complete result for this tick.
   *
   * Never rejects: a detection failure produces an error result rather than
   * losing the tick, since a subscriber still needs to be told the camera
   * produced nothing this time and why.
   */
  async analyze(frame: Buffer, timestamp: string): Promise<CameraAnalysisResult> {
    let detections: VehicleDetection[];
    try {
      const rawDetections = await this.detector.detect(frame);
      // No color estimation in the loop: it added a per-detection sharp
      // crop+resize cost (compounding with detection count) that meaningfully
      // slowed down every tick without being needed yet. `VehicleColorEstimator`
      // is still on disk - re-enable by mapping rawDetections through its
      // `estimateColor` here once that cost is worth paying.
      detections = this.tracker.update(rawDetections);
    } catch (err) {
      return this.errorResult(timestamp, err instanceof Error ? err.message : 'Detection failed');
    }

    // Occupancy is measured from the same frame but is deliberately not
    // derived from the detections: it is the independent signal, and it stays
    // meaningful precisely where counting degrades - distant vehicles too
    // small for the detector still cover roadway pixels. A failure here must
    // not lose the tick, so it falls back to a count-derived badge.
    let occupancy: number | null = null;
    try {
      occupancy = (await this.occupancyEstimator.update(frame)).occupancy;
    } catch {
      occupancy = null;
    }

    const totalCount = detections.length;
    return {
      cameraId: this.cameraId,
      timestamp,
      totalCount,
      trafficLevel: this.deriveTrafficLevel(totalCount, occupancy),
      detections,
      ...(occupancy === null ? {} : { occupancy }),
    };
  }

  /** The result for a tick that never produced a usable frame - shaped identically to a real one so subscribers need no special case. */
  errorResult(timestamp: string, error: string): CameraAnalysisResult {
    return {
      cameraId: this.cameraId,
      timestamp,
      totalCount: 0,
      trafficLevel: 'light',
      detections: [],
      error,
    };
  }

  /**
   * Releases this camera's learned state.
   *
   * Background models describe one fixed viewpoint and take minutes of
   * footage to settle, but they're worthless once sampling stops - a
   * restarted service may be looking at a re-aimed camera. Dropping the
   * analyzer is what discards them; this exists so callers have one call to
   * make rather than one per model.
   */
  dispose(): void {
    // Nothing to release explicitly today - the models are plain in-memory
    // state, freed with the analyzer itself. Kept as the single teardown
    // point so a future per-camera signal holding a real resource (a file
    // handle, a native context) has an obvious place to close it.
  }

  /**
   * Derives the Light/Moderate/Heavy badge, preferring roadway occupancy
   * over the vehicle count.
   *
   * The badge answers "how busy is this road", which is a question about
   * how much of it is covered - not about how many vehicles a detector
   * managed to resolve. Counting is the harder problem and fails worst
   * exactly where it matters most: on a wide, busy view, most vehicles are
   * small and distant, so the count collapses while the road is visibly
   * full. Occupancy degrades gracefully there instead.
   *
   * The count remains the fallback for a camera whose occupancy estimator
   * is still warming up, has found no roadway to measure, or is disabled.
   */
  private deriveTrafficLevel(totalCount: number, occupancy: number | null): TrafficLevel {
    if (occupancy !== null) {
      if (occupancy >= this.heavyOccupancy) return 'heavy';
      if (occupancy >= this.moderateOccupancy) return 'moderate';
      return 'light';
    }
    if (totalCount >= this.heavyThreshold) return 'heavy';
    if (totalCount >= this.moderateThreshold) return 'moderate';
    return 'light';
  }
}
