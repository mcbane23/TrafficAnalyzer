import type { CameraAnalysisOverview, CameraAnalysisResult, LiveOverlayResult, StoredAnalysisResult } from '../../types/analysis';
import { t } from '../i18n';

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
    throw new Error(await parseErrorMessage(res, t('error.overview', { status: res.status })));
  }
  return res.json();
}

/** Recent persisted history for a single camera, used to render the detail page's trend view. */
export async function fetchCameraHistory(cameraId: string, limit?: number): Promise<StoredAnalysisResult[]> {
  const url = new URL(`${CAMERAS_BASE_URL}/${encodeURIComponent(cameraId)}/analysis/history`, window.location.origin);
  if (limit != null) url.searchParams.set('limit', String(limit));
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, t('error.history', { status: res.status })));
  }
  return res.json();
}

/** Cameras the fleet analysis runs on (the Admin page's switches), or null when every active camera is. */
export async function fetchAnalyzedCameras(): Promise<string[] | null> {
  const res = await fetch(`${ANALYSIS_BASE_URL}/enabled`);
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, t('error.overview', { status: res.status })));
  }
  return ((await res.json()) as { cameraIds: string[] | null }).cameraIds;
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
 * Subscribes to a single camera's full-detail analysis SSE stream. Every
 * active camera is analyzed continuously server-side, so this only listens -
 * still call the returned unsubscribe function on unmount / camera change so
 * the connection is closed.
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

/**
 * Subscribes to a watched camera's appearance-model (YOLO) boxes. `onUnavailable`
 * fires once if the server can't provide them - the detector is switched off
 * (the stream is refused) or it reports an error for this camera - so the
 * caller can tell the viewer there will be no boxes. `onReconnect` fires when
 * a dropped stream (e.g. while the browser froze a background tab) is open
 * again: if nobody else was watching, the server stopped the detector in the
 * meantime and boxes are half a minute away. Returns an unsubscribe function.
 */
export function subscribeCameraOverlay(
  cameraId: string,
  onMessage: (result: LiveOverlayResult) => void,
  onUnavailable: (reason: string) => void,
  onReconnect?: () => void,
): () => void {
  const source = new EventSource(`${CAMERAS_BASE_URL}/${encodeURIComponent(cameraId)}/overlay/stream`);
  let gaveUp = false;
  const giveUp = (reason: string) => {
    if (gaveUp) return;
    gaveUp = true;
    source.close();
    onUnavailable(reason);
  };
  let consecutiveErrors = 0;
  source.onmessage = (event) => {
    const result = JSON.parse(event.data) as LiveOverlayResult;
    // A capture error or two is transient (the pipeline keeps retrying), but a
    // camera the server refuses, or one that keeps failing (e.g. the model
    // can't be loaded), won't get overlay boxes at all.
    consecutiveErrors = result.error ? consecutiveErrors + 1 : 0;
    if (result.error && (/busy|not active|failed to start/.test(result.error) || consecutiveErrors >= 10)) giveUp(result.error);
    else onMessage(result);
  };
  // A refused stream (404) closes for good; a dropped one is retried by the browser.
  let dropped = false;
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) giveUp('overlay stream unavailable');
    else dropped = true;
  };
  source.onopen = () => {
    if (!dropped || gaveUp) return;
    dropped = false;
    onReconnect?.();
  };
  return () => {
    gaveUp = true;
    source.close();
  };
}

/**
 * The model drawing the live boxes, shortened for a label over the video
 * ("YOLO26s on OpenVINO GPU" -> "YOLO26s · GPU"), or null if unknown.
 */
export async function fetchOverlayModel(): Promise<string | null> {
  const res = await fetch('/api/overlay/model');
  if (!res.ok) return null;
  const { model } = (await res.json()) as { model: string | null };
  return model ? model.replace(/ on (OpenVINO )?/, ' · ') : null;
}
