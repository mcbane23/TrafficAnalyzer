import type { AnalysisSettings, AnalysisSettingsResponse, ServerMetrics } from '../../types/admin';
import { t } from '../i18n';

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
