import type { ServerMetrics } from '../../types/admin';

/** Fetches the server's current health metrics (CPU, memory, analysis throughput, storage). */
export async function fetchServerMetrics(): Promise<ServerMetrics> {
  const res = await fetch('/api/admin/metrics');
  if (!res.ok) {
    throw new Error(`Failed to load server metrics (${res.status})`);
  }
  return res.json();
}
