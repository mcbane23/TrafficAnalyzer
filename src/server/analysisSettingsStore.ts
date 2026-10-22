import fs from 'node:fs';
import path from 'node:path';
import { AnalysisSettings } from '../types/admin';

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = { enabled: true, disabledCameras: [] };

/**
 * Which cameras the fleet analysis runs on, as switched on the Admin page,
 * kept in a small JSON file in the data volume so it survives a container
 * update. A missing or unreadable file means the defaults: everything active
 * is analyzed.
 */
export class AnalysisSettingsStore {
  constructor(private readonly filePath: string) {}

  load(): AnalysisSettings {
    try {
      return normalizeAnalysisSettings(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch {
      return { ...DEFAULT_ANALYSIS_SETTINGS, disabledCameras: [] };
    }
  }

  /** Writes to a temporary file first, so a crash mid-write can't leave a truncated file behind. */
  save(settings: AnalysisSettings): void {
    const tmp = `${this.filePath}.tmp`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    fs.renameSync(tmp, this.filePath);
  }
}

/** Settings from a file or a request body, with anything malformed replaced by the default. */
export function normalizeAnalysisSettings(value: unknown): AnalysisSettings {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof AnalysisSettings, unknown>>;
  const disabled = Array.isArray(input.disabledCameras) ? input.disabledCameras.filter((id): id is string => typeof id === 'string') : [];
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_ANALYSIS_SETTINGS.enabled,
    disabledCameras: Array.from(new Set(disabled)),
  };
}
