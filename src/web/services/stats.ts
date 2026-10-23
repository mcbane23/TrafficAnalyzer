import type { CameraHeatmap, CameraStats, LiveCounts, StatsBucket, StatsRange, StatsSummary } from '../../types/stats';
import { t } from '../i18n';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let message = t('error.stats', { status: res.status });
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // Not JSON - keep the generic message.
    }
    throw new Error(message);
  }
  return res.json();
}

function cameraPath(cameraId: string): string {
  return `/api/cameras/${encodeURIComponent(cameraId)}`;
}

/** Per-camera totals and 24-hour sparklines for the dashboard. */
export function fetchStatsSummary(range: StatsRange): Promise<StatsSummary> {
  return getJson(`/api/stats/summary?range=${range}`);
}

/** Bucketed vehicle counts (by direction and size class), occupancy and coverage for one camera. */
export function fetchCameraStats(cameraId: string, range: StatsRange, bucket?: StatsBucket): Promise<CameraStats> {
  const query = new URLSearchParams({ range });
  if (bucket) query.set('bucket', bucket);
  return getJson(`${cameraPath(cameraId)}/stats?${query}`);
}

export function fetchCameraHeatmap(cameraId: string, days = 7): Promise<CameraHeatmap> {
  return getJson(`${cameraPath(cameraId)}/stats/heatmap?days=${days}`);
}

export function fetchLiveCounts(cameraId: string): Promise<LiveCounts> {
  return getJson(`${cameraPath(cameraId)}/stats/live`);
}

export function cameraStatsCsvUrl(cameraId: string, range: StatsRange, bucket: StatsBucket): string {
  return `${cameraPath(cameraId)}/stats.csv?range=${range}&bucket=${bucket}`;
}

/** Every visible camera's statistics in one CSV, at the range's default bucket. */
export function allStatsCsvUrl(range: StatsRange): string {
  return `/api/stats/all.csv?range=${range}`;
}

/** The thumbnail's URL; `version` changes with the picture (its capture time), so an unchanged one is never downloaded again. */
export function cameraSnapshotUrl(cameraId: string, version: string | number): string {
  return `${cameraPath(cameraId)}/snapshot.jpg?v=${encodeURIComponent(version)}`;
}

/** When each camera's dashboard thumbnail was captured (ISO), by camera id. */
export function fetchSnapshotTimes(): Promise<Record<string, string>> {
  return getJson('/api/cameras/snapshots');
}
