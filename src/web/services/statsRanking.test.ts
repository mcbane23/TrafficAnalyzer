import type { CameraSummary } from '../../types/stats';
import { rankedCameras } from './statsRanking';

function summary(cameraId: string, total: number): CameraSummary {
  return { cameraId, total, car: total, large: 0, coverage: 1, sparkline: [] } as unknown as CameraSummary;
}

describe('rankedCameras', () => {
  const listed = new Map([
    ['slavija', 'Slavija'],
    ['brankov', 'Brankov most'],
  ]);

  it('keeps listed cameras that counted vehicles', () => {
    const ranked = rankedCameras([summary('slavija', 2000), summary('brankov', 997)], listed);
    expect(ranked.map((c) => c.cameraId)).toEqual(['slavija', 'brankov']);
  });

  it('leaves out cameras with no vehicles', () => {
    expect(rankedCameras([summary('slavija', 0), summary('brankov', 5)], listed).map((c) => c.cameraId)).toEqual(['brankov']);
  });

  it('leaves out hidden cameras (not in the camera list)', () => {
    expect(rankedCameras([summary('hidden-cam', 50), summary('slavija', 3)], listed).map((c) => c.cameraId)).toEqual(['slavija']);
  });
});
