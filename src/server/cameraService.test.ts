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

  it('leaves hidden cameras out of the list, but not out of the Admin list', async () => {
    const shown = makeCamera({ id: 'a' });
    const hidden = makeCamera({ id: 'b', hidden: true });
    const service = new CameraService(makeFakeSource([shown, hidden]));

    expect(await service.listCameras()).toEqual([shown]);
    expect(await service.listAllCameras()).toEqual([shown, hidden]);
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

  it('rewrites the url to a same-origin proxy path and drops headers for cameras that need special request headers', async () => {
    const entries = [
      makeCamera({ id: 'vukov-spomenik', url: 'https://naxi.uzivokamere.com/vuk/index.m3u8', headers: { Referer: 'https://uzivokamere.com/' } }),
    ];
    const service = new CameraService(makeFakeSource(entries));

    const [result] = await service.listCameras();

    expect(result.url).toBe('/api/cameras/vukov-spomenik/stream/index.m3u8');
    expect(result.headers).toBeUndefined();
  });

  it('leaves the url untouched for cameras with no configured headers', async () => {
    const entries = [makeCamera({ id: 'brankov-most', url: 'https://streamer.devnet.rs/hls/brankov.m3u8' })];
    const service = new CameraService(makeFakeSource(entries));

    const result = await service.getCameraById('brankov-most');

    expect(result?.url).toBe('https://streamer.devnet.rs/hls/brankov.m3u8');
  });

  it('leaves a plain alternateUrl untouched when it needs no special headers', async () => {
    const entries = [
      makeCamera({
        id: 'autokomanda',
        alternateUrl: 'https://srbija-nadlanu.ott.solutions/srbija-nadlanu/autokomanda/playlist.m3u8',
        alternateSource: 'Informer.rs',
      }),
    ];
    const service = new CameraService(makeFakeSource(entries));

    const result = await service.getCameraById('autokomanda');

    expect(result?.alternateUrl).toBe('https://srbija-nadlanu.ott.solutions/srbija-nadlanu/autokomanda/playlist.m3u8');
  });

  it('rewrites alternateUrl to a same-origin proxy path and drops alternateHeaders when the alternate needs special headers', async () => {
    const entries = [
      makeCamera({
        id: 'vukov-spomenik',
        alternateUrl: 'https://example.com/alt/index.m3u8',
        alternateHeaders: { Referer: 'https://example.com/' },
      }),
    ];
    const service = new CameraService(makeFakeSource(entries));

    const [result] = await service.listCameras();

    expect(result.alternateUrl).toBe('/api/cameras/vukov-spomenik/stream-alt/index.m3u8');
    expect(result.alternateHeaders).toBeUndefined();
    // The primary url has no headers of its own, so it's left untouched.
    expect(result.url).toBe('https://example.com/stream.m3u8');
  });
});
