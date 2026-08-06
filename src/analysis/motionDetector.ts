import { BackgroundModel, LumaExtractor } from './backgroundModel';
import { VehicleDetection } from '../types/analysis';

export type { LumaExtractor };

export interface MotionDetectorOptions {
  /** Working width the frame is reduced to before analysis. Defaults to 240. */
  width?: number;
  /** Working height the frame is reduced to before analysis. Defaults to 180. */
  height?: number;
  /** Share of each new frame folded into the background model where nothing is detected. Defaults to 0.02. */
  learningRate?: number;
  /**
   * The same, for pixels currently holding something. Deliberately much
   * slower than `learningRate` - and slower still than
   * `OccupancyEstimator`'s equivalent - because a vehicle stopped at a red
   * light or sitting in a jam should keep being reported for the length of
   * a light cycle, not fade out the moment it stops moving. A genuinely
   * parked vehicle still eventually gets absorbed into the background at
   * this rate; it just takes longer. Defaults to a twentieth of
   * `learningRate`.
   */
  foregroundLearningRate?: number;
  /** Luma difference (0-255) above which a pixel counts as foreground (moving or recently-moved). Defaults to 25. */
  pixelThreshold?: number;
  /** Frames that must be observed before any detection is reported. Defaults to 20. */
  warmupFrames?: number;
  /**
   * Lower bound of the long-run foreground rate a pixel must have to be
   * eligible to form part of a blob - the same "is this actually roadway"
   * gate `OccupancyEstimator` applies (both come from `BackgroundModel`),
   * for the same reason: excluding pixels that have never shown activity
   * keeps a one-off sensor glitch or JPEG artifact from being reported as
   * a vehicle. Defaults to 0.02.
   */
  minActivityRate?: number;
  /** Upper bound of that rate - excludes perpetually-moving clutter (foliage, water, flags). Defaults to 0.6. */
  maxActivityRate?: number;
  /**
   * Minimum blob area, as a share of the working frame's pixel count, to
   * be reported as a vehicle rather than discarded as noise. Defaults to
   * 0.001 - well under the ~30x30px vehicle size measured on this camera
   * fleet at 704x576, leaving room for smaller or partially-visible
   * vehicles without admitting single-pixel noise.
   */
  minBlobAreaRatio?: number;
  /**
   * Maximum blob area, as a share of the working frame. Excludes a
   * frame-wide lighting change (a cloud shadow sweeping the whole scene, a
   * headlight flare, an auto-exposure jump) from being reported as one
   * implausibly large vehicle. Defaults to 0.25.
   */
  maxBlobAreaRatio?: number;
  /**
   * Number of binary-dilation passes applied to the eligible-pixel mask
   * before labeling, so a vehicle briefly split into two components by a
   * thin gap (glare on a windshield, a compression artifact) is still
   * counted once. Defaults to 1.
   */
  mergeRadius?: number;
  /** Injectable luma extractor, primarily for testing. */
  lumaExtractor?: LumaExtractor;
}

const DEFAULTS = {
  width: 240,
  height: 180,
  minBlobAreaRatio: 0.001,
  maxBlobAreaRatio: 0.25,
  mergeRadius: 1,
};

interface Blob {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
}

/**
 * MotionDetector finds moving (or recently-moving) objects by grouping the
 * pixels a `BackgroundModel` reports as foreground into discrete blobs -
 * one per object, rather than a single road-wide ratio.
 *
 * This replaces appearance-based classification (a COCO-trained detector)
 * as the primary vehicle signal: on this camera fleet vehicles are small,
 * oblique, motion-blurred and heavily compressed, which appearance models
 * struggle with worst on precisely the vehicles that are moving. A
 * difference-from-background silhouette doesn't care what the object looks
 * like, only that it's there and the background isn't - so it stays
 * reliable exactly where classification degrades. The tradeoff is
 * information: this can no longer say *what* something is, only that it's
 * moving, so every result is surfaced as a single generic `'vehicle'`
 * class (see `VehicleClass`) rather than car/bus/truck/etc.
 *
 * Learning the background and identifying the roadway are `BackgroundModel`'s
 * job, shared with `OccupancyEstimator`. What lives here is blob extraction:
 * the two ask different questions of the same kind of observation, and
 * they hold separate model instances because their tuning differs -
 * working resolution, and critically how long a stopped vehicle keeps
 * being reported (see `foregroundLearningRate`).
 *
 * One instance must be used per camera - the background model describes one
 * fixed viewpoint and is meaningless if shared across cameras.
 */
export class MotionDetector {
  private readonly model: BackgroundModel;
  private readonly minBlobAreaRatio: number;
  private readonly maxBlobAreaRatio: number;
  private readonly mergeRadius: number;

  constructor(options: MotionDetectorOptions = {}) {
    const learningRate = options.learningRate ?? 0.02;
    this.model = new BackgroundModel({
      ...options,
      width: options.width ?? DEFAULTS.width,
      height: options.height ?? DEFAULTS.height,
      learningRate,
      // Twice as patient as OccupancyEstimator's default: a stopped vehicle
      // must keep being counted for a whole light cycle, not fade out of the
      // count the moment it stops moving.
      foregroundLearningRate: options.foregroundLearningRate ?? learningRate / 20,
    });
    this.minBlobAreaRatio = options.minBlobAreaRatio ?? DEFAULTS.minBlobAreaRatio;
    this.maxBlobAreaRatio = options.maxBlobAreaRatio ?? DEFAULTS.maxBlobAreaRatio;
    this.mergeRadius = options.mergeRadius ?? DEFAULTS.mergeRadius;
  }

  /** Folds one frame into the model and returns the moving objects found in it - empty while still warming up. */
  async detect(frame: Buffer): Promise<VehicleDetection[]> {
    const observation = await this.model.observe(frame);
    if (observation.warming) {
      return [];
    }

    const { foreground, roadway, width, height } = observation;
    const n = width * height;

    // Roadway gating: only foreground pixels the model considers roadway are
    // eligible to seed or extend a blob. Pixels that are never foreground are
    // static scenery, and pixels that are almost always foreground are
    // perpetually-moving clutter (foliage, water) - neither is a vehicle.
    const eligible = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (foreground[i] && roadway[i]) eligible[i] = 1;
    }

    // Dilation only bridges small gaps for *connectivity* purposes (so a
    // vehicle split by a thin gap - windshield glare, a compression
    // artifact - is still one component); it must not itself inflate the
    // reported area or box, or it would both make a real vehicle's box
    // bigger than the vehicle and let dilation alone turn single-pixel
    // noise into a "blob" large enough to pass `minBlobAreaRatio`. So
    // labeling walks the dilated mask for adjacency, but area/bbox below
    // are accumulated only from `eligible`, the original undilated pixels.
    let connected: Uint8Array<ArrayBufferLike> = eligible;
    for (let pass = 0; pass < this.mergeRadius; pass++) {
      connected = dilate(connected, width, height);
    }

    const blobs = findBlobs(connected, eligible, width, height);
    const minArea = this.minBlobAreaRatio * n;
    const maxArea = this.maxBlobAreaRatio * n;

    const detections: VehicleDetection[] = [];
    for (const blob of blobs) {
      if (blob.area < minArea || blob.area > maxArea) continue;
      const boxWidth = blob.maxX - blob.minX + 1;
      const boxHeight = blob.maxY - blob.minY + 1;
      // How much of its own bounding rectangle the blob actually fills - a
      // solid, compact region (a vehicle) scores near 1; a scattered,
      // noisy one scores low. Reported as `confidence` for informational
      // value only (nothing filters on it) since there's no calibrated
      // model score to report instead.
      const fillRatio = blob.area / (boxWidth * boxHeight);
      detections.push({
        class: 'vehicle',
        confidence: Math.min(0.95, Math.max(0.3, fillRatio)),
        box: {
          x: blob.minX / width,
          y: blob.minY / height,
          width: boxWidth / width,
          height: boxHeight / height,
        },
      });
    }

    return detections;
  }
}

/** One binary-dilation pass: a pixel becomes eligible if it or any of its 8 neighbors already is. */
function dilate(mask: Uint8Array<ArrayBufferLike>, width: number, height: number): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx]) {
        out[idx] = 1;
        continue;
      }
      let found = false;
      for (let dy = -1; dy <= 1 && !found; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (mask[ny * width + nx]) {
            found = true;
            break;
          }
        }
      }
      if (found) out[idx] = 1;
    }
  }
  return out;
}

/**
 * Finds 8-connected components in `connectMask` (walked for adjacency, so
 * dilation can bridge small gaps), but accumulates each component's area
 * and bounding box only from `countMask` - the original, undilated pixels
 * - so dilation affects grouping only, never the reported size. Iterative
 * (no recursion) so it's safe at large working resolutions.
 */
function findBlobs(connectMask: Uint8Array<ArrayBufferLike>, countMask: Uint8Array<ArrayBufferLike>, width: number, height: number): Blob[] {
  const visited = new Uint8Array(connectMask.length);
  const blobs: Blob[] = [];
  const stack: number[] = [];

  for (let start = 0; start < connectMask.length; start++) {
    if (!connectMask[start] || visited[start]) continue;

    stack.push(start);
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let area = 0;

    while (stack.length > 0) {
      const idx = stack.pop()!;
      const x = idx % width;
      const y = (idx / width) | 0;
      if (countMask[idx]) {
        area += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const nIdx = ny * width + nx;
          if (connectMask[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            stack.push(nIdx);
          }
        }
      }
    }

    // A component built entirely from dilation halo, with no original pixel
    // of its own, contributes nothing to count or draw - shouldn't occur
    // since dilation only ever grows outward from an original pixel, but
    // guarding avoids ever emitting a degenerate (width/height -1) box.
    if (area > 0) blobs.push({ minX, minY, maxX, maxY, area });
  }

  return blobs;
}
