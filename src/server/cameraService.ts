import { CameraEntry } from '../types/camera';

/**
 * Narrow seam `CameraService` depends on to load the camera registry.
 * `CameraRegistryStore` satisfies this structurally, but tests can supply
 * a fake without touching the filesystem or schema validation.
 */
export interface CameraSource {
  load(): Promise<CameraEntry[]>;
}

/**
 * CameraService is the deep module behind the camera web API: given a
 * registry source, it answers "list all cameras" and "get one camera by
 * id" - the two questions the dashboard and detail page need answered.
 *
 * It has no knowledge of HTTP/Express - camera entries in, camera
 * entries (or `undefined`) out - which keeps it simple to unit test and
 * reusable regardless of how it's eventually exposed.
 */
export class CameraService {
  constructor(private readonly source: CameraSource) {}

  /** The cameras the dashboard and statistics show: every one not hidden on the Admin page. */
  async listCameras(): Promise<CameraEntry[]> {
    const entries = await this.source.load();
    return entries.filter((entry) => !entry.hidden).map((entry) => this.toPublicCamera(entry));
  }

  /** Every camera, hidden ones included, for the Admin page's camera list. */
  async listAllCameras(): Promise<CameraEntry[]> {
    const entries = await this.source.load();
    return entries.map((entry) => this.toPublicCamera(entry));
  }

  async getCameraById(id: string): Promise<CameraEntry | undefined> {
    const entries = await this.source.load();
    const entry = entries.find((e) => e.id === id);
    return entry ? this.toPublicCamera(entry) : undefined;
  }

  /**
   * Cameras that require special request headers (e.g. a `Referer` some
   * providers enforce to defeat hotlink protection) can't be played
   * directly by the frontend - browsers won't let a page forge a
   * third-party Referer for its own requests. For those (and equally for
   * an `alternateUrl` that needs its own headers), expose a same-origin
   * proxy URL (served by `HlsProxyService`) instead of the raw upstream
   * url, and drop `headers`/`alternateHeaders` from the public response
   * since they're internal fetch details the client has no use for.
   */
  private toPublicCamera(entry: CameraEntry): CameraEntry {
    const needsProxy = (headers?: Record<string, string>) => !!headers && Object.keys(headers).length > 0;
    const primaryNeedsProxy = needsProxy(entry.headers);
    const alternateNeedsProxy = needsProxy(entry.alternateHeaders);

    if (!primaryNeedsProxy && !alternateNeedsProxy) {
      return entry;
    }

    const { headers: _headers, alternateHeaders: _alternateHeaders, ...rest } = entry;
    return {
      ...rest,
      url: primaryNeedsProxy ? `/api/cameras/${entry.id}/stream/index.m3u8` : entry.url,
      alternateUrl:
        entry.alternateUrl && alternateNeedsProxy
          ? `/api/cameras/${entry.id}/stream-alt/index.m3u8`
          : entry.alternateUrl,
    };
  }
}
