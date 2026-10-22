import type { AnalysisSettings, AnalysisSettingsResponse, ServerMetrics } from '../../types/admin';
import type { CameraEntry } from '../../types/camera';
import type { AccuracyCheck, AccuracyChecksResponse, ManualCount } from '../../types/accuracy';
import { t, tDynamic } from '../i18n';

/** Fetches the server's current health metrics (CPU, memory, analysis throughput, storage). */
export async function fetchServerMetrics(): Promise<ServerMetrics> {
  const res = await fetch('/api/admin/metrics');
  if (!res.ok) {
    throw new Error(t('error.metrics', { status: res.status }));
  }
  return res.json();
}

/** The analysis switches and every camera they apply to. */
export async function fetchAnalysisSettings(): Promise<AnalysisSettingsResponse> {
  const res = await fetch('/api/admin/analysis-settings');
  if (!res.ok) {
    throw new Error(t('error.settings', { status: res.status }));
  }
  return res.json();
}

/** Saves the analysis switches; the server starts and stops cameras to match before it answers. */
export async function saveAnalysisSettings(settings: AnalysisSettings): Promise<AnalysisSettingsResponse> {
  const res = await fetch('/api/admin/analysis-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    throw new Error(t('error.saveSettings', { status: res.status }));
  }
  return res.json();
}

/** A camera edit from the Admin page; see the server's `CameraPatch`. */
export interface CameraPatch {
  name?: string;
  address?: string;
  directions?: { a?: string; b?: string } | null;
  ignoreZones?: Array<{ name?: string; points: Array<[number, number]> }>;
  hidden?: boolean;
}

export interface NewCamera {
  name: string;
  address: string;
  url: string;
  referer?: string;
}

/** The server's refusal, worded in the current language when it says why (`code`). */
async function cameraError(res: Response): Promise<Error> {
  let body: { error?: string; code?: string } = {};
  try {
    body = await res.json();
  } catch {
    // Not JSON - fall back to the status.
  }
  const fallback = body.error ?? t('error.cameraSave', { status: res.status });
  return new Error(body.code ? tDynamic(`cameraEdit.error.${body.code}`, fallback) : fallback);
}

/** Every camera, hidden ones included. */
export async function fetchAdminCameras(): Promise<CameraEntry[]> {
  const res = await fetch('/api/admin/cameras');
  if (!res.ok) {
    throw new Error(t('error.cameras', { status: res.status }));
  }
  return res.json();
}

/** Saves a camera edit; the server applies it (new zones, hidden or shown) before it answers. */
export async function updateCamera(cameraId: string, patch: CameraPatch): Promise<CameraEntry> {
  const res = await fetch(`/api/admin/cameras/${encodeURIComponent(cameraId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await cameraError(res);
  return res.json();
}

/** Adds a camera; the server probes its stream first, which can take a while. */
export async function addCamera(camera: NewCamera): Promise<CameraEntry> {
  const res = await fetch('/api/admin/cameras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(camera),
  });
  if (!res.ok) throw await cameraError(res);
  return res.json();
}

/** Past and running counting-accuracy checks, newest first. */
export async function fetchAccuracyChecks(): Promise<AccuracyChecksResponse> {
  const res = await fetch('/api/admin/accuracy-checks');
  if (!res.ok) throw await checkError(res);
  return res.json();
}

export async function fetchAccuracyCheck(id: string): Promise<AccuracyCheck> {
  const res = await fetch(`/api/admin/accuracy-checks/${encodeURIComponent(id)}`);
  if (!res.ok) throw await checkError(res);
  return res.json();
}

/** Starts recording a camera; the check then records, analyzes and becomes ready on its own. */
export async function startAccuracyCheck(cameraId: string, durationSec: number): Promise<AccuracyCheck> {
  const res = await fetch('/api/admin/accuracy-checks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cameraId, durationSec }),
  });
  if (!res.ok) throw await checkError(res);
  return res.json();
}

export async function saveManualCount(id: string, clicks: ManualCount[]): Promise<AccuracyCheck> {
  const res = await fetch(`/api/admin/accuracy-checks/${encodeURIComponent(id)}/manual`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clicks }),
  });
  if (!res.ok) throw await checkError(res);
  return res.json();
}

export function accuracyClipUrl(id: string): string {
  return `/api/admin/accuracy-checks/${encodeURIComponent(id)}/clip.mp4`;
}

async function checkError(res: Response): Promise<Error> {
  let body: { error?: string; code?: string } = {};
  try {
    body = await res.json();
  } catch {
    // Not JSON - fall back to the status.
  }
  const fallback = body.error ?? t('check.error.generic', { status: res.status });
  return new Error(body.code ? tDynamic(`check.error.${body.code}`, fallback) : fallback);
}
