import fs from 'node:fs';
import path from 'node:path';
import { AnalysisSettings } from '../types/admin';

/** Bounds the Admin page may set the processing knobs within; anything outside is clamped. */
export const SETTING_LIMITS = {
  fps: { min: 0.5, max: 10 },
  confidence: { min: 0.05, max: 0.95 },
} as const;

/**
 * The Admin page's analysis settings, kept in a small JSON file in the data
 * volume so they survive a container update. A missing or unreadable file
 * means the defaults: no camera analyzed, every knob at its default.
 */
export class AnalysisSettingsStore {
  constructor(private readonly filePath: string) {}

  load(): AnalysisSettings {
    try {
      return normalizeAnalysisSettings(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch {
      return { enabledCameras: [] };
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

/**
 * Settings from a file or a request body: malformed fields dropped (so they
 * fall back to their defaults), numbers clamped to `SETTING_LIMITS`, and a
 * model kept only if it is one of `models` (when given).
 */
export function normalizeAnalysisSettings(value: unknown, models?: readonly string[]): AnalysisSettings {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const ids = Array.isArray(input.enabledCameras) ? input.enabledCameras.filter((id): id is string => typeof id === 'string') : [];
  const settings: AnalysisSettings = { enabledCameras: Array.from(new Set(ids)) };

  const analysisFps = clampStep(input.analysisFps, SETTING_LIMITS.fps, 0.5);
  if (analysisFps !== undefined) settings.analysisFps = analysisFps;
  const overlayFps = clampStep(input.overlayFps, SETTING_LIMITS.fps, 0.5);
  if (overlayFps !== undefined) settings.overlayFps = overlayFps;
  const confidence = clampStep(input.overlayConfidence, SETTING_LIMITS.confidence, 0.01);
  if (confidence !== undefined) settings.overlayConfidence = confidence;
  if (typeof input.overlayModel === 'string' && (!models || models.includes(input.overlayModel))) settings.overlayModel = input.overlayModel;
  return settings;
}

function clampStep(value: unknown, limits: { min: number; max: number }, step: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const clamped = Math.min(limits.max, Math.max(limits.min, value));
  return Math.round(Math.round(clamped / step) * step * 100) / 100;
}
