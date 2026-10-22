import path from 'node:path';
import { BoundingBox, VehicleClass, VehicleDetection } from '../types/analysis';
import { NormalizedPolygon, rasterizePolygons } from './backgroundModel';
import { DetectionResult } from './motionDetector';
import { VideoFrame } from './videoFrame';

/**
 * One inference call against a YOLO-family detector exported to ONNX with a
 * fixed `width x height` RGB input. Kept as a narrow, injectable seam so
 * pre- and post-processing can be unit tested with synthetic tensors,
 * without loading the real model.
 */
export interface YoloSession {
  /** `input` is NCHW float32 RGB in 0-1, shape `[1, 3, height, width]`. Returns the raw `[1, 4 + classes, anchors]` output. */
  run(input: Float32Array, width: number, height: number): Promise<{ data: Float32Array; dims: readonly number[] }>;
}

/**
 * The CPU models `OVERLAY_CPU_MODEL` can pick, ONNX with a 640x480 input (the
 * overlay capture's size, so no letterbox padding) and `[1, 84, anchors]`
 * output, run on onnxruntime. Only YOLO26n for now.
 */
export const ONNX_MODELS: Readonly<Record<string, { path: string; label: string }>> = {
  yolo26n: { path: path.resolve(__dirname, '../../models/yolo26n.onnx'), label: 'YOLO26n' },
};
const DEFAULT_ONNX_MODEL = 'yolo26n';

/**
 * The GPU models `OVERLAY_MODEL` can pick, OpenVINO IR, all FP16 with the
 * same 960x736 input and `[1, 84, anchors]` output. On six camera frames
 * (960px, confidence 0.25, OpenVINO CPU) YOLO26s found 98 vehicles in 139 ms
 * per frame and YOLO26n 77 in 59 ms; on Brankov most at rush hour YOLO26m
 * found no more than YOLO26s at ~3x the time. YOLO26s is the default: Bane
 * found it worked very well live on the N150, missing mostly motorcycles and
 * distant cars.
 */
export const OPENVINO_MODELS: Readonly<Record<string, { path: string; label: string }>> = {
  yolo26s: { path: path.resolve(__dirname, '../../models/yolo26s-openvino/yolo26s.xml'), label: 'YOLO26s' },
  yolo26n: { path: path.resolve(__dirname, '../../models/yolo26n-openvino/yolo26n.xml'), label: 'YOLO26n' },
  yolo26m: { path: path.resolve(__dirname, '../../models/yolo26m-openvino/yolo26m.xml'), label: 'YOLO26m' },
};
export const DEFAULT_OPENVINO_MODEL = 'yolo26s';

/** `catalog[name]`, or the default entry with a warning when the name is unknown. */
function pickModel(
  catalog: Readonly<Record<string, { path: string; label: string }>>,
  name: string | undefined,
  fallback: string,
): { path: string; label: string } {
  const requested = name?.trim().toLowerCase() || fallback;
  const model = catalog[requested];
  if (model) return model;
  console.warn(`[YoloDetector] Unknown model "${requested}" (expected ${Object.keys(catalog).join(', ')}), using ${fallback}`);
  return catalog[fallback];
}

/** A loaded detector model: how to run it, and the input size it was exported with. */
export interface YoloModel {
  session: YoloSession;
  inputWidth: number;
  inputHeight: number;
  /** What runs where, for the logs - e.g. "YOLO26s on OpenVINO GPU". */
  label: string;
}

export interface LoadYoloModelOptions {
  /**
   * OpenVINO device to run the larger model on (e.g. "GPU"), or undefined /
   * "CPU" for the CPU model on onnxruntime. A device that fails to load (no
   * /dev/dri in the container, no driver) falls back to the CPU model.
   */
  device?: string;
  /** Which of `OPENVINO_MODELS` to run on that device. Defaults to yolo26s; an unknown name falls back to it with a warning. */
  model?: string;
  /** Which of `ONNX_MODELS` to run on the CPU, by choice or as the GPU's fallback. Defaults to yolo26n. */
  cpuModel?: string;
  /** onnxruntime threads for the CPU model. Defaults to 2. */
  threads?: number;
  /** OpenVINO compiled-model cache, so a restart doesn't recompile for the GPU (tens of seconds). */
  cacheDir?: string;
}

export interface YoloModelLoaders {
  openVino: (modelPath: string, device: string, cacheDir?: string) => Promise<YoloSession>;
  onnx: (modelPath: string, threads: number) => Promise<YoloSession>;
}

/**
 * Loads the overlay's detector: `model` (YOLO26s by default) through
 * OpenVINO on `device` when one is asked for, else - or when that fails -
 * `cpuModel` (YOLO26n by default) on the CPU.
 */
export async function loadYoloModel(
  options: LoadYoloModelOptions = {},
  loaders: YoloModelLoaders = { openVino: createOpenVinoYoloSession, onnx: createOnnxYoloSession },
): Promise<YoloModel> {
  const device = options.device?.trim().toUpperCase();
  const cpuModel = pickModel(ONNX_MODELS, options.cpuModel, DEFAULT_ONNX_MODEL);
  if (device && device !== 'CPU') {
    const model = pickModel(OPENVINO_MODELS, options.model, DEFAULT_OPENVINO_MODEL);
    try {
      const session = await loaders.openVino(model.path, device, options.cacheDir);
      return { session, inputWidth: 960, inputHeight: 736, label: `${model.label} on OpenVINO ${device}` };
    } catch (err) {
      console.warn(
        `[YoloDetector] OpenVINO device ${device} unavailable, using ${cpuModel.label} on the CPU: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const session = await loaders.onnx(cpuModel.path, options.threads ?? 2);
  return { session, inputWidth: 640, inputHeight: 480, label: `${cpuModel.label} on CPU` };
}

/**
 * Opens an onnxruntime CPU session over a YOLO ONNX model. `onnxruntime-node`
 * is loaded lazily, so nothing that merely imports this module pays for it.
 */
export async function createOnnxYoloSession(modelPath: string = ONNX_MODELS[DEFAULT_ONNX_MODEL].path, threads = 2): Promise<YoloSession> {
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(modelPath, {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionProviders: ['cpu'],
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  return {
    run: async (input, width, height) => {
      const outputs = await session.run({ [inputName]: new ort.Tensor('float32', input, [1, 3, height, width]) });
      const output = outputs[outputName];
      return { data: output.data as Float32Array, dims: output.dims };
    },
  };
}

/**
 * Compiles an OpenVINO IR (or ONNX) YOLO model for `device`. `openvino-node`
 * is loaded lazily, like onnxruntime. Inference is serialized on one infer
 * request: the GPU runs one frame at a time anyway, and an infer request
 * can't be reused while busy.
 */
export async function createOpenVinoYoloSession(modelPath: string, device: string, cacheDir?: string): Promise<YoloSession> {
  const { addon: ov } = await import('openvino-node');
  const core = new ov.Core();
  const compiled = await core.compileModel(modelPath, device, {
    PERFORMANCE_HINT: 'LATENCY',
    ...(cacheDir ? { CACHE_DIR: cacheDir } : {}),
  });
  const request = compiled.createInferRequest();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    run: (input, width, height) => {
      const result = queue.then(async () => {
        const outputs = await request.inferAsync([new ov.Tensor(ov.element.f32, [1, 3, height, width], input)]);
        const output = Object.values(outputs)[0];
        // Copied: the request's output buffer is overwritten by the next frame.
        return { data: new Float32Array(output.data as Float32Array), dims: output.getShape() };
      });
      queue = result.catch(() => undefined);
      return result;
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
  /**
   * Class score below which a candidate is discarded. Defaults to 0.2: below
   * the usual 0.25, because on these small, compressed cars that drew about
   * half as many boxes again for only a few false ones (Bane tried 0.15 and
   * 0.20 live). A function is asked on every frame, so the Admin page's
   * setting applies without rebuilding the detector.
   */
  minConfidence?: number | (() => number);
  /** Overlap (IoU) above which the weaker of two boxes is suppressed. Defaults to 0.5. */
  iouThreshold?: number;
  /** Parts of the view whose detections are dropped (box centre inside) - the same zones the motion detector ignores. */
  ignoreZones?: NormalizedPolygon[];
}

export const DEFAULT_MIN_CONFIDENCE = 0.2;

const DEFAULTS = {
  minConfidence: DEFAULT_MIN_CONFIDENCE,
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
 * vehicles on wide views, which a 640px input shrinks below what a nano
 * model can see - hence the larger model when a GPU is available.
 *
 * It needs no warm-up and holds no per-camera state, so `warmingUp` is
 * always false. The model is asked for on every frame rather than passed
 * in, so it can be loaded (and the CPU-or-GPU choice made) only once
 * someone actually watches a camera; the caller caches it.
 */
export class YoloDetector {
  private readonly minConfidence: () => number;
  private readonly iouThreshold: number;
  private readonly ignored: Uint8Array | null;

  constructor(
    private readonly model: () => Promise<YoloModel>,
    options: YoloDetectorOptions = {},
  ) {
    const minConfidence = options.minConfidence ?? DEFAULTS.minConfidence;
    this.minConfidence = typeof minConfidence === 'function' ? minConfidence : () => minConfidence;
    this.iouThreshold = options.iouThreshold ?? DEFAULTS.iouThreshold;
    const zones = options.ignoreZones ?? [];
    this.ignored = zones.length > 0 ? rasterizePolygons(zones, ZONE_GRID, ZONE_GRID) : null;
  }

  async detect(frame: VideoFrame): Promise<DetectionResult> {
    const { session, inputWidth, inputHeight } = await this.model();
    const letterbox = letterboxToTensor(frame, inputWidth, inputHeight);
    const output = await session.run(letterbox.tensor, inputWidth, inputHeight);
    const detections = decodeYoloOutput(output.data, output.dims, {
      ...letterbox,
      frameWidth: frame.width,
      frameHeight: frame.height,
      minConfidence: this.minConfidence(),
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
  /** NCHW float32 RGB, 0-1, `width x height`. */
  tensor: Float32Array;
  /** Model-input pixels per frame pixel. */
  scale: number;
}

/**
 * Converts a `yuv420p` frame to the model's input: scaled (nearest
 * neighbour) to fit `inputWidth x inputHeight` with its aspect ratio kept,
 * anchored top left, the rest padded grey as YOLO was trained with. BT.601
 * limited-range conversion, which is what these camera encoders emit.
 */
export function letterboxToTensor(frame: VideoFrame, inputWidth: number, inputHeight: number = inputWidth): Letterbox {
  const { width, height, data } = frame;
  const scale = Math.min(inputWidth / width, inputHeight / height);
  const outW = Math.min(inputWidth, Math.round(width * scale));
  const outH = Math.min(inputHeight, Math.round(height * scale));
  const plane = inputWidth * inputHeight;
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
      const i = y * inputWidth + x;
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
