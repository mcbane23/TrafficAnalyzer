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

  async listCameras(): Promise<CameraEntry[]> {
    return this.source.load();
  }

  async getCameraById(id: string): Promise<CameraEntry | undefined> {
    const entries = await this.source.load();
    return entries.find((entry) => entry.id === id);
  }
}
