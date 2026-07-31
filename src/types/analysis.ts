/**
 * Shared domain types for the real-time vehicle traffic analysis feature
 * (see docs/prd/vehicle-traffic-analysis.md).
 */

/**
 * Vehicle classes surfaced by this feature. The pretrained COCO detection
 * model has no dedicated "tram" class - its "train" class is used as a
 * stand-in and labeled "tram" here, an accepted approximation for
 * Belgrade's tram network (see VehicleDetector's COCO_TO_VEHICLE_CLASS).
 * "motorcycle" also covers COCO's "bicycle" class (displayed as
 * "Motorcycle/Bicycle" in the UI).
 */
export type VehicleClass = 'car' | 'bus' | 'truck' | 'tram' | 'motorcycle';

export const VEHICLE_CLASSES: readonly VehicleClass[] = ['car', 'bus', 'truck', 'tram', 'motorcycle'];

export type TrafficLevel = 'light' | 'moderate' | 'heavy';

/** A bounding box normalized to 0..1, relative to the source frame's width/height. */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A single detected vehicle, as surfaced to consumers of VehicleDetector/TrafficAnalysisService. */
export interface VehicleDetection {
  class: VehicleClass;
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
   * applied (e.g. raw VehicleDetector output in tests).
   */
  trackId?: number;
}

/** Raw output of the underlying detection model, before class-mapping/confidence filtering by VehicleDetector. */
export interface RawModelDetection {
  /** COCO class id (0-indexed, standard 80-class order). */
  classId: number;
  confidence: number;
  box: BoundingBox;
}

export function emptyClassCounts(): Record<VehicleClass, number> {
  return { car: 0, bus: 0, truck: 0, tram: 0, motorcycle: 0 };
}

/** Full per-tick analysis result for a single camera, delivered over its per-camera SSE stream. */
export interface CameraAnalysisResult {
  cameraId: string;
  timestamp: string;
  totalCount: number;
  countsByClass: Record<VehicleClass, number>;
  trafficLevel: TrafficLevel;
  detections: VehicleDetection[];
  /** Present when frame capture or detection failed for this tick; other fields are zeroed/defaulted. */
  error?: string;
}

/** Lightweight overview for the dashboard-wide feed: count + traffic-level badge only, no per-vehicle detail. */
export interface CameraAnalysisOverview {
  cameraId: string;
  timestamp: string;
  totalCount: number;
  trafficLevel: TrafficLevel;
  error?: string;
}

/** Shape persisted by TrafficHistoryStore for trend/history queries. */
export interface StoredAnalysisResult {
  cameraId: string;
  timestamp: string;
  totalCount: number;
  countsByClass: Record<VehicleClass, number>;
  trafficLevel: TrafficLevel;
}
