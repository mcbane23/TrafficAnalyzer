/**
 * Shared domain types for the real-time vehicle traffic analysis feature
 * (see docs/prd/vehicle-traffic-analysis.md).
 */

/**
 * Detection no longer classifies vehicle type (see MotionDetector): low
 * resolution and motion blur make appearance-based classification
 * unreliable for moving traffic, so every moving object is surfaced as a
 * single generic class instead. Kept as a type (rather than dropping the
 * field outright) so `VehicleDetection`/`VehicleTracker` keep a stable
 * shape and a real discriminant, in case a distinct class is ever
 * reintroduced.
 */
export type VehicleClass = 'vehicle';

export type TrafficLevel = 'light' | 'moderate' | 'heavy';

/** A bounding box normalized to 0..1, relative to the source frame's width/height. */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A single detected moving object, as surfaced to consumers of MotionDetector/TrafficAnalysisService. */
export interface VehicleDetection {
  class: VehicleClass;
  /**
   * Best-effort confidence (0-1) that this is a genuine moving vehicle
   * rather than noise, derived from the detected blob's shape (see
   * MotionDetector) rather than a calibrated model score - there is no
   * classifier in the loop any more.
   */
  confidence: number;
  box: BoundingBox;
  /** Best-effort dominant color name for the detected vehicle (e.g. "silver"). Omitted if color estimation failed. */
  color?: string;
  /**
   * Stable id identifying this specific vehicle instance across consecutive
   * analysis ticks for the same camera (assigned by VehicleTracker), so the
   * frontend can render a consistent color per vehicle and follow individual
   * vehicles across frames instead of every tick looking like brand new,
   * unrelated boxes. Omitted only for results produced before tracking is
   * applied (e.g. raw MotionDetector output in tests).
   */
  trackId?: number;
}

/** Full per-tick analysis result for a single camera, delivered over its per-camera SSE stream. */
export interface CameraAnalysisResult {
  cameraId: string;
  timestamp: string;
  totalCount: number;
  trafficLevel: TrafficLevel;
  detections: VehicleDetection[];
  /**
   * Share (0-1) of the camera's learned roadway currently covered by
   * vehicles, measured independently of detection - this is what drives
   * `trafficLevel`. Omitted while the estimator is warming up on a newly
   * started camera, or when it cannot identify a roadway region.
   */
  occupancy?: number;
  /** Present when frame capture or detection failed for this tick; other fields are zeroed/defaulted. */
  error?: string;
}

/** Lightweight overview for the dashboard-wide feed: count + traffic-level badge only, no per-vehicle detail. */
export interface CameraAnalysisOverview {
  cameraId: string;
  timestamp: string;
  totalCount: number;
  trafficLevel: TrafficLevel;
  /** Roadway occupancy behind `trafficLevel` - see CameraAnalysisResult.occupancy. */
  occupancy?: number;
  error?: string;
}

/** Shape persisted by TrafficHistoryStore for trend/history queries. */
export interface StoredAnalysisResult {
  cameraId: string;
  timestamp: string;
  totalCount: number;
  trafficLevel: TrafficLevel;
}
