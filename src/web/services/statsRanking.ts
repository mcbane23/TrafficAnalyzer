import type { CameraSummary } from '../../types/stats';

/**
 * Cameras for the "busiest" ranking: only those with counted vehicles and still listed
 * (hidden cameras are left out of /api/cameras, so they are left out here too).
 */
export function rankedCameras(cameras: CameraSummary[], listed: { has(cameraId: string): boolean }): CameraSummary[] {
  return cameras.filter((c) => c.total > 0 && listed.has(c.cameraId));
}
