import path from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { RawModelDetection } from '../types/analysis';

/**
 * A function that runs vehicle detection inference against a decoded frame
 * and returns raw model detections (COCO class id + confidence + box).
 * Kept as a narrow, injectable seam so `VehicleDetector` can be unit
 * tested with canned detections, without loading a real ONNX model.
 */
export type InferenceRunner = (frameBuffer: Buffer, options?: InferenceOptions) => Promise<RawModelDetection[]>;

export interface InferenceOptions {
  /**
   * Skips the multi-tile grid and runs a single full-frame inference pass
   * instead, trading recall on small/distant vehicles for a much cheaper
   * pass. Intended for the boosted per-camera "live" tick rate (~2fps),
   * where responsiveness matters more than exhaustive detection - the
   * lower-frequency background tick (used for the dashboard/history) keeps
   * full tiling for best recall.
   */
  fastMode?: boolean;
}

/** Path to the bundled YOLOv8n (COCO-pretrained) ONNX model shipped in the repo/build output. */
export const BUNDLED_MODEL_PATH = path.resolve(__dirname, '../../models/yolov8n.onnx');

const MODEL_INPUT_SIZE = 640;
const NUM_COCO_CLASSES = 80;
/** Pre-NMS confidence floor. VehicleDetector applies its own (higher, configurable) threshold on top of this. */
const RAW_CONFIDENCE_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.45;

/**
 * Cameras with a native resolution well above the model's 640x640 input
 * get heavily downscaled by a single full-frame pass, shrinking distant/
 * small vehicles below what a nano model can reliably detect - this is
 * the main cause of severe undercounting on busy, higher-resolution wide
 * shots (e.g. a scene with 30+ cars showing up as 1 detection). Splitting
 * such frames into overlapping tiles and running inference on each tile
 * at full model resolution keeps small vehicles comparatively larger in
 * each inference pass, substantially improving recall. Lower-resolution
 * cameras (already close to or below the model's input size) skip tiling
 * entirely - it wouldn't add real detail and would only cost extra
 * inference time.
 */
const TILING_MIN_DIMENSION = 960;
const MAX_TILE_COLS = 3;
const MAX_TILE_ROWS = 2;
const TILE_OVERLAP_RATIO = 0.2;

interface TileRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}


let cachedSession: Promise<ort.InferenceSession> | null = null;
let cachedSessionPath: string | null = null;

function getSession(modelPath: string): Promise<ort.InferenceSession> {
  if (!cachedSession || cachedSessionPath !== modelPath) {
    cachedSessionPath = modelPath;
    cachedSession = ort.InferenceSession.create(modelPath);
  }
  return cachedSession;
}

interface PreprocessResult {
  tensorData: Float32Array;
  scale: number;
  padX: number;
  padY: number;
  origWidth: number;
  origHeight: number;
}

interface Candidate {
  classId: number;
  confidence: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Creates the default (real) inference runner: a YOLOv8 ONNX Runtime
 * session over the bundled model, wired end-to-end with letterbox
 * preprocessing (via sharp) and non-max-suppression postprocessing.
 *
 * This is intentionally NOT unit tested directly - matching this
 * project's existing practice of not asserting on ffmpeg/ONNX Runtime
 * internals (see CameraValidator/probeRunner). `VehicleDetector`'s tests
 * inject a fake `InferenceRunner` instead.
 */
export function createOnnxInferenceRunner(modelPath: string = BUNDLED_MODEL_PATH): InferenceRunner {
  return async (frameBuffer: Buffer, options?: InferenceOptions): Promise<RawModelDetection[]> => {
    const session = await getSession(modelPath);

    // Decode the frame to raw pixels exactly once per tick. Every tile
    // below crops and resizes directly from this raw buffer instead of
    // re-decoding the original JPEG per tile - previously each tile
    // round-tripped through a JPEG re-encode (in `.extract().toBuffer()`)
    // followed by a fresh JPEG decode inside preprocessing, which was pure
    // wasted CPU repeated once per tile (up to 6x per frame).
    const { data: rawFrame, info } = await sharp(frameBuffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const origWidth = info.width;
    const origHeight = info.height;
    const channels = info.channels as 1 | 2 | 3 | 4;
    const tiles = computeTiles(origWidth, origHeight, options?.fastMode);

    const allCandidates: Candidate[] = [];
    for (const tile of tiles) {
      const pre = await preprocessTile(rawFrame, origWidth, origHeight, channels, tile);
      const feeds: Record<string, ort.Tensor> = {
        [session.inputNames[0]]: new ort.Tensor('float32', pre.tensorData, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]),
      };
      const results = await session.run(feeds);
      const output = results[session.outputNames[0]];
      const tileCandidates = extractCandidates(output.data as Float32Array, output.dims as unknown as number[], pre);

      // Candidates are in tile-local pixel space; offset by the tile's
      // position so every candidate ends up in shared full-frame pixel space.
      for (const c of tileCandidates) {
        allCandidates.push({
          classId: c.classId,
          confidence: c.confidence,
          x1: c.x1 + tile.x,
          y1: c.y1 + tile.y,
          x2: c.x2 + tile.x,
          y2: c.y2 + tile.y,
        });
      }
    }

    return finalizeDetections(allCandidates, origWidth, origHeight);
  };
}

/** Computes the grid of (possibly overlapping) pixel regions to run inference on separately. Returns a single full-frame region for images not much larger than the model's input size, or when `fastMode` is requested (skips tiling entirely regardless of frame size). */
function computeTiles(width: number, height: number, fastMode?: boolean): TileRegion[] {
  if (fastMode || (width <= TILING_MIN_DIMENSION && height <= TILING_MIN_DIMENSION)) {
    return [{ x: 0, y: 0, width, height }];
  }

  const cols = Math.min(MAX_TILE_COLS, Math.max(1, Math.round(width / MODEL_INPUT_SIZE)));
  const rows = Math.min(MAX_TILE_ROWS, Math.max(1, Math.round(height / MODEL_INPUT_SIZE)));
  const stepX = width / cols;
  const stepY = height / rows;
  const overlapX = stepX * TILE_OVERLAP_RATIO;
  const overlapY = stepY * TILE_OVERLAP_RATIO;

  const tiles: TileRegion[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const left = Math.max(0, Math.round(col * stepX - overlapX));
      const top = Math.max(0, Math.round(row * stepY - overlapY));
      const right = Math.min(width, Math.round((col + 1) * stepX + overlapX));
      const bottom = Math.min(height, Math.round((row + 1) * stepY + overlapY));
      tiles.push({ x: left, y: top, width: right - left, height: bottom - top });
    }
  }
  return tiles;
}


/**
 * Crops (when the tile isn't the whole frame) and letterbox-resizes a
 * single tile directly from an already-decoded raw RGB frame buffer - no
 * JPEG encode/decode involved, just cheap raw pixel operations.
 */
async function preprocessTile(
  rawFrame: Buffer,
  frameWidth: number,
  frameHeight: number,
  channels: 1 | 2 | 3 | 4,
  tile: TileRegion,
): Promise<PreprocessResult> {
  const scale = Math.min(MODEL_INPUT_SIZE / tile.width, MODEL_INPUT_SIZE / tile.height);
  const newWidth = Math.max(1, Math.round(tile.width * scale));
  const newHeight = Math.max(1, Math.round(tile.height * scale));
  const padX = Math.floor((MODEL_INPUT_SIZE - newWidth) / 2);
  const padY = Math.floor((MODEL_INPUT_SIZE - newHeight) / 2);

  const isFullTile = tile.x === 0 && tile.y === 0 && tile.width === frameWidth && tile.height === frameHeight;
  let pipeline = sharp(rawFrame, { raw: { width: frameWidth, height: frameHeight, channels } });
  if (!isFullTile) {
    pipeline = pipeline.extract({ left: tile.x, top: tile.y, width: tile.width, height: tile.height });
  }
  const resized = await pipeline.resize(newWidth, newHeight, { fit: 'fill' }).raw().toBuffer();

  // Letterbox: pad to a square MODEL_INPUT_SIZE canvas with mid-grey (114), matching YOLO's standard preprocessing.
  const padded = new Uint8ClampedArray(MODEL_INPUT_SIZE * MODEL_INPUT_SIZE * 3).fill(114);
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const srcIdx = (y * newWidth + x) * 3;
      const dstIdx = ((y + padY) * MODEL_INPUT_SIZE + (x + padX)) * 3;
      padded[dstIdx] = resized[srcIdx];
      padded[dstIdx + 1] = resized[srcIdx + 1];
      padded[dstIdx + 2] = resized[srcIdx + 2];
    }
  }

  // CHW, normalized 0..1 - the input layout onnxruntime-node expects for this model export.
  const planeSize = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const tensorData = new Float32Array(3 * planeSize);
  for (let i = 0; i < planeSize; i++) {
    tensorData[i] = padded[i * 3] / 255;
    tensorData[planeSize + i] = padded[i * 3 + 1] / 255;
    tensorData[2 * planeSize + i] = padded[i * 3 + 2] / 255;
  }

  return { tensorData, scale, padX, padY, origWidth: tile.width, origHeight: tile.height };
}

/** Extracts above-floor candidate boxes for a single (tile or full-frame) inference pass, in that pass's own pixel space, with per-tile NMS already applied to cut down volume before cross-tile merging. */
function extractCandidates(data: Float32Array, dims: number[], ctx: PreprocessResult): Candidate[] {
  const numAttrs = dims[1];
  const numBoxes = dims[2];
  const numClasses = Math.min(numAttrs - 4, NUM_COCO_CLASSES);

  const candidates: Candidate[] = [];

  for (let i = 0; i < numBoxes; i++) {
    let bestClass = -1;
    let bestScore = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = data[(4 + c) * numBoxes + i];
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestScore < RAW_CONFIDENCE_THRESHOLD) continue;

    const cx = data[0 * numBoxes + i];
    const cy = data[1 * numBoxes + i];
    const w = data[2 * numBoxes + i];
    const h = data[3 * numBoxes + i];

    candidates.push({
      classId: bestClass,
      confidence: bestScore,
      x1: (cx - w / 2 - ctx.padX) / ctx.scale,
      y1: (cy - h / 2 - ctx.padY) / ctx.scale,
      x2: (cx + w / 2 - ctx.padX) / ctx.scale,
      y2: (cy + h / 2 - ctx.padY) / ctx.scale,
    });
  }

  return nonMaxSuppression(candidates);
}

/** Runs a final cross-tile NMS pass (to dedupe vehicles detected in more than one overlapping tile) and normalizes/clamps to the full frame. */
function finalizeDetections(candidates: Candidate[], origWidth: number, origHeight: number): RawModelDetection[] {
  return nonMaxSuppression(candidates).map((c) => {
    const x1 = clamp(c.x1, 0, origWidth);
    const y1 = clamp(c.y1, 0, origHeight);
    const x2 = clamp(c.x2, 0, origWidth);
    const y2 = clamp(c.y2, 0, origHeight);
    return {
      classId: c.classId,
      confidence: c.confidence,
      box: {
        x: x1 / origWidth,
        y: y1 / origHeight,
        width: (x2 - x1) / origWidth,
        height: (y2 - y1) / origHeight,
      },
    };
  });
}

function nonMaxSuppression(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const kept: Candidate[] = [];
  for (const candidate of sorted) {
    const overlaps = kept.some((k) => k.classId === candidate.classId && iou(k, candidate) > IOU_THRESHOLD);
    if (!overlaps) kept.push(candidate);
  }
  return kept;
}

function iou(a: Candidate, b: Candidate): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
