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

    const upstreamUrl = resolveUpstreamUrl(baseUrl, file);
    if (!upstreamUrl) {
      return null;
    }

    return this.fetcher(upstreamUrl, headers);
  }
}

/**
 * Resolves a requested file against the camera's upstream playlist URL,
 * returning null if it doesn't resolve to a sibling of that playlist.
 *
 * This check is load-bearing, not defensive tidiness: `file` comes
 * straight from a URL path parameter that Express percent-decodes, so
 * without it a request for `http:%2F%2Fattacker.example%2Fx` would decode
 * to an absolute URL, `new URL(file, baseUrl)` would honour it in place of
 * the camera's own host, and this service would then send the camera's
 * configured headers - which exist precisely because they carry a
 * provider-specific `Referer`/token - to a host of the caller's choosing,
 * returning the response body to them as well. The same decoding makes
 * `..%2F..%2F` traversal to unrelated paths on the real upstream host
 * possible.
 *
 * Only plain relative names are accepted, and the resolved URL must still
 * sit on the playlist's own origin and within its directory. That matches
 * what a real HLS client asks for anyway: hls.js resolves segment names
 * from the proxied playlist against our proxy route, whose `:file`
 * parameter is a single path segment.
 */
function resolveUpstreamUrl(baseUrl: string, file: string): string | null {
  if (file.length === 0 || file.length > 512) return null;
  // Backslashes and NULs are normalized inconsistently across URL parsers; reject rather than reason about them.
  if (file.includes('\\') || file.includes('\0')) return null;
  // Absolute paths, protocol-relative URLs ("//host/x") and absolute URLs ("https://host/x") all escape the base.
  if (file.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(file)) return null;
  if (file.split('/').includes('..')) return null;

  let base: URL;
  let resolved: URL;
  try {
    base = new URL(baseUrl);
    resolved = new URL(file, base);
  } catch {
    return null;
  }

  const baseDir = base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(baseDir)) {
    return null;
  }

  return resolved.toString();
}
