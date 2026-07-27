import { CameraService, CameraSource } from './cameraService';
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
    status: 'active',
    lastVerifiedAt: null,
    lastError: null,
    ...overrides,
  };
}

function makeFakeSource(entries: CameraEntry[]): CameraSource {
  return { load: jest.fn(async () => entries) };
}

describe('CameraService', () => {
  it('returns every camera from the source', async () => {
    const entries = [makeCamera({ id: 'a' }), makeCamera({ id: 'b' })];
    const service = new CameraService(makeFakeSource(entries));

    const result = await service.listCameras();

    expect(result).toEqual(entries);
  });

  it('returns the camera matching the requested id', async () => {
    const target = makeCamera({ id: 'brankov-most', name: 'Brankov Most' });
    const entries = [makeCamera({ id: 'other' }), target];
    const service = new CameraService(makeFakeSource(entries));

    const result = await service.getCameraById('brankov-most');

    expect(result).toEqual(target);
  });

  it('returns undefined when no camera matches the requested id', async () => {
    const entries = [makeCamera({ id: 'a' }), makeCamera({ id: 'b' })];
    const service = new CameraService(makeFakeSource(entries));

    const result = await service.getCameraById('does-not-exist');

    expect(result).toBeUndefined();
  });
});
