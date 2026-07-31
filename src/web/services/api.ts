import type { CameraEntry, RevalidationStatus } from '../../types/camera';

const BASE_URL = '/api/cameras';

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export async function fetchCameras(): Promise<CameraEntry[]> {
  const res = await fetch(BASE_URL);
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, `Failed to load cameras (${res.status})`));
  }
  return res.json();
}

export async function fetchCameraById(id: string): Promise<CameraEntry> {
  const res = await fetch(`${BASE_URL}/${encodeURIComponent(id)}`);
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, `Failed to load camera "${id}" (${res.status})`));
  }
  return res.json();
}

/** Kicks off a background availability check for every camera. Resolves as soon as the run has started (or is confirmed already running) - it does not wait for the run to finish. */
export async function startRevalidation(): Promise<RevalidationStatus> {
  const res = await fetch(`${BASE_URL}/revalidate`, { method: 'POST' });
  if (!res.ok && res.status !== 409) {
    throw new Error(await parseErrorMessage(res, `Failed to start availability check (${res.status})`));
  }
  return res.json();
}

/** Fetches the current progress/outcome of the background availability check. */
export async function fetchRevalidationStatus(): Promise<RevalidationStatus> {
  const res = await fetch(`${BASE_URL}/revalidate/status`);
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, `Failed to load availability check status (${res.status})`));
  }
  return res.json();
}

