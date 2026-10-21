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

  it('lets the live analysis apply the new statuses after saving, before reporting the run finished', async () => {
    const store = makeFakeStore([makeCamera({ id: 'a' })]);
    const validator = makeInstantValidator({ a: { cameraId: 'a', status: 'active', checkedAt: '2026-01-01T00:00:00.000Z' } });
    const seen: Array<{ saved: number; state: string }> = [];
    const service = new RevalidationService(store, validator, undefined, undefined, () => {
      seen.push({ saved: store.saved.length, state: service.getStatus().state });
    });

    service.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen).toEqual([{ saved: 1, state: 'running' }]);
    expect(service.getStatus()).toMatchObject({ state: 'idle', error: null });
  });

  it('still reports a successful check when applying the new statuses fails', async () => {
    const store = makeFakeStore([makeCamera({ id: 'a' })]);
    const validator = makeInstantValidator({ a: { cameraId: 'a', status: 'active', checkedAt: '2026-01-01T00:00:00.000Z' } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new RevalidationService(store, validator, undefined, undefined, async () => {
      throw new Error('registry unreadable');
    });

    service.start();
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.getStatus()).toMatchObject({ state: 'idle', error: null, active: 1 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
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

  it('checks cameras in parallel up to the configured concurrency', async () => {
    const entries = Array.from({ length: 7 }, (_, i) => makeCamera({ id: `cam-${i}` }));
    const store = makeFakeStore(entries);

    let inFlight = 0;
    let maxInFlight = 0;
    const validator: CameraValidatorLike = {
      validate: jest.fn(async (camera: CameraEntry) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { cameraId: camera.id, status: 'active' as const, checkedAt: '2026-01-01T00:00:00.000Z' };
      }),
    };
    const service = new RevalidationService(store, validator, () => new Date('2026-01-01T00:00:00.000Z'), 3);

    service.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(maxInFlight).toBe(3);
    expect(validator.validate).toHaveBeenCalledTimes(7);
    expect(service.getStatus()).toMatchObject({ state: 'idle', total: 7, checked: 7, active: 7 });
    expect(store.saved).toHaveLength(1);
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
