import { RevalidationService, CameraRegistryWriter, CameraValidatorLike } from './revalidationService';
import { CameraEntry, ValidationResult } from '../types/camera';

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

function makeFakeStore(entries: CameraEntry[]): CameraRegistryWriter & { saved: CameraEntry[][] } {
  const saved: CameraEntry[][] = [];
  return {
    load: jest.fn(async () => entries),
    save: jest.fn(async (data: CameraEntry[]) => {
      saved.push(data);
    }),
    saved,
  };
}

/** Resolves validate() only once flush() is called, to simulate an in-flight async run. */
function makeControllableValidator(): CameraValidatorLike & { flush: (result: ValidationResult) => void } {
  let resolveFn: ((result: ValidationResult) => void) | null = null;
  const pending = new Promise<ValidationResult>((resolve) => {
    resolveFn = resolve;
  });
  return {
    validate: jest.fn(async () => pending),
    flush: (result) => resolveFn?.(result),
  };
}

function makeInstantValidator(results: Record<string, ValidationResult>): CameraValidatorLike {
  return {
    validate: jest.fn(async (camera: CameraEntry) => results[camera.id]),
  };
}

describe('RevalidationService', () => {
  it('reports idle status before any run', () => {
    const service = new RevalidationService(makeFakeStore([]), makeInstantValidator({}));

    expect(service.getStatus()).toEqual({
      state: 'idle',
      total: 0,
      checked: 0,
      active: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
    });
  });

  it('validates every camera, updates their status, and persists the result', async () => {
    const entries = [makeCamera({ id: 'a' }), makeCamera({ id: 'b' })];
    const store = makeFakeStore(entries);
    const validator = makeInstantValidator({
      a: { cameraId: 'a', status: 'active', checkedAt: '2026-01-01T00:00:00.000Z', resolution: '1920x1080' },
      b: { cameraId: 'b', status: 'inactive', checkedAt: '2026-01-01T00:00:00.000Z', error: 'timed out' },
    });
    const service = new RevalidationService(store, validator, () => new Date('2026-01-01T00:00:00.000Z'));

    const { started } = service.start();
    expect(started).toBe(true);

    // Let the fire-and-forget async run drain the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));

    const status = service.getStatus();
    expect(status).toEqual({
      state: 'idle',
      total: 2,
      checked: 2,
      active: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.000Z',
      error: null,
    });

    expect(entries[0]).toMatchObject({ id: 'a', status: 'active', resolution: '1920x1080', lastError: null });
    expect(entries[1]).toMatchObject({ id: 'b', status: 'inactive', lastError: 'timed out' });
    expect(store.saved).toHaveLength(1);
  });

  it('does not start a second run while one is already in progress', async () => {
    const entries = [makeCamera({ id: 'a' })];
    const store = makeFakeStore(entries);
    const validator = makeControllableValidator();
    const service = new RevalidationService(store, validator);

    const first = service.start();
    expect(first.started).toBe(true);
    expect(service.getStatus().state).toBe('running');

    const second = service.start();
    expect(second.started).toBe(false);
    expect(second.status.state).toBe('running');

    validator.flush({ cameraId: 'a', status: 'active', checkedAt: new Date().toISOString() });
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.getStatus().state).toBe('idle');
  });

  it('marks the run as idle with an error message if validation throws', async () => {
    const entries = [makeCamera({ id: 'a' })];
    const store = makeFakeStore(entries);
    const validator: CameraValidatorLike = {
      validate: jest.fn(async () => {
        throw new Error('boom');
      }),
    };
    const service = new RevalidationService(store, validator);

    service.start();
    await new Promise((resolve) => setImmediate(resolve));

    const status = service.getStatus();
    expect(status.state).toBe('idle');
    expect(status.error).toBe('boom');
  });
});
