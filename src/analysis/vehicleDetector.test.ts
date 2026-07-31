import { VehicleDetector } from './vehicleDetector';
import { InferenceRunner } from './onnxRunner';
import { RawModelDetection } from '../types/analysis';

const BOX = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };

function makeRaw(overrides: Partial<RawModelDetection> = {}): RawModelDetection {
  return { classId: 2, confidence: 0.9, box: BOX, ...overrides };
}

function makeFakeRunner(detections: RawModelDetection[]): InferenceRunner {
  return jest.fn(async () => detections);
}

describe('VehicleDetector', () => {
  it('maps a car detection through unchanged (class, confidence, box)', async () => {
    const raw = makeRaw({ classId: 2, confidence: 0.87 });
    const detector = new VehicleDetector({ inferenceRunner: makeFakeRunner([raw]) });

    const result = await detector.detect(Buffer.from('frame'));

    expect(result).toEqual([{ class: 'car', confidence: 0.87, box: BOX }]);
  });

  it('maps COCO class 6 (train) to "tram"', async () => {
    const detector = new VehicleDetector({ inferenceRunner: makeFakeRunner([makeRaw({ classId: 6, confidence: 0.8 })]) });

    const result = await detector.detect(Buffer.from('frame'));

    expect(result).toEqual([{ class: 'tram', confidence: 0.8, box: BOX }]);
  });

  it('maps both COCO class 1 (bicycle) and 3 (motorcycle) to "motorcycle"', async () => {
    const detector = new VehicleDetector({
      inferenceRunner: makeFakeRunner([makeRaw({ classId: 1, confidence: 0.7 }), makeRaw({ classId: 3, confidence: 0.75 })]),
    });

    const result = await detector.detect(Buffer.from('frame'));

    expect(result.map((d) => d.class)).toEqual(['motorcycle', 'motorcycle']);
  });

  it('maps COCO classes 5 and 7 to "bus" and "truck" respectively', async () => {
    const detector = new VehicleDetector({
      inferenceRunner: makeFakeRunner([makeRaw({ classId: 5, confidence: 0.6 }), makeRaw({ classId: 7, confidence: 0.6 })]),
    });

    const result = await detector.detect(Buffer.from('frame'));

    expect(result.map((d) => d.class)).toEqual(['bus', 'truck']);
  });

  it('ignores non-vehicle COCO classes (e.g. person)', async () => {
    const detector = new VehicleDetector({
      inferenceRunner: makeFakeRunner([makeRaw({ classId: 0, confidence: 0.99 }), makeRaw({ classId: 2, confidence: 0.9 })]),
    });

    const result = await detector.detect(Buffer.from('frame'));

    expect(result).toHaveLength(1);
    expect(result[0].class).toBe('car');
  });

  it('filters out detections below the default confidence threshold', async () => {
    const detector = new VehicleDetector({
      inferenceRunner: makeFakeRunner([makeRaw({ confidence: 0.39 }), makeRaw({ confidence: 0.4 })]),
    });

    const result = await detector.detect(Buffer.from('frame'));

    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.4);
  });

  it('honors a custom confidenceThreshold option', async () => {
    const detector = new VehicleDetector({
      confidenceThreshold: 0.6,
      inferenceRunner: makeFakeRunner([makeRaw({ confidence: 0.5 }), makeRaw({ confidence: 0.65 })]),
    });

    const result = await detector.detect(Buffer.from('frame'));

    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.65);
  });

  it('returns an empty array when there are no detections', async () => {
    const detector = new VehicleDetector({ inferenceRunner: makeFakeRunner([]) });

    const result = await detector.detect(Buffer.from('frame'));

    expect(result).toEqual([]);
  });
});
