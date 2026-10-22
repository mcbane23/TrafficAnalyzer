import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAppVersion } from './appVersion';

describe('readAppVersion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-version-'));
  const packageJson = path.join(dir, 'package.json');
  fs.writeFileSync(packageJson, JSON.stringify({ version: '1.0.0' }));

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('uses the build args the image was built with', () => {
    expect(readAppVersion({ APP_VERSION: 'v1.3', GIT_SHA: 'abc123', BUILD_DATE: '2026-10-22T10:00:00Z' }, packageJson)).toEqual({
      version: 'v1.3',
      commit: 'abc123',
      builtAt: '2026-10-22T10:00:00Z',
    });
  });

  it("falls back to package.json's version, ignoring empty build args", () => {
    expect(readAppVersion({ APP_VERSION: '', GIT_SHA: ' ' }, packageJson)).toEqual({ version: '1.0.0', commit: null, builtAt: null });
    expect(readAppVersion({}, path.join(dir, 'missing.json'))).toEqual({ version: 'dev', commit: null, builtAt: null });
  });
});
