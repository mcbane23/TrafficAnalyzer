import sharp from 'sharp';
import { BoundingBox } from '../types/analysis';

/**
 * A function that estimates a best-effort dominant color for a cropped
 * region of a frame. Kept as a narrow, injectable seam for symmetry with
 * the other analysis modules, though (per the PRD) this module is
 * cosmetic/low-risk and intentionally not unit tested.
 */
export type ColorEstimatorFn = (frameBuffer: Buffer, box: BoundingBox) => Promise<string>;

interface NamedColor {
  name: string;
  r: number;
  g: number;
  b: number;
}

/** A small, deliberately coarse palette of colors typical for vehicles. */
const PALETTE: readonly NamedColor[] = [
  { name: 'black', r: 20, g: 20, b: 20 },
  { name: 'white', r: 235, g: 235, b: 235 },
  { name: 'gray', r: 128, g: 128, b: 128 },
  { name: 'silver', r: 192, g: 192, b: 196 },
  { name: 'red', r: 190, g: 40, b: 40 },
  { name: 'blue', r: 40, g: 70, b: 180 },
  { name: 'green', r: 40, g: 120, b: 60 },
  { name: 'yellow', r: 220, g: 200, b: 40 },
  { name: 'orange', r: 220, g: 120, b: 40 },
  { name: 'brown', r: 100, g: 65, b: 40 },
];

async function defaultEstimate(frameBuffer: Buffer, box: BoundingBox): Promise<string> {
  const image = sharp(frameBuffer);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) return 'unknown';

  const left = Math.min(width - 1, Math.max(0, Math.floor(box.x * width)));
  const top = Math.min(height - 1, Math.max(0, Math.floor(box.y * height)));
  const cropWidth = Math.max(1, Math.min(width - left, Math.round(box.width * width)));
  const cropHeight = Math.max(1, Math.min(height - top, Math.round(box.height * height)));

  const { data, info } = await image
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize(8, 8, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i + info.channels <= data.length; i += info.channels) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  }
  if (count === 0) return 'unknown';
  r /= count;
  g /= count;
  b /= count;

  let closest = PALETTE[0];
  let bestDistance = Infinity;
  for (const color of PALETTE) {
    const distance = (r - color.r) ** 2 + (g - color.g) ** 2 + (b - color.b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      closest = color;
    }
  }
  return closest.name;
}

/**
 * Best-effort dominant-color estimator for a detected vehicle's cropped
 * bounding box: crops the region, downsamples it, and matches the average
 * color against a small named palette.
 *
 * Kept separate from `VehicleDetector` so it can be tuned/swapped
 * independently of detection logic. Per the PRD, this is cosmetic and
 * low-risk, so it's intentionally not unit tested.
 */
export class VehicleColorEstimator {
  constructor(private readonly estimate: ColorEstimatorFn = defaultEstimate) {}

  async estimateColor(frameBuffer: Buffer, box: BoundingBox): Promise<string> {
    try {
      return await this.estimate(frameBuffer, box);
    } catch {
      return 'unknown';
    }
  }
}
