import fs from 'node:fs';
import { AppVersion } from '../types/admin';

/**
 * Which build of the app is running, for the Admin page. The Docker image
 * gets APP_VERSION (the git tag it was built from, e.g. v1.3), GIT_SHA and
 * BUILD_DATE as build args from CI; a local run falls back to package.json's
 * version and no commit.
 */
export function readAppVersion(env: NodeJS.ProcessEnv, packageJsonPath: string): AppVersion {
  let packageVersion = 'dev';
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version) packageVersion = parsed.version;
  } catch {
    // No package.json next to the build: keep 'dev'.
  }
  const value = (name: string) => env[name]?.trim() || null;
  return {
    version: value('APP_VERSION') ?? packageVersion,
    commit: value('GIT_SHA'),
    builtAt: value('BUILD_DATE'),
  };
}
