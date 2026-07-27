import { CameraValidator } from './cameraValidator';
import { ProbeOutcome, ProbeRunner } from './probeRunner';
import { CameraEntry } from '../types/camera';

function makeCamera(overrides: Partial<CameraEntry> = {}): CameraEntry {
  return {
    id: 'cam-1',
    name: 'Test Camera',
    location: { address: 'Test Square' },
    resolution: null,
    source: 'Test Source',
    url: 'https://example.com/stream.m3u8',
    protocol: 'HLS',
    status: 'inactive',
    lastVerifiedAt: null,
    lastError: null,
    ...overrides,
  };
}

function makeFakeRunner(outcome: ProbeOutcome | (() => Promise<ProbeOutcome>)): ProbeRunner {
  return jest.fn(async () => (typeof outcome === 'function' ? outcome() : outcome));
}

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

describe('CameraValidator', () => {
  it('reports a camera as active when ffprobe finds a decodable video stream', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }),
      stderr: '',
      timedOut: false,
    });
    const validator = new CameraValidator({ probeRunner: runner, now: () => FIXED_NOW });

    const result = await validator.validate(makeCamera());

    expect(result.status).toBe('active');
    expect(result.resolution).toBe('1920x1080');
    expect(result.checkedAt).toBe(FIXED_NOW.toISOString());
    expect(result.error).toBeUndefined();
  });

  it('reports a camera as inactive when ffprobe finds no video stream', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: JSON.stringify({ streams: [] }),
      stderr: '',
      timedOut: false,
    });
    const validator = new CameraValidator({ probeRunner: runner, now: () => FIXED_NOW });

    const result = await validator.validate(makeCamera());

    expect(result.status).toBe('inactive');
    expect(result.error).toBe('no decodable video stream found');
  });

  it('reports a camera as inactive when the probe times out', async () => {
    const runner = makeFakeRunner({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    const validator = new CameraValidator({ probeRunner: runner, now: () => FIXED_NOW });

    const result = await validator.validate(makeCamera());

    expect(result.status).toBe('inactive');
    expect(result.error).toBe('stream timed out');
  });

  it('reports a camera as inactive with the stderr reason when ffprobe exits non-zero', async () => {
    const runner = makeFakeRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'Connection refused\nsome other detail',
      timedOut: false,
    });
    const validator = new CameraValidator({ probeRunner: runner, now: () => FIXED_NOW });

    const result = await validator.validate(makeCamera());

    expect(result.status).toBe('inactive');
    expect(result.error).toBe('Connection refused');
  });

  it('reports a camera as inactive when ffprobe output cannot be parsed', async () => {
    const runner = makeFakeRunner({ exitCode: 0, stdout: 'not json', stderr: '', timedOut: false });
    const validator = new CameraValidator({ probeRunner: runner, now: () => FIXED_NOW });

    const result = await validator.validate(makeCamera());

    expect(result.status).toBe('inactive');
    expect(result.error).toBe('could not parse ffprobe output');
  });

  it('reports a camera as inactive when the probe runner throws', async () => {
    const runner: ProbeRunner = jest.fn(async () => {
      throw new Error('spawn ENOENT');
    });
    const validator = new CameraValidator({ probeRunner: runner, now: () => FIXED_NOW });

    const result = await validator.validate(makeCamera());

    expect(result.status).toBe('inactive');
    expect(result.error).toContain('spawn ENOENT');
  });

  it('adds the -rtsp_transport tcp flag for RTSP cameras', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: JSON.stringify({ streams: [{ width: 640, height: 480 }] }),
      stderr: '',
      timedOut: false,
    });
    const validator = new CameraValidator({ probeRunner: runner, now: () => FIXED_NOW });

    await validator.validate(makeCamera({ protocol: 'RTSP', url: 'rtsp://example.com/stream' }));

    expect(runner).toHaveBeenCalledWith(expect.arrayContaining(['-rtsp_transport', 'tcp']), expect.any(Number));
  });

  it('does not add the -rtsp_transport flag for non-RTSP cameras', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: JSON.stringify({ streams: [{ width: 640, height: 480 }] }),
      stderr: '',
      timedOut: false,
    });
    const validator = new CameraValidator({ probeRunner: runner, now: () => FIXED_NOW });

    await validator.validate(makeCamera({ protocol: 'HTTP', url: 'http://example.com/snapshot.mjpg' }));

    expect(runner).toHaveBeenCalledWith(expect.not.arrayContaining(['-rtsp_transport']), expect.any(Number));
  });
});
