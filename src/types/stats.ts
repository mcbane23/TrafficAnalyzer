/**
 * Shared domain types for traffic statistics: vehicle passages and the
 * aggregates served by the stats API (see TrafficStatsService).
 */

/**
 * Which way a vehicle moved along its camera's dominant road axis (see
 * DirectionModel). `A` is "down the frame" (or left-to-right on a
 * near-horizontal road), `B` the opposite. Null when the vehicle's net
 * movement along the axis was too small to tell.
 */
export type PassageDirection = 'A' | 'B';

/**
 * Coarse, approximate vehicle size class, from box size relative to other
 * vehicles seen at the same height in the frame (see SizeClassifier).
 * `large` means bus/truck-sized. Not a real vehicle-type classification.
 */
export type SizeClass = 'car' | 'large';

/** One vehicle that passed a camera: a finished, confirmed track. */
export interface VehiclePassage {
  cameraId: string;
  trackId: number;
  firstSeen: string;
  lastSeen: string;
  /** Net displacement of the box centre, normalized to frame size (0..1 units). */
  dx: number;
  dy: number;
  direction: PassageDirection | null;
  sizeClass: SizeClass;
}

/** Unit vector (image coordinates, y down) of a camera's dominant road axis; direction A points along it. */
export interface RoadAxis {
  x: number;
  y: number;
}

export type StatsRange = '1h' | '24h' | '7d' | '30d';
export type StatsBucket = '5m' | '15m' | '1h' | '1d';

/** Counts of passages, split every way the UI shows them. */
export interface PassageCounts {
  total: number;
  a: number;
  b: number;
  /** Passages whose direction could not be determined. */
  unknown: number;
  car: number;
  large: number;
}

export interface StatsBucketEntry extends PassageCounts {
  /** Bucket start (ISO 8601). */
  start: string;
  /** Mean roadway occupancy (0..1) over the analyzed frames in this bucket; null if none were analyzed. */
  occupancy: number | null;
  /**
   * Share (0..1) of this bucket during which the camera was actually being
   * analyzed. A bucket with low coverage and a low count means "no data",
   * not "no traffic" - the UI draws it as a gap.
   */
  coverage: number;
}

export interface CameraStats {
  cameraId: string;
  range: StatsRange;
  bucket: StatsBucket;
  from: string;
  to: string;
  timeZone: string;
  axis: RoadAxis | null;
  totals: PassageCounts;
  /** Mean coverage across the whole range (0..1). */
  coverage: number;
  buckets: StatsBucketEntry[];
}

export interface HeatmapCell {
  /** 0 = Monday ... 6 = Sunday, in the stats time zone. */
  weekday: number;
  /** 0..23, in the stats time zone. */
  hour: number;
  /** Vehicles per fully-analyzed hour; null when that slot was never analyzed. */
  vehiclesPerHour: number | null;
}

export interface CameraHeatmap {
  cameraId: string;
  days: number;
  timeZone: string;
  cells: HeatmapCell[];
}

export interface CameraSummary extends PassageCounts {
  cameraId: string;
  coverage: number;
  /** Hourly passage counts for the last 24 hours, oldest first (24 entries); null for an hour with no coverage. */
  sparkline: Array<number | null>;
}

export interface StatsSummary {
  range: StatsRange;
  from: string;
  to: string;
  totals: PassageCounts;
  cameras: CameraSummary[];
}

export interface LiveCounts {
  cameraId: string;
  last5m: PassageCounts;
  last1h: PassageCounts;
  today: PassageCounts;
}
