import { CameraAnalyzer, OccupancyEstimatorLike, VehicleDetectorLike } from './cameraAnalyzer';
import { VehicleDetection } from '../types/analysis';

const TIMESTAMP = '2026-01-01T00:00:00.000Z';
const FRAME = Buffer.from('frame');

function detection(overrides: Partial<VehicleDetection> = {}): VehicleDetection {
  return { class: 'vehicle', confidence: 0.9, box: { x: 0, y: 0, width: 0.1, height: 0.1 }, ...overrides };
}

function makeDetector(detections: VehicleDetection[] = []): VehicleDetectorLike {
  return { detect: jest.fn(async () => detections) };
}

/** An estimator that reports a fixed occupancy, standing in for a warmed-up camera. */
function makeOccupancy(occupancy: number | null): OccupancyEstimatorLike {
  return { update: jest.fn(async () => ({ occupancy })) };
}

/** An analyzer with everything faked - the whole tick's logic, no image decoding. */
function makeAnalyzer(options: {
  detections?: VehicleDetection[];
  occupancy?: number | null;
  detector?: VehicleDetectorLike;
  occupancyEstimator?: OccupancyEstimatorLike | null;
} = {}) {
  return new CameraAnalyzer('cam-1', {
    detector: options.detector ?? makeDetector(options.detections ?? []),
    occupancyEstimator:
      options.occupancyEstimator !== undefined
        ? options.occupancyEstimator
        : makeOccupancy(options.occupancy ?? null),
  });
}

describe('CameraAnalyzer', () => {
  it('returns a result carrying the camera id, timestamp, count and detections', async () => {
    const analyzer = makeAnalyzer({ detections: [detection(), detection()] });

    const result = await analyzer.analyze(FRAME, TIMESTAMP);

    expect(result.cameraId).toBe('cam-1');
    expect(result.timestamp).toBe(TIMESTAMP);
    expect(result.totalCount).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it('assigns stable track ids by running detections through the tracker', async () => {
    const box = { x: 0.2, y: 0.2, width: 0.1, height: 0.1 };
    const analyzer = makeAnalyzer({ detections: [detection({ box })] });

    const first = await analyzer.analyze(FRAME, TIMESTAMP);
    const second = await analyzer.analyze(FRAME, TIMESTAMP);

    // Same vehicle, same place, two consecutive ticks - one id, not two.
    expect(first.detections[0].trackId).toBe(1);
    expect(second.detections[0].trackId).toBe(1);
  });

  it('hands the same frame to both the detector and the occupancy estimator', async () => {
    const detector = makeDetector();
    const occupancyEstimator = makeOccupancy(0.2);
    const analyzer = makeAnalyzer({ detector, occupancyEstimator });

    await analyzer.analyze(FRAME, TIMESTAMP);

    expect(detector.detect).toHaveBeenCalledWith(FRAME);
    expect(occupancyEstimator.update).toHaveBeenCalledWith(FRAME);
  });

  describe('traffic level from occupancy', () => {
    it.each([
      [0.02, 'light'],
      [0.14, 'light'],
      [0.15, 'moderate'],
      [0.34, 'moderate'],
      [0.35, 'heavy'],
      [0.9, 'heavy'],
    ])('maps occupancy %f to "%s"', async (occupancy, expected) => {
      const result = await makeAnalyzer({ occupancy: occupancy as number }).analyze(FRAME, TIMESTAMP);

      expect(result.trafficLevel).toBe(expected);
      expect(result.occupancy).toBe(occupancy);
    });

    // The whole point of measuring occupancy separately: a road can be
    // visibly full while the detector resolves almost nothing on it, and the
    // badge must follow the road.
    it('reports heavy traffic on a full road even when detection finds almost nothing', async () => {
      const result = await makeAnalyzer({
        occupancy: 0.8,
        detections: [detection({ box: { x: 0, y: 0, width: 0.05, height: 0.05 } })],
      }).analyze(FRAME, TIMESTAMP);

      expect(result.totalCount).toBe(1);
      expect(result.trafficLevel).toBe('heavy');
    });
  });

  describe('traffic level from the vehicle count (fallback)', () => {
    it.each([
      [0, 'light'],
      [5, 'light'],
      [6, 'moderate'],
      [14, 'moderate'],
      [15, 'heavy'],
      [30, 'heavy'],
    ])('derives traffic level for a total count of %i as "%s"', async (count, expected) => {
      const detections = Array.from({ length: count as number }, (_, i) =>
        // Spread them out so the tracker doesn't merge overlapping boxes into
        // one track and change the count under the assertion.
        detection({ box: { x: (i % 10) * 0.09, y: Math.floor(i / 10) * 0.3, width: 0.02, height: 0.02 } }),
      );
      const result = await makeAnalyzer({ detections, occupancy: null }).analyze(FRAME, TIMESTAMP);

      expect(result.trafficLevel).toBe(expected);
      expect(result.totalCount).toBe(count);
    });

    it('omits occupancy from the result while the estimator is still warming up', async () => {
      const result = await makeAnalyzer({ occupancy: null }).analyze(FRAME, TIMESTAMP);

      expect(result.occupancy).toBeUndefined();
    });

    it('falls back to the vehicle count when the estimator throws', async () => {
      const analyzer = makeAnalyzer({
        occupancyEstimator: {
          update: jest.fn(async () => {
            throw new Error('decode failed');
          }),
        },
      });

      const result = await analyzer.analyze(FRAME, TIMESTAMP);

      expect(result.trafficLevel).toBe('light');
      expect(result.error).toBeUndefined();
    });

    it('falls back to the vehicle count when occupancy is switched off entirely', async () => {
      const detections = Array.from({ length: 20 }, (_, i) =>
        detection({ box: { x: (i % 10) * 0.09, y: Math.floor(i / 10) * 0.3, width: 0.02, height: 0.02 } }),
      );
      const analyzer = new CameraAnalyzer('cam-1', { detector: makeDetector(detections), occupancyEstimator: null });

      const result = await analyzer.analyze(FRAME, TIMESTAMP);

      expect(result.occupancy).toBeUndefined();
      expect(result.trafficLevel).toBe('heavy');
    });
  });

  // A detection failure loses one tick's data, not the tick itself - a
  // subscriber still needs to be told the camera produced nothing and why.
  it('returns an error result rather than rejecting when detection throws', async () => {
    const analyzer = makeAnalyzer({
      detector: {
        detect: jest.fn(async () => {
          throw new Error('luma decode failed');
        }),
      },
    });

    const result = await analyzer.analyze(FRAME, TIMESTAMP);

    expect(result).toEqual({
      cameraId: 'cam-1',
      timestamp: TIMESTAMP,
      totalCount: 0,
      trafficLevel: 'light',
      detections: [],
      error: 'luma decode failed',
    });
  });

  it('errorResult shapes a failed capture identically to a real result', async () => {
    const result = makeAnalyzer().errorResult(TIMESTAMP, 'stream unreachable');

    expect(result).toEqual({
      cameraId: 'cam-1',
      timestamp: TIMESTAMP,
      totalCount: 0,
      trafficLevel: 'light',
      detections: [],
      error: 'stream unreachable',
    });
  });

  it('honours custom thresholds', async () => {
    const analyzer = new CameraAnalyzer('cam-1', {
      detector: makeDetector([detection()]),
      occupancyEstimator: makeOccupancy(0.5),
      moderateOccupancy: 0.6,
      heavyOccupancy: 0.8,
    });

    const result = await analyzer.analyze(FRAME, TIMESTAMP);

    expect(result.trafficLevel).toBe('light');
  });
});
