import { CameraSource } from './cameraService';

/**
 * Result of fetching a single upstream resource (an HLS playlist or one of
 * its `.ts` segments).
 */
export interface ProxyFetchResult {
  status: number;
  contentType: string | null;
  body: Buffer;
}

/**
 * A function that fetches a resource with the given headers. Kept as a
 * narrow, injectable seam so `HlsProxyService` can be unit tested without
 * making real network requests.
 */
export type ResourceFetcher = (url: string, headers: Record<string, string>) => Promise<ProxyFetchResult>;

async function defaultFetcher(url: string, headers: Record<string, string>): Promise<ProxyFetchResult> {
  const response = await fetch(url, { headers });
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, contentType: response.headers.get('content-type'), body };
}

/**
 * Some camera providers (e.g. the `naxi.uzivokamere.com` relay) enforce
 * hotlink protection that requires a specific `Referer` header. Browsers
 * won't let a page forge a third-party Referer for its own requests, so
 * these streams can't be embedded directly in the frontend player.
 *
 * HlsProxyService is the deep module that makes them playable anyway: given
 * a camera id and a requested file (the playlist itself, e.g.
 * `index.m3u8`, or one of its segments, e.g. `vuk-0.ts`), it resolves the
 * file against the camera's true upstream URL, fetches it server-side with
 * the camera's configured headers, and returns the raw response so it can
 * be re-served from our own origin.
 *
 * The same logic applies to a camera's `alternateUrl` (its fallback
 * stream) when that alternate also needs special headers - pass
 * `variant: 'alternate'` to proxy against `alternateUrl`/`alternateHeaders`
 * instead of `url`/`headers`.
 *
 * Only cameras with the relevant headers configured are proxied - a
 * camera without configured headers is meant to be played directly, so
 * `fetchResource` returns `null` for it (as it does for an unknown camera
 * id, or a requested `alternate` variant with no `alternateUrl`).
 */
export class HlsProxyService {
  constructor(
    private readonly source: CameraSource,
    private readonly fetcher: ResourceFetcher = defaultFetcher,
  ) {}

  async fetchResource(
    cameraId: string,
    file: string,
    variant: 'primary' | 'alternate' = 'primary',
  ): Promise<ProxyFetchResult | null> {
    const entries = await this.source.load();
    const camera = entries.find((entry) => entry.id === cameraId);
    if (!camera) {
      return null;
    }

    const baseUrl = variant === 'alternate' ? camera.alternateUrl : camera.url;
    const headers = variant === 'alternate' ? camera.alternateHeaders : camera.headers;
    if (!baseUrl || !headers || Object.keys(headers).length === 0) {
      return null;
    }

    const upstreamUrl = new URL(file, baseUrl).toString();
    return this.fetcher(upstreamUrl, headers);
  }
}
