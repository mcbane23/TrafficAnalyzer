import { BoundingBox, FinishedTrack, VehicleDetection } from '../types/analysis';
import { solveAssignment } from './assignment';

/** A vehicle detection annotated with a stable id, unique to a single vehicle instance across frames for one camera. */
export interface TrackedVehicleDetection extends VehicleDetection {
  trackId: number;
}

export interface TrackerUpdate {
  /** Confirmed tracks matched to a detection on this frame, with their filtered boxes. */
  tracks: TrackedVehicleDetection[];
  /** Confirmed tracks that ended on this frame - each track appears here exactly once in its lifetime. */
  finished: FinishedTrack[];
}

export interface VehicleTrackerOptions {
  /**
   * Detections at/above this confidence take part in the first association
   * pass and may start new tracks; those below it are only used to keep
   * already-confirmed tracks alive (ByteTrack's second pass). Defaults to 0.5.
   */
  highConfidence?: number;
  /** Frames a new track must be matched on before it is confirmed (reported, counted and eventually finished). Defaults to 3. */
  minHits?: number;
  /** How long (ms) a confirmed track may go undetected - coasting on its motion prediction - before it is finished. Defaults to 1500. */
  maxLostMs?: number;
  /**
   * A gap between consecutive frames longer than this (ms) - a stream drop,
   * a reconnect, a capture that was closed and later reopened - finishes
   * every track rather than trying to match across it. Defaults to 5000.
   */
  maxFrameGapMs?: number;
  /** Minimum association similarity (0-1, see `similarity`) for a detection to be matched to a track. Defaults to 0.25. */
  minSimilarity?: number;
  /** Kalman process noise: expected vehicle acceleration, in frame-widths per second squared. Defaults to 0.5. */
  accelerationNoise?: number;
  /** Weight (0-1) given to a frame's raw detected size versus the track's current size. Defaults to 0.4. */
  sizeSmoothing?: number;
}

const DEFAULTS = {
  highConfidence: 0.5,
  minHits: 3,
  maxLostMs: 1500,
  maxFrameGapMs: 5000,
  minSimilarity: 0.25,
  accelerationNoise: 0.5,
  sizeSmoothing: 0.4,
};

/** Initial velocity variance for a brand new track, in (frame-widths per second)^2 - a new vehicle could be moving any which way. */
const INITIAL_VELOCITY_VARIANCE = 0.25;
/** Measurement noise floor (frame widths), so a tiny box doesn't make the filter over-trust its center. */
const MIN_MEASUREMENT_NOISE = 0.004;
/** Measurement noise as a share of the box's own size - a blob's center wobbles by a fraction of its extent. */
const RELATIVE_MEASUREMENT_NOISE = 0.15;
/** Detections more than this many times larger/smaller in area than a track cannot be the same vehicle. */
const MAX_AREA_RATIO = 4;

/**
 * One axis (x or y) of a constant-velocity Kalman filter over a track's box
 * center. The two axes are independent, which keeps this a pair of 2x2
 * filters instead of a general matrix library.
 */
class AxisFilter {
  /** Position variance, position/velocity covariance, velocity variance. */
  private pp: number;
  private pv = 0;
  private vv = INITIAL_VELOCITY_VARIANCE;
  velocity = 0;

  constructor(
    public position: number,
    measurementNoise: number,
  ) {
    this.pp = measurementNoise * measurementNoise;
  }

  predict(dt: number, accelerationNoise: number): void {
    if (dt <= 0) return;
    this.position += this.velocity * dt;
    const q = accelerationNoise * accelerationNoise;
    const pp = this.pp + 2 * dt * this.pv + dt * dt * this.vv + (q * dt ** 4) / 4;
    const pv = this.pv + dt * this.vv + (q * dt ** 3) / 2;
    const vv = this.vv + q * dt * dt;
    this.pp = pp;
    this.pv = pv;
    this.vv = vv;
  }

  update(measurement: number, measurementNoise: number): void {
    const s = this.pp + measurementNoise * measurementNoise;
    const kp = this.pp / s;
    const kv = this.pv / s;
    const residual = measurement - this.position;
    this.position += kp * residual;
    this.velocity += kv * residual;
    const pp = (1 - kp) * this.pp;
    const pv = (1 - kp) * this.pv;
    const vv = this.vv - kv * this.pv;
    this.pp = pp;
    this.pv = pv;
    this.vv = vv;
  }

  /** Standard deviation of the predicted position. */
  get positionStd(): number {
    return Math.sqrt(Math.max(0, this.pp));
  }
}

interface Track {
  id: number;
  x: AxisFilter;
  y: AxisFilter;
  width: number;
  height: number;
  hits: number;
  confirmed: boolean;
  firstSeenMs: number;
  lastSeenMs: number;
  firstBox: BoundingBox;
  lastBox: BoundingBox;
  /** Index of the detection this track was matched to on the current frame, or -1 - set during `update`. */
  matchedIndex: number;
}

/**
 * VehicleTracker assigns a stable id to each vehicle across consecutive
 * frames of one camera, ByteTrack-style:
 *
 * - **Motion model.** Each track's box center runs through a
 *   constant-velocity Kalman filter driven by real frame timestamps, not
 *   tick counts. Frames from an HLS relay do not arrive evenly (see
 *   `FrameGrabber`), so "one tick" can mean 150ms or 2s; predicting with
 *   the actual elapsed time is what keeps a vehicle findable after an
 *   uneven gap, and the filter's growing uncertainty widens the search
 *   radius exactly as much as the gap warrants.
 * - **Association.** Matching is a global optimal assignment (Hungarian)
 *   over a similarity that blends box overlap with center distance inside
 *   that uncertainty-scaled gate. Pure overlap fails on precisely the small
 *   fast vehicles this fleet is full of - a 10px car that moved 12px between
 *   frames has zero overlap with itself - and greedy matching lets one bad
 *   early pairing cascade into swapped ids.
 * - **Two passes.** Confident detections are matched first and may start
 *   tracks; low-confidence detections (ragged, partly occluded blobs) are
 *   then only used to keep already-confirmed tracks alive. A vehicle
 *   briefly reduced to a scrappy blob keeps its id instead of being dropped
 *   and re-created, and that scrappy blob can never start a phantom vehicle.
 * - **Confirmation.** A new track is tentative until matched on `minHits`
 *   frames; tentative tracks are never reported, and are discarded the
 *   first frame they're missed. Noise blobs - compression artifacts, a
 *   flicker of glare - do not live long enough to become vehicles.
 * - **Coasting.** A confirmed track that goes undetected keeps predicting
 *   forward for up to `maxLostMs` so a brief occlusion doesn't split it in
 *   two, but - as before - it is never *reported* while undetected, so a
 *   vehicle that has left the frame stops being drawn immediately.
 *
 * When a confirmed track is given up on (lost too long, predicted out of
 * frame, or a stream gap longer than `maxFrameGapMs`) it is returned once in
 * `finished`, which is what downstream vehicle counting is built on.
 *
 * One instance per camera - tracking is meaningless across different
 * cameras' frames.
 */
export class VehicleTracker {
  private readonly highConfidence: number;
  private readonly minHits: number;
  private readonly maxLostMs: number;
  private readonly maxFrameGapMs: number;
  private readonly minSimilarity: number;
  private readonly accelerationNoise: number;
  private readonly sizeSmoothing: number;
  private tracks: Track[] = [];
  private nextId = 1;
  private lastFrameMs: number | null = null;

  constructor(options: VehicleTrackerOptions = {}) {
    this.highConfidence = options.highConfidence ?? DEFAULTS.highConfidence;
    this.minHits = options.minHits ?? DEFAULTS.minHits;
    this.maxLostMs = options.maxLostMs ?? DEFAULTS.maxLostMs;
    this.maxFrameGapMs = options.maxFrameGapMs ?? DEFAULTS.maxFrameGapMs;
    this.minSimilarity = options.minSimilarity ?? DEFAULTS.minSimilarity;
    this.accelerationNoise = options.accelerationNoise ?? DEFAULTS.accelerationNoise;
    this.sizeSmoothing = options.sizeSmoothing ?? DEFAULTS.sizeSmoothing;
  }

  /** Feeds one frame's detections, taken at `timestampMs` (epoch ms), through the tracker. */
  update(detections: VehicleDetection[], timestampMs: number): TrackerUpdate {
    const finished: FinishedTrack[] = [];

    if (this.lastFrameMs !== null && timestampMs - this.lastFrameMs > this.maxFrameGapMs) {
      // Nothing seen before the gap can be meaningfully matched after it.
      finished.push(...this.finishAll());
    }
    const dt = this.lastFrameMs === null ? 0 : Math.max(0, (timestampMs - this.lastFrameMs) / 1000);
    this.lastFrameMs = timestampMs;

    for (const track of this.tracks) {
      track.x.predict(dt, this.accelerationNoise);
      track.y.predict(dt, this.accelerationNoise);
      track.matchedIndex = -1;
    }

    const high: number[] = [];
    const low: number[] = [];
    detections.forEach((d, i) => (d.confidence >= this.highConfidence ? high : low).push(i));

    // Pass 1: confident detections against every live track.
    const unmatchedHigh = this.associate(this.tracks, high, detections, timestampMs);
    // Pass 2: leftover low-confidence detections may only keep a confirmed track alive.
    this.associate(
      this.tracks.filter((t) => t.matchedIndex < 0 && t.confirmed),
      low,
      detections,
      timestampMs,
    );

    const survivors: Track[] = [];
    for (const track of this.tracks) {
      if (track.matchedIndex >= 0) {
        survivors.push(track);
        continue;
      }
      if (!track.confirmed) continue; // Tentative and missed: noise, drop silently.
      const lostFor = timestampMs - track.lastSeenMs;
      if (lostFor > this.maxLostMs || isOutOfFrame(track)) {
        finished.push(toFinished(track));
        continue;
      }
      survivors.push(track);
    }
    this.tracks = survivors;

    for (const index of unmatchedHigh) {
      this.tracks.push(this.createTrack(detections[index], index, timestampMs));
    }

    const reported = this.tracks
      .filter((t) => t.confirmed && t.matchedIndex >= 0)
      .sort((a, b) => a.matchedIndex - b.matchedIndex)
      .map((t): TrackedVehicleDetection => ({ ...detections[t.matchedIndex], trackId: t.id, box: currentBox(t) }));

    return { tracks: reported, finished };
  }

  /** Finishes every confirmed track now (e.g. when the camera's capture is torn down), returning them. */
  flush(): FinishedTrack[] {
    const finished = this.finishAll();
    this.lastFrameMs = null;
    return finished;
  }

  private finishAll(): FinishedTrack[] {
    const finished = this.tracks.filter((t) => t.confirmed).map(toFinished);
    this.tracks = [];
    return finished;
  }

  /**
   * Optimally matches `detectionIndices` to `tracks`, updating matched
   * tracks in place. Returns the detection indices left unmatched.
   */
  private associate(tracks: Track[], detectionIndices: number[], detections: VehicleDetection[], timestampMs: number): number[] {
    if (tracks.length === 0 || detectionIndices.length === 0) return detectionIndices;

    const cost = tracks.map((track) =>
      detectionIndices.map((di) => {
        const s = this.similarity(track, detections[di].box);
        return s >= this.minSimilarity ? 1 - s : Infinity;
      }),
    );
    const assignment = solveAssignment(cost);

    const used = new Set<number>();
    assignment.forEach((col, row) => {
      if (col < 0) return;
      const track = tracks[row];
      this.applyMatch(track, detections, detectionIndices[col], timestampMs);
      used.add(col);
    });
    return detectionIndices.filter((_, col) => !used.has(col));
  }

  /**
   * How plausibly `box` is this track's vehicle on the current frame, 0-1.
   *
   * Blends box overlap with the predicted box against how close the box's
   * center is to the predicted center, relative to a gate that grows with
   * the vehicle's size and with the filter's own positional uncertainty.
   * Overlap alone scores zero for a small vehicle that moved more than its
   * own length between frames; distance alone can't tell a big lorry from
   * a car beside it - so neither is used on its own. Wildly different sizes
   * are rejected outright.
   */
  private similarity(track: Track, box: BoundingBox): number {
    const predicted = currentBox(track);
    const areaA = predicted.width * predicted.height;
    const areaB = box.width * box.height;
    if (areaA <= 0 || areaB <= 0) return 0;
    const ratio = areaA > areaB ? areaA / areaB : areaB / areaA;
    if (ratio > MAX_AREA_RATIO) return 0;

    const dx = box.x + box.width / 2 - track.x.position;
    const dy = box.y + box.height / 2 - track.y.position;
    const distance = Math.hypot(dx, dy);
    const size = Math.max(Math.hypot(predicted.width, predicted.height), Math.hypot(box.width, box.height));
    const uncertainty = 3 * Math.hypot(track.x.positionStd, track.y.positionStd);
    const gate = Math.max(size, uncertainty);
    if (distance >= gate) return 0;

    return 0.5 * iou(predicted, box) + 0.5 * (1 - distance / gate);
  }

  private applyMatch(track: Track, detections: VehicleDetection[], index: number, timestampMs: number): void {
    const box = detections[index].box;
    track.x.update(box.x + box.width / 2, measurementNoise(box.width));
    track.y.update(box.y + box.height / 2, measurementNoise(box.height));
    track.width = lerp(track.width, box.width, this.sizeSmoothing);
    track.height = lerp(track.height, box.height, this.sizeSmoothing);
    track.hits += 1;
    track.lastSeenMs = timestampMs;
    track.lastBox = box;
    track.matchedIndex = index;
    if (track.hits >= this.minHits) track.confirmed = true;
  }

  private createTrack(detection: VehicleDetection, index: number, timestampMs: number): Track {
    const box = detection.box;
    return {
      id: this.nextId++,
      x: new AxisFilter(box.x + box.width / 2, measurementNoise(box.width)),
      y: new AxisFilter(box.y + box.height / 2, measurementNoise(box.height)),
      width: box.width,
      height: box.height,
      hits: 1,
      confirmed: this.minHits <= 1,
      firstSeenMs: timestampMs,
      lastSeenMs: timestampMs,
      firstBox: box,
      lastBox: box,
      matchedIndex: index,
    };
  }
}

function currentBox(track: Track): BoundingBox {
  return {
    x: track.x.position - track.width / 2,
    y: track.y.position - track.height / 2,
    width: track.width,
    height: track.height,
  };
}

function isOutOfFrame(track: Track): boolean {
  const cx = track.x.position;
  const cy = track.y.position;
  return cx < 0 || cx > 1 || cy < 0 || cy > 1;
}

function toFinished(track: Track): FinishedTrack {
  return {
    trackId: track.id,
    firstSeen: new Date(track.firstSeenMs).toISOString(),
    lastSeen: new Date(track.lastSeenMs).toISOString(),
    firstBox: track.firstBox,
    lastBox: track.lastBox,
    hits: track.hits,
  };
}

function measurementNoise(extent: number): number {
  return Math.max(MIN_MEASUREMENT_NOISE, extent * RELATIVE_MEASUREMENT_NOISE);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function iou(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}
