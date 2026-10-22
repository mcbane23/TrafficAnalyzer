import sharp from 'sharp';

/**
 * One decoded video frame as raw planar YUV 4:2:0 (ffmpeg's `yuv420p`): a
 * full-resolution luma plane followed by two quarter-size chroma planes.
 *
 * This is what `FrameGrabber` hands out instead of a JPEG. Every consumer in
 * the analysis loop only wants a small greyscale plane, and the luma plane
 * already *is* one - so the earlier round trip (ffmpeg encodes each frame to
 * JPEG, then sharp decodes that same JPEG once per background model) was
 * pure overhead, and on a fleet of ~20 cameras at 3 fps it was most of the
 * pipeline's CPU. The chroma planes are kept only so a colour thumbnail can
 * still be produced on demand (`encodeJpeg`).
 */
export interface VideoFrame {
  width: number;
  height: number;
  /** `width * height` luma bytes, then the U and V planes (each `ceil(width/2) * ceil(height/2)` bytes). */
  data: Uint8Array;
}

/** Bytes in one `yuv420p` frame of this size. */
export function yuv420pFrameSize(width: number, height: number): number {
  return width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
}

/**
 * A whole `yuv420p` frame shrunk by an integer `factor` in both directions,
 * each output sample the mean of the `factor x factor` block it covers -
 * the same area averaging ffmpeg's `scale=...:flags=area` does, so a frame
 * shrunk here matches one ffmpeg scaled to the small size itself (see
 * `CaptureSharing`). Both dimensions, and their halves for the chroma
 * planes, must divide by `factor`.
 */
export function downscaleYuv420p(frame: VideoFrame, factor: number): VideoFrame {
  const { width, height, data } = frame;
  if (factor === 1) return frame;
  const width2 = width / 2;
  const height2 = height / 2;
  if (!Number.isInteger(width2 / factor) || !Number.isInteger(height2 / factor)) {
    throw new Error(`Cannot shrink ${width}x${height} yuv420p by ${factor}`);
  }
  const outW = width / factor;
  const outH = height / factor;
  const out = new Uint8Array(yuv420pFrameSize(outW, outH));
  const area = factor * factor;
  const shrinkPlane = (srcOffset: number, srcW: number, dstOffset: number, dstW: number, dstH: number) => {
    for (let y = 0; y < dstH; y++) {
      for (let x = 0; x < dstW; x++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          const row = srcOffset + (y * factor + dy) * srcW + x * factor;
          for (let dx = 0; dx < factor; dx++) sum += data[row + dx];
        }
        out[dstOffset + y * dstW + x] = (sum + (area >> 1)) / area;
      }
    }
  };
  shrinkPlane(0, width, 0, outW, outH);
  const chromaIn = width * height;
  const chromaOut = outW * outH;
  const chromaPlane = width2 * height2;
  shrinkPlane(chromaIn, width2, chromaOut, outW / 2, outH / 2);
  shrinkPlane(chromaIn + chromaPlane, width2, chromaOut + (outW / 2) * (outH / 2), outW / 2, outH / 2);
  return { width: outW, height: outH, data: out };
}

/**
 * The frame's luma plane reduced to `width x height` by area averaging -
 * each output pixel is the mean of the source pixels it covers, with
 * fractional weights at the edges, so non-integer ratios (320 -> 240)
 * don't alias. Returns the plane itself, uncopied, when the size already
 * matches. Callers must not mutate the result.
 */
/**
 * A whole `yuv420p` frame shrunk to `width x height` (even, and no larger
 * than the frame) by area averaging, each plane on its own - like ffmpeg's
 * `scale=...:flags=area`. A whole-number factor takes `downscaleYuv420p`'s
 * exact block means; any other ratio (704x576 to 320x240) the weighted ones
 * `resampleLuma` uses.
 */
export function resampleYuv420p(frame: VideoFrame, width: number, height: number): VideoFrame {
  const factor = frame.width / width;
  if (Number.isInteger(factor) && frame.height === height * factor && Number.isInteger(frame.width / 2 / factor) && Number.isInteger(frame.height / 2 / factor)) {
    return downscaleYuv420p(frame, factor);
  }
  const srcChromaW = Math.ceil(frame.width / 2);
  const srcChromaH = Math.ceil(frame.height / 2);
  const chromaW = Math.ceil(width / 2);
  const chromaH = Math.ceil(height / 2);
  const out = new Uint8Array(yuv420pFrameSize(width, height));
  const plane = (offset: number, w: number, h: number) => ({ width: w, height: h, data: frame.data.subarray(offset, offset + w * h) });
  out.set(resampleLuma(plane(0, frame.width, frame.height), width, height), 0);
  const uOffset = frame.width * frame.height;
  const vOffset = uOffset + srcChromaW * srcChromaH;
  out.set(resampleLuma(plane(uOffset, srcChromaW, srcChromaH), chromaW, chromaH), width * height);
  out.set(resampleLuma(plane(vOffset, srcChromaW, srcChromaH), chromaW, chromaH), width * height + chromaW * chromaH);
  return { width, height, data: out };
}

export function resampleLuma(frame: VideoFrame, width: number, height: number): Uint8Array {
  const { width: srcW, height: srcH, data } = frame;
  if (data.length < srcW * srcH) {
    throw new Error(`Expected at least ${srcW * srcH} luma samples, got ${data.length}`);
  }
  if (srcW === width && srcH === height) return data.subarray(0, srcW * srcH);

  const xWeights = areaWeights(srcW, width);
  const yWeights = areaWeights(srcH, height);

  // Separable: rows first (srcH x width), then columns (height x width).
  const rows = new Float32Array(srcH * width);
  for (let y = 0; y < srcH; y++) {
    const srcRow = y * srcW;
    const dstRow = y * width;
    for (let x = 0; x < width; x++) {
      const { start, weights } = xWeights[x];
      let sum = 0;
      for (let k = 0; k < weights.length; k++) sum += data[srcRow + start + k] * weights[k];
      rows[dstRow + x] = sum;
    }
  }

  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const { start, weights } = yWeights[y];
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = 0; k < weights.length; k++) sum += rows[(start + k) * width + x] * weights[k];
      out[y * width + x] = Math.round(sum);
    }
  }
  return out;
}

interface AreaWeights {
  start: number;
  /** Normalised to sum to 1. */
  weights: Float32Array;
}

/** For each of `dstLen` output samples, which source samples it covers and by how much. */
function areaWeights(srcLen: number, dstLen: number): AreaWeights[] {
  const scale = srcLen / dstLen;
  const result: AreaWeights[] = [];
  for (let i = 0; i < dstLen; i++) {
    const from = i * scale;
    const to = Math.min(srcLen, (i + 1) * scale);
    const start = Math.min(srcLen - 1, Math.floor(from));
    const end = Math.max(start + 1, Math.ceil(to));
    const weights = new Float32Array(end - start);
    let total = 0;
    for (let s = start; s < end; s++) {
      const w = Math.max(0, Math.min(to, s + 1) - Math.max(from, s));
      weights[s - start] = w;
      total += w;
    }
    for (let k = 0; k < weights.length; k++) weights[k] = total > 0 ? weights[k] / total : 1 / weights.length;
    result.push({ start, weights });
  }
  return result;
}

/**
 * Encodes the frame as a colour JPEG (BT.601 limited-range YUV -> RGB),
 * for thumbnails. Not on the per-frame analysis path - callers encode only
 * when they actually need an image.
 */
export async function encodeJpeg(frame: VideoFrame, quality = 80): Promise<Buffer> {
  const { width, height, data } = frame;
  if (data.length < yuv420pFrameSize(width, height)) {
    throw new Error(`Expected ${yuv420pFrameSize(width, height)} bytes of yuv420p, got ${data.length}`);
  }
  const chromaW = Math.ceil(width / 2);
  const uPlane = width * height;
  const vPlane = uPlane + chromaW * Math.ceil(height / 2);

  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = (y >> 1) * chromaW + (x >> 1);
      const luma = 1.164 * (data[y * width + x] - 16);
      const u = data[uPlane + c] - 128;
      const v = data[vPlane + c] - 128;
      const o = (y * width + x) * 3;
      rgb[o] = clampByte(luma + 1.596 * v);
      rgb[o + 1] = clampByte(luma - 0.392 * u - 0.813 * v);
      rgb[o + 2] = clampByte(luma + 2.017 * u);
    }
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } }).jpeg({ quality }).toBuffer();
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}
