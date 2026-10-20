import { BoundingBox, FinishedTrack } from '../types/analysis';
import { PassageDirection, RoadAxis, SizeClass, VehiclePassage } from '../types/stats';

/** Running sums of displacement outer products, enough to recover the principal axis. */
export interface AxisMoments {
  sxx: number;
  syy: number;
  sxy: number;
  n: number;
}

export interface DirectionModelOptions {
  /**
   * Minimum net movement (normalized frame units) along the road axis for a
   * passage to get a direction, and minimum total movement for it to count
   * towards learning the axis. Defaults to 0.05 (5% of the frame).
   */
  minDisplacement?: number;
  /** Passages needed before the learned axis is trusted over the passage's own heading. Defaults to 5. */
  minSamples?: number;
}

/**
 * Orients an axis so that its labels stay stable as it is re-estimated:
 * "A" points down the frame, or left-to-right when the road is close to
 * horizontal (where a tiny wobble in y would otherwise flip every label).
 */
function orient(x: number, y: number): RoadAxis {
  const len = Math.hypot(x, y) || 1;
  let ux = x / len;
  let uy = y / len;
  const flip = Math.abs(uy) >= 0.2 ? uy < 0 : ux < 0;
  if (flip) {
    ux = -ux;
    uy = -uy;
  }
  return { x: ux, y: uy };
}

/**
 * Learns a camera's dominant road axis from the net displacement of the
 * vehicles that pass it, and labels each passage A or B by which way it
 * moved along that axis. No per-camera configuration is needed: on a fixed
 * viewpoint, traffic overwhelmingly moves along one line, and the
 * principal eigenvector of the displacement vectors finds it whatever the
 * road's angle in the frame.
 */
export class DirectionModel {
  private readonly minDisplacement: number;
  private readonly minSamples: number;
  private moments: AxisMoments = { sxx: 0, syy: 0, sxy: 0, n: 0 };

  constructor(options: DirectionModelOptions = {}) {
    this.minDisplacement = options.minDisplacement ?? 0.05;
    this.minSamples = options.minSamples ?? 5;
  }

  /** Restores moments persisted from earlier passages, so labels survive a restart. */
  seed(moments: AxisMoments): void {
    this.moments = { ...moments };
  }

  /** The learned axis, or null until enough passages have been seen. */
  axis(): RoadAxis | null {
    const { sxx, syy, sxy, n } = this.moments;
    if (n < this.minSamples) return null;
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return orient(Math.cos(theta), Math.sin(theta));
  }

  classify(dx: number, dy: number): PassageDirection | null {
    if (Math.hypot(dx, dy) >= this.minDisplacement) {
      this.moments.sxx += dx * dx;
      this.moments.syy += dy * dy;
      this.moments.sxy += dx * dy;
      this.moments.n += 1;
    }
    const axis = this.axis() ?? orient(dx, dy);
    const projection = dx * axis.x + dy * axis.y;
    if (Math.abs(projection) < this.minDisplacement) return null;
    return projection > 0 ? 'A' : 'B';
  }
}

export interface SizeClassifierOptions {
  /** Horizontal bands the frame is split into; vehicles are only compared with others at a similar distance. Defaults to 4. */
  bands?: number;
  /** Areas remembered per band. Defaults to 200. */
  windowSize?: number;
  /** Samples a band needs before its median is trusted. Defaults to 30. */
  minSamples?: number;
  /** Area, as a multiple of the band median, from which a vehicle counts as large. Defaults to 2.5. */
  largeRatio?: number;
  /** Fallback while a band is still learning: absolute normalized area from which a vehicle counts as large. Defaults to 0.06. */
  absoluteLargeArea?: number;
}

/**
 * Coarse car / large-vehicle split from box size. Perspective makes raw
 * box area meaningless on its own (a bus far away is smaller than a car up
 * close), so each vehicle is compared with the median of recent vehicles
 * at the same height in the frame. Approximate by design: the UI labels it
 * as such.
 */
export class SizeClassifier {
  private readonly bands: number;
  private readonly windowSize: number;
  private readonly minSamples: number;
  private readonly largeRatio: number;
  private readonly absoluteLargeArea: number;
  private readonly areas: number[][];

  constructor(options: SizeClassifierOptions = {}) {
    this.bands = options.bands ?? 4;
    this.windowSize = options.windowSize ?? 200;
    this.minSamples = options.minSamples ?? 30;
    this.largeRatio = options.largeRatio ?? 2.5;
    this.absoluteLargeArea = options.absoluteLargeArea ?? 0.06;
    this.areas = Array.from({ length: this.bands }, () => []);
  }

  classify(box: BoundingBox): SizeClass {
    const area = box.width * box.height;
    const centreY = Math.min(0.999, Math.max(0, box.y + box.height / 2));
    const band = this.areas[Math.floor(centreY * this.bands)];

    let large: boolean;
    if (band.length >= this.minSamples) {
      const sorted = [...band].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      large = area >= median * this.largeRatio;
    } else {
      large = area >= this.absoluteLargeArea;
    }

    band.push(area);
    if (band.length > this.windowSize) band.shift();
    return large ? 'large' : 'car';
  }
}

function centre(box: BoundingBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * One camera's passage labelling state: its learned road axis and size
 * baseline. Like the analyzer itself, both describe a single fixed
 * viewpoint, so there is one instance per camera.
 */
export class CameraPassageModel {
  readonly direction: DirectionModel;
  readonly size: SizeClassifier;

  constructor(
    readonly cameraId: string,
    options: { direction?: DirectionModelOptions; size?: SizeClassifierOptions } = {},
  ) {
    this.direction = new DirectionModel(options.direction);
    this.size = new SizeClassifier(options.size);
  }

  toPassage(track: FinishedTrack): VehiclePassage {
    const from = centre(track.firstBox);
    const to = centre(track.lastBox);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    // The larger of the two boxes is the one closer to the camera, i.e. the
    // least affected by distance and by being partly out of frame.
    const firstArea = track.firstBox.width * track.firstBox.height;
    const lastArea = track.lastBox.width * track.lastBox.height;
    const sizeBox = firstArea >= lastArea ? track.firstBox : track.lastBox;
    return {
      cameraId: this.cameraId,
      trackId: track.trackId,
      firstSeen: track.firstSeen,
      lastSeen: track.lastSeen,
      dx,
      dy,
      direction: this.direction.classify(dx, dy),
      sizeClass: this.size.classify(sizeBox),
    };
  }
}
