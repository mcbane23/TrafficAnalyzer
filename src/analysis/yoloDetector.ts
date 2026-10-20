import path from 'node:path';
import { BoundingBox, VehicleClass, VehicleDetection } from '../types/analysis';
import { NormalizedPolygon, rasterizePolygons } from './backgroundModel';
import { DetectionResult } from './motionDetector';
import { VideoFrame } from './videoFrame';

/**
 * One inference call against a YOLO-family detector exported to ONNX with a
 * square `size x size` RGB input. Kept as a narrow, injectable seam so
 * pre- and post-processing can be unit tested with synthetic tensors,
 * without loading the real model.
 */
export interface YoloSession {
  /** `input` is NCHW float32 RGB in 0-1, shape `[1, 3, size, size]`. Returns the raw `[1, 4 + classes, anchors]` output. */
  run(input: Float32Array, size: number): Promise<{ data: Float32Array; dims: readonly number[] }>;
}

/** Path to the bundled YOLO11n (COCO-pretrained, 640x640 input) ONNX model. */
export const BUNDLED_YOLO_MODEL_PATH = path.resolve(__dirname, '../../models/yolo11n.onnx');

/**
 * Opens an onnxruntime CPU session over a YOLO ONNX model. `onnxruntime-node`
 * is loaded lazily, so nothing that merely imports this module pays for it.
 */
export async function createOnnxYoloSession(modelPath: string = BUNDLED_YOLO_MODEL_PATH, threads = 2): Promise<YoloSession> {
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(modelPath, {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionProviders: ['cpu'],
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  return {
    run: async (input, size) => {
      const outputs = await session.run({ [inputName]: new ort.Tensor('float32', input, [1, 3, size, size]) });
      const output = outputs[outputName];
      return { data: output.data as Float32Array, dims: output.dims };
    },
  };
}

/** COCO class ids this detector reports, and what they are reported as. Trams come out of COCO models as "train". */
const COCO_VEHICLES: ReadonlyMap<number, VehicleClass> = new Map<number, VehicleClass>([
  [2, 'car'],
  [3, 'motorcycle'],
  [5, 'bus'],
  [6, 'bus'],
  [7, 'truck'],
]);

export interface YoloDetectorOptions {
  /** Model input side, in pixels. Must match the exported model. Defaults to 640. */
  inputSize?: number;
  /** Class score below which a candidate is discarded. Defaults to 0.3. */
  minConfidence?: number;
  /** Overlap (IoU) above which the weaker of two boxes is suppressed. Defaults to 0.5. */
  iouThreshold?: number;
  /** Parts of the view whose detections are dropped (box centre inside) - the same zones the motion detector ignores. */
  ignoreZones?: NormalizedPolygon[];
}

const DEFAULTS = {
  inputSize: 640,
  minConfidence: 0.3,
  iouThreshold: 0.5,
};

/** Resolution of the grid ignore zones are rasterized onto for the centre-in-zone test. */
const ZONE_GRID = 200;

/**
 * YoloDetector finds vehicles by appearance with a COCO-trained YOLO model -
 * the counterpart to `MotionDetector`, which finds anything that moves.
 *
 * Running it on the whole fleet would cost several cores (see
 * `LiveOverlayService`), so it only drives the boxes drawn over the camera a
 * viewer is watching; statistics stay on motion detection. Where it wins is
 * exactly where motion detection fails on this fleet: a fountain or a
 * billboard is not a vehicle whatever it does, and a queue of cars is several
 * boxes rather than one merged blob. Where it loses is small, distant
 * vehicles on wide views, which the 640px input shrinks below what a nano
 * model can see.
 *
 * It needs no warm-up and holds no per-camera state, so `warmingUp` is
 * always false.
 */
export class YoloDetector {
  private readonly inputSize: number;
  private readonly minConfidence: number;
  private readonly iouThreshold: number;
  private readonly ignored: Uint8Array | null;

  constructor(
    private readonly session: YoloSession,
    options: YoloDetectorOptions = {},
  ) {
    this.inputSize = options.inputSize ?? DEFAULTS.inputSize;
    this.minConfidence = options.minConfidence ?? DEFAULTS.minConfidence;
    this.iouThreshold = options.iouThreshold ?? DEFAULTS.iouThreshold;
    const zones = options.ignoreZones ?? [];
    this.ignored = zones.length > 0 ? rasterizePolygons(zones, ZONE_GRID, ZONE_GRID) : null;
  }

  async detect(frame: VideoFrame): Promise<DetectionResult> {
    const letterbox = letterboxToTensor(frame, this.inputSize);
    const output = await this.session.run(letterbox.tensor, this.inputSize);
    const detections = decodeYoloOutput(output.data, output.dims, {
      ...letterbox,
      frameWidth: frame.width,
      frameHeight: frame.height,
      minConfidence: this.minConfidence,
      iouThreshold: this.iouThreshold,
    }).filter((d) => !this.isIgnored(d.box));
    return { detections, warmingUp: false };
  }

  private isIgnored(box: BoundingBox): boolean {
    if (!this.ignored) return false;
    const cx = Math.min(ZONE_GRID - 1, Math.max(0, Math.floor((box.x + box.width / 2) * ZONE_GRID)));
    const cy = Math.min(ZONE_GRID - 1, Math.max(0, Math.floor((box.y + box.height / 2) * ZONE_GRID)));
    return this.ignored[cy * ZONE_GRID + cx] === 1;
  }
}

export interface Letterbox {
  /** NCHW float32 RGB, 0-1, `size x size`. */
  tensor: Float32Array;
  /** Model-input pixels per frame pixel. */
  scale: number;
}

/**
 * Converts a `yuv420p` frame to the model's input: scaled (nearest
 * neighbour) to fit `size x size` with its aspect ratio kept, anchored top
 * left, the rest padded grey as YOLO was trained with. BT.601 limited-range
 * conversion, which is what these camera encoders emit.
 */
export function letterboxToTensor(frame: VideoFrame, size: number): Letterbox {
  const { width, height, data } = frame;
  const scale = Math.min(size / width, size / height);
  const outW = Math.min(size, Math.round(width * scale));
  const outH = Math.min(size, Math.round(height * scale));
  const plane = size * size;
  const tensor = new Float32Array(3 * plane).fill(114 / 255);

  const chromaW = Math.ceil(width / 2);
  const uOffset = width * height;
  const vOffset = uOffset + chromaW * Math.ceil(height / 2);

  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    const lumaRow = sy * width;
    const chromaRow = (sy >> 1) * chromaW;
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const c = 1.164 * (data[lumaRow + sx] - 16);
      const u = data[uOffset + chromaRow + (sx >> 1)] - 128;
      const v = data[vOffset + chromaRow + (sx >> 1)] - 128;
      const i = y * size + x;
      tensor[i] = clamp01((c + 1.596 * v) / 255);
      tensor[plane + i] = clamp01((c - 0.392 * u - 0.813 * v) / 255);
      tensor[2 * plane + i] = clamp01((c + 2.017 * u) / 255);
    }
  }
  return { tensor, scale };
}

interface DecodeOptions {
  scale: number;
  frameWidth: number;
  frameHeight: number;
  minConfidence: number;
  iouThreshold: number;
}

/**
 * Turns the raw YOLOv8/YOLO11 head output (`[1, 4 + classes, anchors]`:
 * centre x, centre y, width, height in input pixels, then per-class scores)
 * into vehicle detections normalized to the source frame, after
 * class-agnostic non-maximum suppression - a car and a truck guess for the
 * same object must not become two vehicles.
 */
export function decodeYoloOutput(data: Float32Array, dims: readonly number[], options: DecodeOptions): VehicleDetection[] {
  const rows = dims[1];
  const anchors = dims[2];
  const candidates: Array<{ box: BoundingBox; confidence: number; cls: VehicleClass }> = [];

  for (let a = 0; a < anchors; a++) {
    let bestClass = -1;
    let bestScore = options.minConfidence;
    for (const classId of COCO_VEHICLES.keys()) {
      const row = 4 + classId;
      if (row >= rows) continue;
      const score = data[row * anchors + a];
      if (score > bestScore) {
        bestScore = score;
        bestClass = classId;
      }
    }
    if (bestClass < 0) continue;

    const cx = data[a] / options.scale;
    const cy = data[anchors + a] / options.scale;
    const w = data[2 * anchors + a] / options.scale;
    const h = data[3 * anchors + a] / options.scale;
    const x0 = Math.max(0, cx - w / 2);
    const y0 = Math.max(0, cy - h / 2);
    const x1 = Math.min(options.frameWidth, cx + w / 2);
    const y1 = Math.min(options.frameHeight, cy + h / 2);
    if (x1 <= x0 || y1 <= y0) continue;
    candidates.push({
      box: {
        x: x0 / options.frameWidth,
        y: y0 / options.frameHeight,
        width: (x1 - x0) / options.frameWidth,
        height: (y1 - y0) / options.frameHeight,
      },
      confidence: bestScore,
      cls: COCO_VEHICLES.get(bestClass)!,
    });
  }

  candidates.sort((p, q) => q.confidence - p.confidence);
  const kept: typeof candidates = [];
  for (const candidate of candidates) {
    if (kept.every((k) => iou(k.box, candidate.box) <= options.iouThreshold)) kept.push(candidate);
  }
  return kept.map((k) => ({ class: k.cls, confidence: k.confidence, box: k.box }));
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
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
