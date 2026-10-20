import { VideoFrame, resampleLuma } from './videoFrame';

/**
 * Extracts a downscaled 8-bit luma plane from a decoded frame. Kept as a
 * narrow, injectable seam so everything built on this model can be unit
 * tested with synthetic pixel data instead of real footage.
 */
export type LumaExtractor = (frame: VideoFrame, width: number, height: number) => Uint8Array;

/** A polygon in normalized (0-1) frame coordinates, as `[x, y]` vertices. */
export type NormalizedPolygon = Array<[number, number]>;

export interface BackgroundModelOptions {
  /** Working width the frame is reduced to before analysis. Defaults to 160. */
  width?: number;
  /** Working height the frame is reduced to before analysis. Defaults to 120. */
  height?: number;
  /** Share of each new frame folded into the background where nothing is detected. Defaults to 0.02. */
  learningRate?: number;
  /**
   * The same, for pixels currently holding something. Deliberately much
   * slower - see the note on selective update in `observe`. Defaults to a
   * tenth of `learningRate`; consumers that need a stopped object to persist
   * longer pass a slower rate still.
   */
  foregroundLearningRate?: number;
  /** Luma difference (0-255) above which a pixel counts as foreground. Defaults to 25. */
  pixelThreshold?: number;
  /** Frames that must be observed before an observation reports anything. Defaults to 20. */
  warmupFrames?: number;
  /** Lower bound of the long-run foreground rate that marks a pixel as roadway. Defaults to 0.02. */
  minActivityRate?: number;
  /** Upper bound of that rate. Defaults to 0.6. */
  maxActivityRate?: number;
  /**
   * Regions of the view that are never analyzed: anything that moves there
   * (a fountain, an LED billboard, a flag) is not traffic. Pixels inside are
   * never foreground and never roadway. Configured per camera in the
   * registry (`ignoreZones`), because what moves without being traffic is a
   * fact about one viewpoint that no general rule recovers reliably.
   */
  ignoreZones?: NormalizedPolygon[];
  /**
   * Share (0-1) of the analyzed pixels that must all read as foreground at
   * once, on `sceneChangeFrames` consecutive frames, for the model to decide
   * the camera is now looking at a different scene and relearn it from
   * scratch. Defaults to 0.6. Some cameras in the fleet pan between preset
   * views; without this, the first view change turns the whole picture into
   * "foreground", which the selective (slow) foreground rate then takes many
   * minutes to absorb, so every pixel is reported as a vehicle meanwhile.
   * A sudden global exposure jump is handled the same way, which is fine.
   */
  sceneChangeRatio?: number;
  /** See `sceneChangeRatio`. Defaults to 2. */
  sceneChangeFrames?: number;
  /** Injectable luma extractor, primarily for testing. */
  lumaExtractor?: LumaExtractor;
}

/** What one frame looked like against the model that has seen every frame before it. */
export interface BackgroundObservation {
  /** True while the model has not yet seen `warmupFrames` frames - `foreground` and `roadway` are empty until then. */
  warming: boolean;
  /** Frames folded into the model so far, including this one. */
  samples: number;
  /** Working frame width the masks below are indexed against. */
  width: number;
  /** Working frame height the masks below are indexed against. */
  height: number;
  /** Per-pixel: 1 where this frame differs from the learned background. Empty while warming. */
  foreground: Uint8Array;
  /**
   * Per-pixel: 1 where the pixel's long-run foreground rate falls inside the
   * activity band, i.e. where the model believes there is roadway. Empty
   * while warming.
   */
  roadway: Uint8Array;
  /** Count of set bits in `roadway`, precomputed since both consumers need it. */
  roadwayPixels: number;
}

const DEFAULTS = {
  width: 160,
  height: 120,
  learningRate: 0.02,
  pixelThreshold: 25,
  warmupFrames: 20,
  minActivityRate: 0.02,
  maxActivityRate: 0.6,
  sceneChangeRatio: 0.6,
  sceneChangeFrames: 2,
};

const EMPTY_MASK = new Uint8Array(0);

/**
 * BackgroundModel answers one question about one fixed camera viewpoint:
 * for this frame, which pixels hold something that isn't part of the empty
 * scene, and which pixels are roadway at all?
 *
 * These are fixed cameras, so a slowly-adapting per-pixel running average
 * converges on the empty scene, and pixels currently far from it are
 * "something is there". Two refinements make that usable on real feeds:
 *
 * - Selective adaptation. The background absorbs new frames quickly where
 *   nothing is present and far more slowly where something is. Adapting at
 *   one rate everywhere lets the background settle *between* empty asphalt
 *   and vehicle on a busy road, at which point both read as foreground, the
 *   pixel's hit rate pins to ~1.0, and it gets excluded as if it were a
 *   river - so the roads under the heaviest traffic would drop out of the
 *   measurement first, exactly backwards. The slow foreground rate still
 *   lets a genuinely parked vehicle, or a gradual lighting change, fade
 *   into the scene. During warmup that selectivity is suspended: the model
 *   is seeded from whatever the first frame happened to hold, and if that
 *   frame contained traffic, treating the real empty road as "foreground"
 *   from then on would adapt away from it at the slow rate and never
 *   recover.
 *
 * - An activity band. Only pixels whose long-run foreground rate falls
 *   inside a band count as roadway. Sky, buildings and parked scenery sit
 *   near zero and are excluded as static; rivers and wind-blown foliage sit
 *   near one and are excluded as perpetually moving. What survives is
 *   roughly the roadway - the region where things are sometimes present and
 *   sometimes not - learned per camera with no hand-drawn masks.
 *
 * Both `OccupancyEstimator` and `MotionDetector` are built on this, and
 * they ask genuinely different questions of the same observation: one
 * reduces it to a single covered/available ratio, the other groups the
 * foreground pixels into discrete blobs. They still hold *separate*
 * instances per camera, because their tuning differs in ways that matter -
 * working resolution, and critically how long a stopped vehicle keeps being
 * reported (see `foregroundLearningRate`). Sharing the code does not mean
 * sharing the model.
 *
 * One instance per camera per consumer; a background model is specific to
 * one fixed viewpoint and meaningless if shared across cameras.
 */
export class BackgroundModel {
  readonly width: number;
  readonly height: number;
  private readonly learningRate: number;
  private readonly foregroundLearningRate: number;
  private readonly pixelThreshold: number;
  private readonly warmupFrames: number;
  private readonly minActivityRate: number;
  private readonly maxActivityRate: number;
  private readonly lumaExtractor: LumaExtractor;
  private readonly sceneChangeRatio: number;
  private readonly sceneChangeFrames: number;
  /** 1 for pixels inside an ignore zone, or null when the camera has none. */
  private readonly ignored: Uint8Array | null;
  private readonly analyzedPixels: number;
  /** Consecutive frames on which nearly the whole picture read as foreground. */
  private sceneChangeStreak = 0;

  /** Per-pixel running average of the scene with transient objects averaged out. */
  private background: Float32Array | null = null;
  /** Per-pixel count of frames in which that pixel was foreground. */
  private foregroundHits: Uint32Array | null = null;
  private samples = 0;

  constructor(options: BackgroundModelOptions = {}) {
    this.width = options.width ?? DEFAULTS.width;
    this.height = options.height ?? DEFAULTS.height;
    this.learningRate = options.learningRate ?? DEFAULTS.learningRate;
    this.foregroundLearningRate = options.foregroundLearningRate ?? this.learningRate / 10;
    this.pixelThreshold = options.pixelThreshold ?? DEFAULTS.pixelThreshold;
    this.warmupFrames = options.warmupFrames ?? DEFAULTS.warmupFrames;
    this.minActivityRate = options.minActivityRate ?? DEFAULTS.minActivityRate;
    this.maxActivityRate = options.maxActivityRate ?? DEFAULTS.maxActivityRate;
    this.lumaExtractor = options.lumaExtractor ?? resampleLuma;
    this.sceneChangeRatio = options.sceneChangeRatio ?? DEFAULTS.sceneChangeRatio;
    this.sceneChangeFrames = options.sceneChangeFrames ?? DEFAULTS.sceneChangeFrames;
    const zones = options.ignoreZones ?? [];
    this.ignored = zones.length > 0 ? rasterizePolygons(zones, this.width, this.height) : null;
    let ignoredPixels = 0;
    if (this.ignored) for (const v of this.ignored) ignoredPixels += v;
    this.analyzedPixels = this.width * this.height - ignoredPixels;
  }

  /** Folds one frame into the model and reports what it looked like against everything seen before. */
  observe(frame: VideoFrame): BackgroundObservation {
    const n = this.width * this.height;
    const luma = this.lumaExtractor(frame, this.width, this.height);
    if (luma.length < n) {
      throw new Error(`Expected at least ${n} luma samples, got ${luma.length}`);
    }

    if (!this.background || !this.foregroundHits) {
      return this.seed(luma);
    }

    const bg = this.background;
    const hits = this.foregroundHits;
    const ignored = this.ignored;
    const isForeground = new Uint8Array(n);
    // See the class docstring on why selectivity is suspended during warmup.
    const warming = this.samples <= this.warmupFrames;
    let foregroundPixels = 0;

    for (let i = 0; i < n; i++) {
      const value = luma[i];
      const fg = !(ignored && ignored[i]) && Math.abs(value - bg[i]) > this.pixelThreshold ? 1 : 0;
      isForeground[i] = fg;
      if (fg) {
        hits[i] += 1;
        foregroundPixels += 1;
      }
      bg[i] += (value - bg[i]) * (fg && !warming ? this.foregroundLearningRate : this.learningRate);
    }

    if (!warming && this.analyzedPixels > 0 && foregroundPixels / this.analyzedPixels >= this.sceneChangeRatio) {
      this.sceneChangeStreak += 1;
      if (this.sceneChangeStreak >= this.sceneChangeFrames) return this.seed(luma);
    } else {
      this.sceneChangeStreak = 0;
    }

    this.samples += 1;
    if (this.samples <= this.warmupFrames) {
      return this.warmingObservation();
    }

    const roadway = new Uint8Array(n);
    let roadwayPixels = 0;
    for (let i = 0; i < n; i++) {
      if (ignored && ignored[i]) continue;
      const rate = hits[i] / this.samples;
      if (rate < this.minActivityRate || rate > this.maxActivityRate) continue;
      roadway[i] = 1;
      roadwayPixels += 1;
    }

    return {
      warming: false,
      samples: this.samples,
      width: this.width,
      height: this.height,
      foreground: isForeground,
      roadway,
      roadwayPixels,
    };
  }

  /**
   * (Re)starts the model from this frame: on the very first frame, and when
   * the view has changed (see `sceneChangeRatio`). Seeding from a real frame
   * rather than from zero means the model doesn't spend its whole warmup
   * climbing out of an all-black background that would read as total
   * occupancy. Everything learned about the old view goes, including which
   * pixels are roadway - in a different view they are different pixels.
   */
  private seed(luma: Uint8Array): BackgroundObservation {
    const n = this.width * this.height;
    this.background = Float32Array.from(luma.subarray(0, n));
    this.foregroundHits = new Uint32Array(n);
    this.samples = 1;
    this.sceneChangeStreak = 0;
    return this.warmingObservation();
  }

  private warmingObservation(): BackgroundObservation {
    return {
      warming: true,
      samples: this.samples,
      width: this.width,
      height: this.height,
      foreground: EMPTY_MASK,
      roadway: EMPTY_MASK,
      roadwayPixels: 0,
    };
  }
}

/**
 * Marks every pixel of a `width x height` grid whose centre falls inside any
 * of `polygons` (normalized coordinates, even-odd rule).
 */
export function rasterizePolygons(polygons: NormalizedPolygon[], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const polygon of polygons) {
    if (polygon.length < 3) continue;
    for (let y = 0; y < height; y++) {
      const py = (y + 0.5) / height;
      for (let x = 0; x < width; x++) {
        const px = (x + 0.5) / width;
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
          const [xi, yi] = polygon[i];
          const [xj, yj] = polygon[j];
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}
