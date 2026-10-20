/**
 * Shared domain types for the real-time vehicle traffic analysis feature
 * (see docs/prd/vehicle-traffic-analysis.md).
 */

/**
 * Motion detection (MotionDetector, which drives counting and statistics)
 * cannot tell vehicle types apart, so everything it finds is the generic
 * `'vehicle'`. The appearance-based YoloDetector, which only drives the
 * boxes drawn over the camera being watched, reports the specific type.
 */
export type VehicleClass = 'vehicle' | 'car' | 'motorcycle' | 'bus' | 'truck';

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

/**
 * A confirmed vehicle track that has ended - the vehicle left the frame, or
 * went undetected for longer than the tracker is willing to coast it. Emitted
 * exactly once per track, on the tick the tracker gives up on it, so a
 * consumer can turn each one into a single "vehicle passed" record without
 * having to diff the live track list itself. Only tracks that were confirmed
 * (seen on enough frames - see `VehicleTracker`'s `minHits`) are ever
 * finished: a one-frame noise blob never becomes a passage.
 */
export interface FinishedTrack {
  trackId: number;
  /** Timestamp (ISO 8601) of the first frame this track was detected on. */
  firstSeen: string;
  /** Timestamp (ISO 8601) of the last frame this track was actually detected on (not merely predicted). */
  lastSeen: string;
  /** Box (normalized 0..1) on the first frame - compare against `lastBox` for net displacement / direction. */
  firstBox: BoundingBox;
  /** Box (normalized 0..1) on the last frame it was actually detected on. */
  lastBox: BoundingBox;
  /** Number of frames this track was matched to a detection on. */
  hits: number;
}

/** Full per-tick analysis result for a single camera, delivered over its per-camera SSE stream. */
export interface CameraAnalysisResult {
  cameraId: string;
  timestamp: string;
  /**
   * Presentation time (seconds, the source stream's own MPEG-TS clock) of
   * the frame this result was computed from. The browser's player knows the
   * same clock for the picture it is showing, so this is what lets an
   * overlay draw a result over the video frame it describes rather than
   * over whatever is on screen when it arrives. Omitted when the capture
   * could not report it (and on error results).
   */
  streamTime?: number;
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
  /**
   * Confirmed tracks that ended on this tick (see `FinishedTrack`). Always
   * present on a successful result (possibly empty); empty on error results.
   */
  finishedTracks: FinishedTrack[];
  /**
   * True while this camera's detector is still learning its background
   * (the first few seconds of footage after a capture starts). A warming
   * result reports zero detections because nothing can be detected yet, not
   * because the road is empty, so - like an error result - it is published
   * but never persisted.
   */
  warmingUp?: boolean;
  /** Present when frame capture or detection failed for this tick; other fields are zeroed/defaulted. */
  error?: string;
}

/**
 * Vehicle boxes for the camera a viewer is watching, from the
 * appearance-based detector (see LiveOverlayService) rather than the
 * fleet-wide motion analysis. Drawing only - never counted or persisted.
 */
export interface LiveOverlayResult {
  cameraId: string;
  timestamp: string;
  /** See `CameraAnalysisResult.streamTime`. */
  streamTime?: number;
  /** Tracked vehicles on this frame, with their type. */
  detections: VehicleDetection[];
  /** Set when the overlay can't be produced (camera inactive, detector busy or failing); `detections` is empty. */
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
