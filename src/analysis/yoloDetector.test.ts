import { YoloDetector, YoloSession, decodeYoloOutput, letterboxToTensor } from './yoloDetector';
import { VideoFrame } from './videoFrame';

/** A uniform `yuv420p` frame: every pixel the given Y, U and V. */
function solidFrame(width: number, height: number, y: number, u = 128, v = 128): VideoFrame {
  const luma = width * height;
  const chroma = Math.ceil(width / 2) * Math.ceil(height / 2);
  const data = new Uint8Array(luma + 2 * chroma);
  data.fill(y, 0, luma);
  data.fill(u, luma, luma + chroma);
  data.fill(v, luma + chroma);
  return { width, height, data };
}

const CLASSES = 80;

/** A raw YOLO head output with the given anchors, each `[cx, cy, w, h, classId, score]` in input pixels. */
function headOutput(anchors: Array<[number, number, number, number, number, number]>) {
  const rows = 4 + CLASSES;
  const n = anchors.length;
  const data = new Float32Array(rows * n);
  anchors.forEach(([cx, cy, w, h, cls, score], a) => {
    data[a] = cx;
    data[n + a] = cy;
    data[2 * n + a] = w;
    data[3 * n + a] = h;
    data[(4 + cls) * n + a] = score;
  });
  return { data, dims: [1, rows, n] as const };
}

describe('letterboxToTensor', () => {
  it('scales the frame into the top-left of the square input and pads the rest grey', () => {
    // 4x2 frame into a 4x4 input: scale 1, rows 2-3 are padding.
    const { tensor, scale } = letterboxToTensor(solidFrame(4, 2, 235), 4);
    expect(scale).toBe(1);
    const plane = 16;
    // Limited-range white (Y=235) is full white in every channel.
    for (const channel of [0, 1, 2]) {
      expect(tensor[channel * plane + 0]).toBeCloseTo(1, 2);
      expect(tensor[channel * plane + 7]).toBeCloseTo(1, 2);
      expect(tensor[channel * plane + 8]).toBeCloseTo(114 / 255, 5);
    }
  });

  it('fits a frame into a non-square input', () => {
    // 4x4 frame into 8x4: scale 1, columns 4-7 are padding.
    const { tensor, scale } = letterboxToTensor(solidFrame(4, 4, 235), 8, 4);
    expect(scale).toBe(1);
    expect(tensor.length).toBe(3 * 32);
    expect(tensor[3]).toBeCloseTo(1, 2);
    expect(tensor[4]).toBeCloseTo(114 / 255, 5);
  });

  it('converts chroma, so a red frame comes out red', () => {
    // BT.601 limited-range pure red.
    const { tensor } = letterboxToTensor(solidFrame(2, 2, 81, 90, 240), 2);
    expect(tensor[0]).toBeGreaterThan(0.9);
    expect(tensor[4]).toBeLessThan(0.1);
    expect(tensor[8]).toBeLessThan(0.1);
  });
});

describe('decodeYoloOutput', () => {
  const options = { scale: 0.5, frameWidth: 1280, frameHeight: 960, minConfidence: 0.3, iouThreshold: 0.5 };

  it('keeps vehicle classes above the threshold, normalized to the source frame', () => {
    const { data, dims } = headOutput([
      [320, 240, 64, 48, 2, 0.9], // car
      [100, 100, 20, 20, 0, 0.95], // person - not a vehicle
      [500, 400, 40, 40, 7, 0.2], // truck, too unsure
      [50, 50, 30, 30, 6, 0.8], // train (tram) - reported as a bus
    ]);
    const detections = decodeYoloOutput(data, dims, options);

    expect(detections).toHaveLength(2);
    expect(detections[0]).toEqual({
      class: 'car',
      confidence: expect.closeTo(0.9, 5),
      box: { x: (640 - 64) / 1280, y: (480 - 48) / 960, width: 128 / 1280, height: 96 / 960 },
    });
    expect(detections[1].class).toBe('bus');
  });

  it('suppresses overlapping boxes across classes, keeping the most confident', () => {
    const { data, dims } = headOutput([
      [320, 240, 64, 48, 2, 0.6],
      [322, 242, 64, 48, 7, 0.8],
      [100, 100, 20, 20, 2, 0.7],
    ]);
    const detections = decodeYoloOutput(data, dims, options);

    expect(detections.map((d) => d.class)).toEqual(['truck', 'car']);
  });
});

describe('YoloDetector', () => {
  it('runs the session on the letterboxed frame and drops detections centred in an ignore zone', async () => {
    const output = headOutput([
      [160, 120, 40, 40, 2, 0.9], // centre (0.25, 0.25) of a 640x480 frame - inside the zone
      [480, 360, 40, 40, 2, 0.9], // centre (0.75, 0.75)
    ]);
    const session: YoloSession & { run: jest.Mock } = { run: jest.fn(async () => output) };
    const detector = new YoloDetector(session, { ignoreZones: [[[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]]] });

    const result = await detector.detect(solidFrame(640, 480, 100));

    // Default input is the overlay capture's own 640x480 - no padding at all.
    expect(session.run).toHaveBeenCalledWith(expect.any(Float32Array), 640, 480);
    expect((session.run.mock.calls[0][0] as Float32Array).length).toBe(3 * 640 * 480);
    expect(result.warmingUp).toBe(false);
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].box.x).toBeCloseTo(460 / 640, 5);
  });
});
