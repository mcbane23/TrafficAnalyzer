import type { CameraEntry } from '../types/camera';

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
