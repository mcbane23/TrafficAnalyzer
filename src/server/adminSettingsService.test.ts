import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdminSettingsService } from './adminSettingsService';
import { AnalysisSettingsStore } from './analysisSettingsStore';
import { CameraEntry } from '../types/camera';

const DEFAULTS = { analysisFps: 3, overlayFps: 3, overlayModel: 'yolo26s', overlayConfidence: 0.2 };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-settings-'));
  const store = new AnalysisSettingsStore(path.join(dir, 'settings.json'));
  const deps = {
    store,
    defaults: DEFAULTS,
    overlay: { enabled: true, device: 'GPU', models: ['yolo26n', 'yolo26s', 'yolo26m'] },
    listCameras: async () =>
      [
        { id: 'a', name: 'A', status: 'active' },
        { id: 'b', name: 'B', status: 'inactive' },
      ] as CameraEntry[],
    analysis: { setEnabledCameras: jest.fn(async (ids: string[]) => ({ started: ids, stopped: [] })) },
    analysisGrabber: { setStreamFps: jest.fn() },
    overlayGrabber: { setStreamFps: jest.fn() },
    onOverlayModelChange: jest.fn(),
  };
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  return { service: new AdminSettingsService(deps), deps, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('AdminSettingsService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('starts with no camera analyzed and every knob at its default', async () => {
    const { service, cleanup } = setup();
    expect(service.effective()).toEqual(DEFAULTS);
    const described = await service.describe();
    expect(described.settings).toEqual({ enabledCameras: [] });
    expect(described.cameras).toEqual([
      { id: 'a', name: 'A', active: true, enabled: false },
      { id: 'b', name: 'B', active: false, enabled: false },
    ]);
    cleanup();
  });

  it('saves a change and applies only what changed', async () => {
    const { service, deps, store, cleanup } = setup();
    await service.update({ enabledCameras: ['a'], analysisFps: 2, overlayModel: 'yolo26m' });

    expect(store.load()).toEqual({ enabledCameras: ['a'], analysisFps: 2, overlayModel: 'yolo26m' });
    expect(deps.analysis.setEnabledCameras).toHaveBeenCalledWith(['a']);
    expect(deps.analysisGrabber.setStreamFps).toHaveBeenCalledWith(2);
    expect(deps.overlayGrabber.setStreamFps).not.toHaveBeenCalled();
    expect(deps.onOverlayModelChange).toHaveBeenCalledTimes(1);

    // Clearing a knob goes back to its default; unchanged cameras aren't re-applied.
    await service.update({ enabledCameras: ['a'], overlayModel: 'yolo26m', overlayConfidence: 0.3 });
    expect(deps.analysis.setEnabledCameras).toHaveBeenCalledTimes(1);
    expect(deps.analysisGrabber.setStreamFps).toHaveBeenLastCalledWith(3);
    expect(deps.onOverlayModelChange).toHaveBeenCalledTimes(1);
    expect(service.effective().overlayConfidence).toBe(0.3);
    cleanup();
  });

  it('ignores a model that is not available', async () => {
    const { service, deps, cleanup } = setup();
    await service.update({ enabledCameras: [], overlayModel: 'yolov99' });
    expect(service.effective().overlayModel).toBe('yolo26s');
    expect(deps.onOverlayModelChange).not.toHaveBeenCalled();
    cleanup();
  });
});
