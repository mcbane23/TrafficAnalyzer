import { CameraEntry, RevalidationStatus, ValidationResult } from '../types/camera';
import { CameraSource } from './cameraService';

/**
 * Narrow seam for the registry store this service needs: load the current
 * entries, and persist them back once validation has updated their status.
 * `CameraRegistryStore` satisfies this structurally.
 */
export interface CameraRegistryWriter extends CameraSource {
  save(entries: CameraEntry[]): Promise<void>;
}

/**
 * Narrow seam for the validator this service needs, so tests can inject a
 * fake without shelling out to ffprobe. `CameraValidator` satisfies this
 * structurally.
 */
export interface CameraValidatorLike {
  validate(camera: CameraEntry): Promise<ValidationResult>;
}

const IDLE_STATUS: RevalidationStatus = {
  state: 'idle',
  total: 0,
  checked: 0,
  active: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
};

/**
 * RevalidationService runs the same availability check as the
 * `cameras:revalidate` CLI, but as an in-process background job that the
 * web API can trigger on demand (e.g. from a dashboard button) instead of
 * requiring a separate command-line invocation.
 *
 * Only one run is allowed at a time - `start()` is a no-op (beyond
 * reporting the current status) if a run is already in progress. Progress
 * is tracked in memory only: it resets on server restart and isn't shared
 * across multiple server instances.
 */
export class RevalidationService {
  private status: RevalidationStatus = { ...IDLE_STATUS };

  constructor(
    private readonly store: CameraRegistryWriter,
    private readonly validator: CameraValidatorLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getStatus(): RevalidationStatus {
    return { ...this.status };
  }

  /** Starts a background revalidation run if one isn't already in progress. */
  start(): { started: boolean; status: RevalidationStatus } {
    if (this.status.state === 'running') {
      return { started: false, status: this.getStatus() };
    }

    this.status = {
      state: 'running',
      total: 0,
      checked: 0,
      active: 0,
      startedAt: this.now().toISOString(),
      finishedAt: null,
      error: null,
    };

    // Intentionally not awaited: this kicks off a background job and
    // returns immediately so the HTTP request doesn't block on it.
    this.run().catch((err) => {
      this.status = {
        ...this.status,
        state: 'idle',
        finishedAt: this.now().toISOString(),
        error: err instanceof Error ? err.message : 'Revalidation failed',
      };
    });

    return { started: true, status: this.getStatus() };
  }

  private async run(): Promise<void> {
    const entries = await this.store.load();
    this.status.total = entries.length;

    for (const entry of entries) {
      const result = await this.validator.validate(entry);
      entry.status = result.status;
      entry.lastVerifiedAt = result.checkedAt;
      entry.lastError = result.error ?? null;
      if (result.resolution) {
        entry.resolution = result.resolution;
      }

      this.status.checked += 1;
      if (result.status === 'active') {
        this.status.active += 1;
      }
    }

    await this.store.save(entries);
    this.status.state = 'idle';
    this.status.finishedAt = this.now().toISOString();
  }
}
