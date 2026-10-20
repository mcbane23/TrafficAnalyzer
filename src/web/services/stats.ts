import type { CameraHeatmap, CameraStats, LiveCounts, StatsBucket, StatsRange, StatsSummary } from '../../types/stats';

async function getJson<T>(url: string, what: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let message = `Failed to load ${what} (${res.status})`;
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
  return getJson(`/api/stats/summary?range=${range}`, 'traffic summary');
}

/** Bucketed vehicle counts (by direction and size class), occupancy and coverage for one camera. */
export function fetchCameraStats(cameraId: string, range: StatsRange, bucket?: StatsBucket): Promise<CameraStats> {
  const query = new URLSearchParams({ range });
  if (bucket) query.set('bucket', bucket);
  return getJson(`${cameraPath(cameraId)}/stats?${query}`, 'traffic statistics');
}

export function fetchCameraHeatmap(cameraId: string, days = 7): Promise<CameraHeatmap> {
  return getJson(`${cameraPath(cameraId)}/stats/heatmap?days=${days}`, 'traffic heatmap');
}

export function fetchLiveCounts(cameraId: string): Promise<LiveCounts> {
  return getJson(`${cameraPath(cameraId)}/stats/live`, 'live counts');
}

export function cameraStatsCsvUrl(cameraId: string, range: StatsRange, bucket: StatsBucket): string {
  return `${cameraPath(cameraId)}/stats.csv?range=${range}&bucket=${bucket}`;
}

export function cameraSnapshotUrl(cameraId: string, cacheBust: number): string {
  return `${cameraPath(cameraId)}/snapshot.jpg?t=${cacheBust}`;
}
