import fs from 'node:fs';
import type { CameraEntry } from '../types/camera';
import path from 'node:path';

/**
 * Copies every file of `defaultsDir` (the camera registry and its schema
 * baked into the image) that `targetDir` lacks, and returns the names copied.
 * Files already there are never touched, so registry edits survive.
 *
 * This is what makes an empty data mount work: a Docker named volume is
 * seeded from the image on first use, but a bind mount such as `./data`
 * starts empty and hides the image's `data/cameras`, and the server then
 * failed to start without `belgrade.json`. A missing `defaultsDir` (a
 * checkout, where the registry already sits in `data/`) copies nothing.
 */
export function seedMissingFiles(defaultsDir: string, targetDir: string): string[] {
  if (!fs.existsSync(defaultsDir)) return [];
  fs.mkdirSync(targetDir, { recursive: true });
  const copied: string[] = [];
  for (const entry of fs.readdirSync(defaultsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const target = path.join(targetDir, entry.name);
    if (fs.existsSync(target)) continue;
    fs.copyFileSync(path.join(defaultsDir, entry.name), target);
    copied.push(entry.name);
  }
  return copied;
}

/**
 * Gives cameras in the data volume's registry the map position the image's
 * default registry has for the same id, where they have none yet. A volume
 * keeps the registry it was first seeded with, so positions added to the
 * defaults later would otherwise never reach it. A position set on the Admin
 * page is never overwritten. Returns the ids it filled.
 */
export function fillMissingPositions(entries: CameraEntry[], defaults: CameraEntry[]): string[] {
  const positions = new Map(
    defaults
      .filter((camera) => camera.location.lat !== undefined && camera.location.lon !== undefined)
      .map((camera) => [camera.id, { lat: camera.location.lat!, lon: camera.location.lon! }]),
  );
  const filled: string[] = [];
  for (const camera of entries) {
    const position = positions.get(camera.id);
    if (!position || camera.location.lat !== undefined || camera.location.lon !== undefined) continue;
    camera.location = { ...camera.location, ...position };
    filled.push(camera.id);
  }
  return filled;
}
