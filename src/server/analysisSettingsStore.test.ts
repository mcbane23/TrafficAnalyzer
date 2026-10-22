import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnalysisSettingsStore, normalizeAnalysisSettings } from './analysisSettingsStore';

describe('AnalysisSettingsStore', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-settings-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('defaults to analyzing everything when there is no file yet', () => {
    expect(new AnalysisSettingsStore(path.join(dir, 'missing.json')).load()).toEqual({ enabled: true, disabledCameras: [] });
  });

  it('round-trips what it saved', () => {
    const store = new AnalysisSettingsStore(path.join(dir, 'nested', 'settings.json'));
    store.save({ enabled: false, disabledCameras: ['a', 'b'] });
    expect(store.load()).toEqual({ enabled: false, disabledCameras: ['a', 'b'] });
  });

  it('falls back to the defaults for a corrupt file', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{not json');
    expect(new AnalysisSettingsStore(file).load()).toEqual({ enabled: true, disabledCameras: [] });
  });
});

describe('normalizeAnalysisSettings', () => {
  it('drops malformed fields and duplicate ids', () => {
    expect(normalizeAnalysisSettings({ enabled: 'yes', disabledCameras: ['a', 3, 'a', null, 'b'] })).toEqual({
      enabled: true,
      disabledCameras: ['a', 'b'],
    });
    expect(normalizeAnalysisSettings(null)).toEqual({ enabled: true, disabledCameras: [] });
  });
});
