/**
 * Synthetic traffic footage for the end-to-end pipeline test
 * (`pipeline.test.ts`), with a known ground truth.
 *
 * Real camera footage can't be committed or fetched in CI, so this renders
 * a stand-in with the properties that matter to detection and tracking: a
 * textured (not flat) road surface, vehicles both brighter and darker than
 * it, two lanes in opposite directions with vehicles passing each other,
 * temporal sensor noise and heavy H.264 compression. The rendered clip is
 * committed next to this file; regenerate it after changing `SCENE` with:
 *
 *   npx tsx src/analysis/__fixtures__/syntheticFootage.ts
 *
 * (Rendering takes ~30s, which is why the test uses the committed clip.)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface SyntheticVehicle {
  /** Seconds into the clip the vehicle starts entering the frame. */
  enterAt: number;
  /** Lane centre line, px from the top. */
  y: number;
  /** Horizontal speed in px/s; negative moves right-to-left. */
  speed: number;
  color: string;
}

export const SCENE = {
  width: 704,
  height: 576,
  durationS: 40,
  vehicleWidth: 60,
  vehicleHeight: 35,
  vehicles: [
    { enterAt: 8, y: 250, speed: 150, color: 'white' },
    { enterAt: 10, y: 350, speed: -120, color: '0x202020' },
    { enterAt: 14, y: 250, speed: 150, color: '0x202020' },
    { enterAt: 17, y: 350, speed: -120, color: 'white' },
    { enterAt: 20, y: 250, speed: 150, color: 'white' },
    { enterAt: 24, y: 350, speed: -120, color: '0x303030' },
    { enterAt: 26, y: 250, speed: 150, color: 'white' },
  ] as SyntheticVehicle[],
};

export const SYNTHETIC_CLIP_PATH = path.join(__dirname, 'synthetic-two-lanes.mp4');

/** How long `vehicle` is (at least partly) in frame, in seconds. */
export function crossingSeconds(vehicle: SyntheticVehicle): number {
  return (SCENE.width + SCENE.vehicleWidth) / Math.abs(vehicle.speed);
}

function render(ffmpegPath: string, outPath: string): void {
  const { width, height, durationS, vehicleWidth, vehicleHeight, vehicles } = SCENE;
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x606060:s=${width}x${height}:r=25:d=${durationS}`];
  let graph = "[0]geq=lum='128+30*sin(X/23)*cos(Y/17)':cb=128:cr=128[bg0];";
  let previous = 'bg0';
  vehicles.forEach((v, i) => {
    args.push('-f', 'lavfi', '-i', `color=c=${v.color}:s=${vehicleWidth}x${vehicleHeight}:r=25:d=${durationS}`);
    const x0 = v.speed < 0 ? width : -vehicleWidth;
    const end = v.enterAt + crossingSeconds(v);
    const top = v.y - vehicleHeight / 2;
    graph += `[${previous}][${i + 1}]overlay=x='${x0}+(${v.speed})*(t-${v.enterAt})':y=${top}:eval=frame:enable='between(t,${v.enterAt},${end})'[o${i}];`;
    previous = `o${i}`;
  });
  graph += `[${previous}]noise=alls=8:allf=t[out]`;
  args.push('-filter_complex', graph, '-map', '[out]', '-c:v', 'libx264', '-crf', '30', '-pix_fmt', 'yuv420p', '-t', String(durationS), outPath);
  execFileSync(ffmpegPath, args, { stdio: 'inherit' });
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BUNDLED_FFMPEG_PATH } = require('../ffmpegRunner') as typeof import('../ffmpegRunner');
  render(BUNDLED_FFMPEG_PATH, SYNTHETIC_CLIP_PATH);
  console.log(`Wrote ${SYNTHETIC_CLIP_PATH}`);
}
