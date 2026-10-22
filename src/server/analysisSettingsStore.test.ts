import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnalysisSettingsStore, normalizeAnalysisSettings } from './analysisSettingsStore';

describe('AnalysisSettingsStore', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-settings-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('defaults to analyzing no camera when there is no file yet', () => {
    expect(new AnalysisSettingsStore(path.join(dir, 'missing.json')).load()).toEqual({ enabledCameras: [] });
  });

  it('round-trips what it saved', () => {
    const store = new AnalysisSettingsStore(path.join(dir, 'nested', 'settings.json'));
    store.save({ enabledCameras: ['a', 'b'], analysisFps: 2, overlayModel: 'yolo26n' });
    expect(store.load()).toEqual({ enabledCameras: ['a', 'b'], analysisFps: 2, overlayModel: 'yolo26n' });
  });

  it('falls back to the defaults for a corrupt file', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{not json');
    expect(new AnalysisSettingsStore(file).load()).toEqual({ enabledCameras: [] });
  });
});

describe('normalizeAnalysisSettings', () => {
  it('drops malformed fields and duplicate ids', () => {
    expect(normalizeAnalysisSettings({ enabledCameras: ['a', 3, 'a', null, 'b'], analysisFps: 'fast', overlayModel: 7 })).toEqual({
      enabledCameras: ['a', 'b'],
    });
    expect(normalizeAnalysisSettings(null)).toEqual({ enabledCameras: [] });
  });

  it('clamps the knobs to their limits and steps', () => {
    expect(normalizeAnalysisSettings({ enabledCameras: [], analysisFps: 0.1, overlayFps: 2.3, overlayConfidence: 0.333 })).toEqual({
      enabledCameras: [],
      analysisFps: 0.5,
      overlayFps: 2.5,
      overlayConfidence: 0.33,
    });
    expect(normalizeAnalysisSettings({ enabledCameras: [], analysisFps: 50, overlayConfidence: 2 })).toMatchObject({ analysisFps: 10, overlayConfidence: 0.95 });
  });

  it('keeps a model only if it is one of the allowed ones', () => {
    expect(normalizeAnalysisSettings({ enabledCameras: [], overlayModel: 'yolo26m' }, ['yolo26n', 'yolo26m']).overlayModel).toBe('yolo26m');
    expect(normalizeAnalysisSettings({ enabledCameras: [], overlayModel: 'yolov9' }, ['yolo26n', 'yolo26m']).overlayModel).toBeUndefined();
  });
});
