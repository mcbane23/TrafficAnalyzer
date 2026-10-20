import sharp from 'sharp';
import { VideoFrame, encodeJpeg, resampleLuma, yuv420pFrameSize } from './videoFrame';

/** A yuv420p frame with the given luma plane and neutral (grey) chroma. */
function greyFrame(width: number, height: number, luma: (x: number, y: number) => number): VideoFrame {
  const data = new Uint8Array(yuv420pFrameSize(width, height)).fill(128);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = luma(x, y);
  return { width, height, data };
}

describe('yuv420pFrameSize', () => {
  it('is a full luma plane plus two quarter-size chroma planes, rounding odd sizes up', () => {
    expect(yuv420pFrameSize(320, 240)).toBe(320 * 240 * 1.5);
    expect(yuv420pFrameSize(3, 3)).toBe(9 + 2 * 4);
  });
});

describe('resampleLuma', () => {
  it('returns the luma plane itself, without the chroma planes, when the size already matches', () => {
    const frame = greyFrame(4, 2, (x) => x * 10);

    expect(Array.from(resampleLuma(frame, 4, 2))).toEqual([0, 10, 20, 30, 0, 10, 20, 30]);
  });

  it('averages each block when shrinking by a whole factor', () => {
    const frame = greyFrame(4, 2, (x, y) => [10, 30, 100, 200][x] + y * 2);

    // Each output pixel covers a 2x2 block: (10+30+12+32)/4 and (100+200+102+202)/4.
    expect(Array.from(resampleLuma(frame, 2, 1))).toEqual([21, 151]);
  });

  it('weights partially covered source pixels by how much of them each output pixel covers', () => {
    // 3 -> 2: output 0 covers source 0 fully and half of source 1.
    const frame = greyFrame(3, 1, (x) => [0, 90, 180][x]);

    expect(Array.from(resampleLuma(frame, 2, 1))).toEqual([30, 150]);
  });

  it('preserves a uniform image exactly at a non-integer ratio', () => {
    const frame = greyFrame(320, 240, () => 77);

    const out = resampleLuma(frame, 240, 180);

    expect(out).toHaveLength(240 * 180);
    expect(out.every((v) => v === 77)).toBe(true);
  });

  it('rejects a frame whose data is shorter than its luma plane', () => {
    expect(() => resampleLuma({ width: 4, height: 4, data: new Uint8Array(15) }, 2, 2)).toThrow(/luma samples/);
  });
});

describe('encodeJpeg', () => {
  it('produces a JPEG of the frame size whose colours match the YUV input', async () => {
    // Left half white-ish grey, right half black, neutral chroma.
    const frame = greyFrame(16, 8, (x) => (x < 8 ? 200 : 16));

    const jpeg = await encodeJpeg(frame, 95);
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });

    expect([info.width, info.height]).toEqual([16, 8]);
    const pixel = (x: number, y: number) => Array.from(data.subarray((y * 16 + x) * info.channels, (y * 16 + x) * info.channels + 3));
    // Limited-range luma 200 -> ~214 full-range; 16 -> 0. Grey, so R = G = B.
    pixel(2, 4).forEach((v) => expect(Math.abs(v - 214)).toBeLessThanOrEqual(4));
    pixel(13, 4).forEach((v) => expect(v).toBeLessThanOrEqual(4));
  });

  it('rejects a frame with too little data for its size', async () => {
    await expect(encodeJpeg({ width: 4, height: 4, data: new Uint8Array(16) })).rejects.toThrow(/yuv420p/);
  });
});
