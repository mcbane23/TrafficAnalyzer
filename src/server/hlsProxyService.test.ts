import { HlsProxyService, ProxyFetchResult, ResourceFetcher } from './hlsProxyService';
import { CameraSource } from './cameraService';
import { CameraEntry } from '../types/camera';

function makeCamera(overrides: Partial<CameraEntry> = {}): CameraEntry {
  return {
    id: 'vukov-spomenik',
    name: 'Vukov Spomenik',
    location: { address: 'Vukov Spomenik' },
    resolution: null,
    source: 'naxi.uzivokamere.com relay',
    url: 'https://naxi.uzivokamere.com/vuk/index.m3u8',
    protocol: 'HLS',
    status: 'active',
    lastVerifiedAt: null,
    lastError: null,
    headers: { Referer: 'https://uzivokamere.com/' },
    ...overrides,
  };
}

function makeFakeSource(entries: CameraEntry[]): CameraSource {
  return { load: jest.fn(async () => entries) };
}

function makeFakeFetcher(result: ProxyFetchResult): ResourceFetcher {
  return jest.fn(async () => result);
}

describe('HlsProxyService', () => {
  it('resolves the requested file against the camera url and forwards its headers', async () => {
    const camera = makeCamera();
    const fetcher = makeFakeFetcher({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: Buffer.from('#EXTM3U') });
    const service = new HlsProxyService(makeFakeSource([camera]), fetcher);

    const result = await service.fetchResource('vukov-spomenik', 'index.m3u8');

    expect(fetcher).toHaveBeenCalledWith('https://naxi.uzivokamere.com/vuk/index.m3u8', { Referer: 'https://uzivokamere.com/' });
    expect(result).toEqual({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: Buffer.from('#EXTM3U') });
  });

  it('resolves a segment file relative to the playlist directory', async () => {
    const camera = makeCamera();
    const fetcher = makeFakeFetcher({ status: 200, contentType: 'video/mp2t', body: Buffer.from('segment') });
    const service = new HlsProxyService(makeFakeSource([camera]), fetcher);

    await service.fetchResource('vukov-spomenik', 'vuk-0.ts');

    expect(fetcher).toHaveBeenCalledWith('https://naxi.uzivokamere.com/vuk/vuk-0.ts', expect.any(Object));
  });

  it('returns null for an unknown camera id', async () => {
    const service = new HlsProxyService(makeFakeSource([makeCamera()]), makeFakeFetcher({ status: 200, contentType: null, body: Buffer.from('') }));

    const result = await service.fetchResource('does-not-exist', 'index.m3u8');

    expect(result).toBeNull();
  });

  it('returns null for a camera with no configured headers', async () => {
    const camera = makeCamera({ id: 'brankov-most', headers: undefined });
    const service = new HlsProxyService(makeFakeSource([camera]), makeFakeFetcher({ status: 200, contentType: null, body: Buffer.from('') }));

    const result = await service.fetchResource('brankov-most', 'index.m3u8');

    expect(result).toBeNull();
  });

  it('resolves the requested file against alternateUrl and forwards alternateHeaders when variant is "alternate"', async () => {
    const camera = makeCamera({
      alternateUrl: 'https://example.com/alt/index.m3u8',
      alternateHeaders: { Referer: 'https://example.com/' },
    });
    const fetcher = makeFakeFetcher({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: Buffer.from('#EXTM3U') });
    const service = new HlsProxyService(makeFakeSource([camera]), fetcher);

    await service.fetchResource('vukov-spomenik', 'index.m3u8', 'alternate');

    expect(fetcher).toHaveBeenCalledWith('https://example.com/alt/index.m3u8', { Referer: 'https://example.com/' });
  });

  it('returns null for the alternate variant when the camera has no alternateUrl', async () => {
    const camera = makeCamera({ alternateUrl: undefined, alternateHeaders: undefined });
    const service = new HlsProxyService(makeFakeSource([camera]), makeFakeFetcher({ status: 200, contentType: null, body: Buffer.from('') }));

    const result = await service.fetchResource('vukov-spomenik', 'index.m3u8', 'alternate');

    expect(result).toBeNull();
  });

  // The `file` value reaches this service from a URL path parameter that
  // Express percent-decodes, so a caller can present it already containing
  // slashes or a scheme. Resolving those would send the camera's configured
  // headers (a provider Referer/token) to a host of the caller's choosing.
  it.each([
    ['an absolute http url', 'http://attacker.example/steal'],
    ['an absolute https url', 'https://attacker.example/steal'],
    ['a protocol-relative url', '//attacker.example/steal'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['an absolute path', '/other-camera/index.m3u8'],
    ['a parent-directory traversal', '../private/index.m3u8'],
    ['a nested traversal', 'a/../../private/index.m3u8'],
    ['a backslash path', '..\\private\\index.m3u8'],
    ['an empty file name', ''],
  ])('returns null without fetching for %s', async (_label, file) => {
    const fetcher = makeFakeFetcher({ status: 200, contentType: null, body: Buffer.from('') });
    const service = new HlsProxyService(makeFakeSource([makeCamera()]), fetcher);

    expect(await service.fetchResource('vukov-spomenik', file)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('allows a segment in a subdirectory of the playlist', async () => {
    const fetcher = makeFakeFetcher({ status: 200, contentType: 'video/mp2t', body: Buffer.from('segment') });
    const service = new HlsProxyService(makeFakeSource([makeCamera()]), fetcher);

    await service.fetchResource('vukov-spomenik', 'chunks/vuk-0.ts');

    expect(fetcher).toHaveBeenCalledWith('https://naxi.uzivokamere.com/vuk/chunks/vuk-0.ts', expect.any(Object));
  });

  it('returns null for the alternate variant when alternateUrl has no configured alternateHeaders', async () => {
    const camera = makeCamera({ alternateUrl: 'https://example.com/alt/index.m3u8', alternateHeaders: undefined });
    const service = new HlsProxyService(makeFakeSource([camera]), makeFakeFetcher({ status: 200, contentType: null, body: Buffer.from('') }));

    const result = await service.fetchResource('vukov-spomenik', 'index.m3u8', 'alternate');

    expect(result).toBeNull();
  });
});
