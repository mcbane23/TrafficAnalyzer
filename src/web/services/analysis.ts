import type { CameraAnalysisOverview, CameraAnalysisResult, StoredAnalysisResult } from '../../types/analysis';

const CAMERAS_BASE_URL = '/api/cameras';
const ANALYSIS_BASE_URL = '/api/analysis';

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

/** Bootstrap snapshot for the dashboard - the latest known overview for every camera, before the SSE stream delivers live updates. */
export async function fetchLatestOverview(): Promise<CameraAnalysisOverview[]> {
  const res = await fetch(`${ANALYSIS_BASE_URL}/latest`);
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, `Failed to load traffic overview (${res.status})`));
  }
  return res.json();
}

/** Recent persisted history for a single camera, used to render the detail page's trend view. */
export async function fetchCameraHistory(cameraId: string, limit?: number): Promise<StoredAnalysisResult[]> {
  const url = new URL(`${CAMERAS_BASE_URL}/${encodeURIComponent(cameraId)}/analysis/history`, window.location.origin);
  if (limit != null) url.searchParams.set('limit', String(limit));
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, `Failed to load traffic history (${res.status})`));
  }
  return res.json();
}

/**
 * Subscribes to the dashboard-wide overview SSE stream. Returns an unsubscribe
 * function that closes the underlying EventSource - always call it on unmount.
 */
export function subscribeOverview(onMessage: (overview: CameraAnalysisOverview) => void, onError?: () => void): () => void {
  const source = new EventSource(`${ANALYSIS_BASE_URL}/stream`);
  source.onmessage = (event) => {
    onMessage(JSON.parse(event.data));
  };
  if (onError) source.onerror = onError;
  return () => source.close();
}

/**
 * Subscribes to a single camera's full-detail analysis SSE stream. Opening
 * this connection is what boosts that camera's sampling rate server-side;
 * closing it (calling the returned unsubscribe function) reverts it back to
 * the background rate - always call it on unmount / camera change.
 */
export function subscribeCameraAnalysis(
  cameraId: string,
  onMessage: (result: CameraAnalysisResult) => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`${CAMERAS_BASE_URL}/${encodeURIComponent(cameraId)}/analysis/stream`);
  source.onmessage = (event) => {
    onMessage(JSON.parse(event.data));
  };
  if (onError) source.onerror = onError;
  return () => source.close();
}
