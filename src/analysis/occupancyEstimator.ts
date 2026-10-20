import { BackgroundModel, LumaExtractor } from './backgroundModel';
import { VideoFrame } from './videoFrame';

export type { LumaExtractor };

export interface OccupancyEstimatorOptions {
  /** Working width the frame is reduced to before analysis. Defaults to 160. */
  width?: number;
  /** Working height the frame is reduced to before analysis. Defaults to 120. */
  height?: number;
  /** Share of each new frame folded into the background model where nothing is detected. Defaults to 0.02. */
  learningRate?: number;
  /**
   * The same, for pixels currently holding something. Deliberately much
   * slower - see `BackgroundModel`. Defaults to a tenth of `learningRate`.
   */
  foregroundLearningRate?: number;
  /** Luma difference (0-255) above which a pixel counts as foreground. Defaults to 25. */
  pixelThreshold?: number;
  /** Frames that must be observed before an estimate is reported. Defaults to 20. */
  warmupFrames?: number;
  /** Lower bound of the long-run foreground rate that marks a pixel as roadway. Defaults to 0.02. */
  minActivityRate?: number;
  /** Upper bound of that rate. Defaults to 0.6. */
  maxActivityRate?: number;
  /** Injectable luma extractor, primarily for testing. */
  lumaExtractor?: LumaExtractor;
}

export interface OccupancyResult {
  /**
   * Share (0-1) of the learned roadway region currently covered by
   * foreground, or null while still warming up.
   */
  occupancy: number | null;
  /** Frames folded into the model so far. */
  samples: number;
  /** Pixels currently classified as roadway. Small values mean the region hasn't settled. */
  activePixels: number;
}

/**
 * Minimum share of the working frame that must qualify as roadway before an
 * occupancy figure means anything. Below this it's usually a scene that
 * hasn't shown any traffic yet, so nothing has qualified.
 */
const MIN_ROADWAY_SHARE = 0.01;

/**
 * OccupancyEstimator answers "how much of this road is covered by
 * vehicles right now" without detecting, classifying, or counting any of
 * them.
 *
 * That question is the one the Light/Moderate/Heavy badge actually asks,
 * and it is a far easier question than the one the detector answers. A
 * vehicle 12 px wide at the far end of a bridge is invisible to a detector
 * but still perfectly visible as pixels that stopped looking like empty
 * asphalt - so occupancy stays meaningful exactly where counting degrades
 * worst.
 *
 * Everything about learning what the empty scene looks like, and which
 * pixels are roadway at all, lives in `BackgroundModel`. This module is
 * the one thing that isn't shared with `MotionDetector`: reducing an
 * observation to a single ratio over the roadway region, which is what
 * makes the result comparable across cameras with completely different
 * framing and resolution.
 *
 * One instance per camera; the background model is specific to one fixed
 * viewpoint and meaningless if shared.
 */
export class OccupancyEstimator {
  private readonly model: BackgroundModel;

  constructor(options: OccupancyEstimatorOptions = {}) {
    this.model = new BackgroundModel(options);
  }

  /** Folds one frame into the model and reports the current occupancy. */
  async update(frame: VideoFrame): Promise<OccupancyResult> {
    const observation = this.model.observe(frame);
    if (observation.warming) {
      return { occupancy: null, samples: observation.samples, activePixels: 0 };
    }

    const { foreground, roadway, roadwayPixels } = observation;
    const total = observation.width * observation.height;

    // Too small a region to say anything about.
    if (roadwayPixels < total * MIN_ROADWAY_SHARE) {
      return { occupancy: null, samples: observation.samples, activePixels: roadwayPixels };
    }

    let covered = 0;
    for (let i = 0; i < total; i++) {
      if (roadway[i] && foreground[i]) covered += 1;
    }

    return { occupancy: covered / roadwayPixels, samples: observation.samples, activePixels: roadwayPixels };
  }
}
