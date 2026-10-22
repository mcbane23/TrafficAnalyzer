import { CameraEntry } from '../types/camera';
import { AnalysisSettings, AnalysisSettingsResponse, ProcessingSettings } from '../types/admin';
import { AnalysisSettingsStore, normalizeAnalysisSettings } from './analysisSettingsStore';

export interface AdminSettingsDeps {
  store: AnalysisSettingsStore;
  /** Values a knob falls back to when it is not set: the env vars, else the built-in defaults. */
  defaults: ProcessingSettings;
  overlay: AnalysisSettingsResponse['overlay'];
  listCameras: () => Promise<CameraEntry[]>;
  analysis: { setEnabledCameras(cameraIds: string[]): Promise<{ started: string[]; stopped: string[] }> };
  analysisGrabber: { setStreamFps(fps: number): void };
  overlayGrabber: { setStreamFps(fps: number): void } | null;
  /** Drops the loaded overlay model, so the next frame loads the newly chosen one. */
  onOverlayModelChange: () => void;
}

/**
 * The Admin page's analysis settings: which cameras the fleet analysis runs
 * on, and the processing knobs (frame rates, YOLO model and threshold). It
 * keeps them in `AnalysisSettingsStore` and applies a change straight away -
 * cameras start and stop, captures restart on a new frame rate, the overlay
 * loads the new model on its next frame - so nothing needs a restart.
 */
export class AdminSettingsService {
  private settings: AnalysisSettings;

  constructor(private readonly deps: AdminSettingsDeps) {
    this.settings = deps.store.load();
  }

  current(): AnalysisSettings {
    return this.settings;
  }

  /** Every knob as it is in effect: the saved value, else the default. */
  effective(): ProcessingSettings {
    const { defaults } = this.deps;
    return {
      analysisFps: this.settings.analysisFps ?? defaults.analysisFps,
      overlayFps: this.settings.overlayFps ?? defaults.overlayFps,
      overlayModel: this.settings.overlayModel ?? defaults.overlayModel,
      overlayConfidence: this.settings.overlayConfidence ?? defaults.overlayConfidence,
    };
  }

  async describe(): Promise<AnalysisSettingsResponse> {
    const enabled = new Set(this.settings.enabledCameras);
    const cameras = (await this.deps.listCameras()).map((camera) => ({
      id: camera.id,
      name: camera.name,
      active: camera.status === 'active',
      enabled: enabled.has(camera.id),
    }));
    return { settings: this.settings, cameras, defaults: this.deps.defaults, overlay: this.deps.overlay };
  }

  /** Saves new settings and applies whatever changed. */
  async update(input: unknown): Promise<AnalysisSettingsResponse> {
    const next = normalizeAnalysisSettings(input, this.deps.overlay.models);
    const before = this.effective();
    const previousCameras = this.settings.enabledCameras;
    this.deps.store.save(next);
    this.settings = next;
    const after = this.effective();

    const changes: string[] = [];
    if (!sameIds(previousCameras, next.enabledCameras)) {
      const { started, stopped } = await this.deps.analysis.setEnabledCameras(next.enabledCameras);
      if (started.length || stopped.length) changes.push(`started ${started.join(', ') || 'none'}; stopped ${stopped.join(', ') || 'none'}`);
    }
    if (after.analysisFps !== before.analysisFps) {
      this.deps.analysisGrabber.setStreamFps(after.analysisFps);
      changes.push(`analysis ${after.analysisFps} fps`);
    }
    if (after.overlayFps !== before.overlayFps) {
      this.deps.overlayGrabber?.setStreamFps(after.overlayFps);
      changes.push(`overlay ${after.overlayFps} fps`);
    }
    if (after.overlayModel !== before.overlayModel) {
      this.deps.onOverlayModelChange();
      changes.push(`overlay model ${after.overlayModel}`);
    }
    if (after.overlayConfidence !== before.overlayConfidence) changes.push(`overlay confidence ${after.overlayConfidence}`);
    if (changes.length > 0) console.log(`[AdminSettings] ${changes.join('; ')}`);
    return this.describe();
  }
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}
