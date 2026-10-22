import { spawn } from 'node:child_process';
import { CameraEntry } from '../types/camera';
import { FFMPEG_PATH } from './ffmpegRunner';
import { DEFAULT_FRAME_HEIGHT, DEFAULT_FRAME_WIDTH, cameraInputArgs } from './frameGrabber';
import { VideoFrame, yuv420pFrameSize } from './videoFrame';

/** Runs ffmpeg to completion; rejects with its first error line (or exit code) on failure, or after `timeoutMs`. */
function runFfmpeg(args: string[], timeoutMs: number, ffmpegPath: string, onStdout?: (child: ReturnType<typeof spawn>) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    onStdout?.(child);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg failed to run: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const line = stderr.split('\n').map((l) => l.trim()).find(Boolean);
        reject(new Error(line ?? (signal ? `ffmpeg was stopped (${signal})` : `ffmpeg exited with code ${code}`)));
      }
    });
  });
}

/**
 * Records `seconds` of a camera's stream into an MP4 file the browser can
 * play, copying the video as it arrives (no re-encoding, so it costs next
 * to no CPU). Only streams already in H.264/HEVC, like every HLS camera in
 * the registry, can be copied into MP4.
 */
export function recordClip(camera: CameraEntry, file: string, seconds: number, ffmpegPath: string = FFMPEG_PATH): Promise<void> {
  const args = [
    ...cameraInputArgs(camera),
    '-t', String(seconds),
    '-map', '0:v:0', '-an', '-c:v', 'copy',
    '-movflags', '+faststart',
    '-f', 'mp4', '-y', file,
  ];
  // The stream plays in real time, so the recording takes `seconds`; allow a minute on top for a slow start.
  return runFfmpeg(args, (seconds + 60) * 1000, ffmpegPath);
}

/**
 * Decodes a clip at `fps` into the same frames the live analysis gets
 * (`FrameGrabber`'s size and area scaling, yuv420p), calling `onFrame` with each one in
 * order. ffmpeg is paused while `onFrame` runs, so a slow analysis never
 * piles frames up in memory.
 */
export function decodeClip(
  file: string,
  fps: number,
  onFrame: (frame: VideoFrame, index: number) => Promise<void>,
  ffmpegPath: string = FFMPEG_PATH,
): Promise<void> {
  const width = DEFAULT_FRAME_WIDTH;
  const height = DEFAULT_FRAME_HEIGHT;
  const frameBytes = yuv420pFrameSize(width, height);
  const args = [
    '-hide_banner', '-nostats', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
    '-i', file,
    '-vf', `fps=${fps},scale=${width}:${height}:flags=area,format=yuv420p`,
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1',
  ];
  let failure: unknown = null;
  let pending = Promise.resolve();
  const decoded = runFfmpeg(args, 30 * 60 * 1000, ffmpegPath, (child) => {
    let buffer: Buffer = Buffer.alloc(0);
    let index = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      const frames: VideoFrame[] = [];
      while (buffer.length >= frameBytes) {
        frames.push({ width, height, data: new Uint8Array(buffer.subarray(0, frameBytes)) });
        buffer = buffer.subarray(frameBytes);
      }
      if (!frames.length) return;
      child.stdout?.pause();
      pending = pending
        .then(async () => {
          for (const frame of frames) {
            if (failure) return;
            await onFrame(frame, index++);
          }
        })
        .catch((err) => {
          failure = err;
          child.kill('SIGKILL');
        })
        .finally(() => child.stdout?.resume());
    });
  });
  return decoded.then(
    async () => {
      await pending;
      if (failure) throw failure;
    },
    async (err) => {
      await pending;
      throw failure ?? err;
    },
  );
}
