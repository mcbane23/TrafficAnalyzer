import { RawModelDetection, VehicleClass, VehicleDetection } from '../types/analysis';
import { InferenceOptions, InferenceRunner, createOnnxInferenceRunner } from './onnxRunner';

export interface VehicleDetectorOptions {
  /** Injectable inference seam; defaults to a real ONNX Runtime session over the bundled model. */
  inferenceRunner?: InferenceRunner;
  /** Path to a custom ONNX model file. Ignored if `inferenceRunner` is supplied. */
  modelPath?: string;
  /** Minimum confidence for a detection to be surfaced. Defaults to 0.4. */
  confidenceThreshold?: number;
}

/** Per-call detection options, forwarded straight through to the underlying `InferenceRunner`. */
export type DetectOptions = InferenceOptions;

const DEFAULT_CONFIDENCE_THRESHOLD = 0.4;

/**
 * Maps COCO class ids (0-indexed, standard 80-class order) to the vehicle
 * classes this feature surfaces. Ids not present here are ignored - they
 * aren't road vehicles.
 *
 * Class 6 ("train") has no dedicated tram equivalent in COCO, so it's used
 * as a stand-in for Belgrade's tram network - an accepted approximation,
 * not a bug (see docs/prd/vehicle-traffic-analysis.md). Classes 1
 * ("bicycle") and 3 ("motorcycle") are combined into a single
 * "motorcycle" bucket, displayed as "Motorcycle/Bicycle" in the UI.
 */
export const COCO_TO_VEHICLE_CLASS: Readonly<Record<number, VehicleClass>> = {
  1: 'motorcycle',
  2: 'car',
  3: 'motorcycle',
  5: 'bus',
  6: 'tram',
  7: 'truck',
};

/**
 * VehicleDetector wraps the underlying object-detection model behind a
 * narrow interface: a decoded frame in, a list of vehicle detections out.
 *
 * The actual inference call is an injectable seam (`InferenceRunner`), so
 * this module's own logic - confidence filtering and COCO-class-id to
 * vehicle-class mapping - can be unit tested with canned raw detections,
 * without loading a real model.
 */
export class VehicleDetector {
  private readonly inferenceRunner: InferenceRunner;
  private readonly confidenceThreshold: number;

  constructor(options: VehicleDetectorOptions = {}) {
    this.confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.inferenceRunner = options.inferenceRunner ?? createOnnxInferenceRunner(options.modelPath);
  }

  async detect(frameBuffer: Buffer, options?: DetectOptions): Promise<VehicleDetection[]> {
    const rawDetections = await this.inferenceRunner(frameBuffer, options);
    const detections: VehicleDetection[] = [];

    for (const raw of rawDetections) {
      if (raw.confidence < this.confidenceThreshold) continue;

      const vehicleClass = this.mapClass(raw);
      if (!vehicleClass) continue;

      detections.push({ class: vehicleClass, confidence: raw.confidence, box: raw.box });
    }

    return detections;
  }

  private mapClass(raw: RawModelDetection): VehicleClass | undefined {
    return COCO_TO_VEHICLE_CLASS[raw.classId];
  }
}
