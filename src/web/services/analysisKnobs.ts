import type { AnalysisSettings } from '../../types/admin';

/** The Admin page's processing knobs, each picked from a select. */
export type Knob = 'analysisFps' | 'overlayFps' | 'overlayConfidence' | 'overlayModel' | 'passageRetentionDays';

/**
 * `settings` with one knob set from its select's value. '' is the select's
 * "default" option, which is saved by leaving the field out - the server then
 * falls back to the default.
 */
export function withKnob(settings: AnalysisSettings, key: Knob, raw: string): AnalysisSettings {
  const next: AnalysisSettings = { ...settings };
  if (raw === '') delete next[key];
  else if (key === 'overlayModel') next.overlayModel = raw;
  else next[key] = Number(raw);
  return next;
}
