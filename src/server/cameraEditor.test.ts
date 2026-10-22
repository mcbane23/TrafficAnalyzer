import { CameraEntry } from '../types/camera';
import { CameraChange, CameraEditError, CameraEditor, normalizeCameraPatch, normalizeNewCamera, protocolFor, slugFor } from './cameraEditor';

function makeCamera(overrides: Partial<CameraEntry> = {}): CameraEntry {
  return {
    id: 'cam-1',
    name: 'Camera 1',
    location: { address: 'Square 1' },
    source: 'Test',
    url: 'https://example.com/cam-1.m3u8',
    protocol: 'HLS',
    status: 'active',
    lastVerifiedAt: null,
    ...overrides,
  };
}

function setup(entries: CameraEntry[] = [makeCamera()], options: { revalidating?: boolean } = {}) {
  let saved: CameraEntry[] = structuredClone(entries);
  const store = {
    load: jest.fn(async () => structuredClone(saved)),
    save: jest.fn(async (next: CameraEntry[]) => {
      saved = structuredClone(next);
    }),
  };
  const validator = {
    validate: jest.fn(async (camera: CameraEntry) => ({ cameraId: camera.id, status: 'active' as const, checkedAt: '2026-10-22T10:00:00.000Z', resolution: '704x576' })),
  };
  const changes: Array<{ camera: CameraEntry; change: CameraChange }> = [];
  const editor = new CameraEditor({
    store,
    validator,
    isRevalidating: () => options.revalidating ?? false,
    onChanged: (camera, change) => {
      changes.push({ camera, change });
    },
  });
  return { editor, store, validator, changes, saved: () => saved };
}

describe('normalizeCameraPatch', () => {
  it('trims text, clears empty direction names and drops unknown fields', () => {
    expect(normalizeCameraPatch({ name: '  Brankov   most ', address: '', directions: { a: ' Zemun ', b: '' }, url: 'x' })).toEqual({
      name: 'Brankov most',
      directions: { a: 'Zemun' },
    });
    expect(normalizeCameraPatch({ directions: { a: ' ', b: '' } })).toEqual({ directions: null });
    expect(normalizeCameraPatch({ directions: null, hidden: true })).toEqual({ directions: null, hidden: true });
    expect(normalizeCameraPatch('nonsense')).toEqual({});
  });

  it('clamps zone vertices into the frame and drops zones with fewer than 3 usable points', () => {
    const patch = normalizeCameraPatch({
      ignoreZones: [
        { name: 'Billboard', points: [[-0.2, 0.123456], [1.5, 0], [0.5, 'x'], [0.5, 1]] },
        { points: [[0, 0], [1, 1]] },
        'junk',
      ],
    });
    expect(patch.ignoreZones).toEqual([{ name: 'Billboard', points: [[0, 0.1235], [1, 0], [0.5, 1]] }]);
    expect(normalizeCameraPatch({ ignoreZones: [] })).toEqual({ ignoreZones: [] });
  });
});

describe('normalizeNewCamera', () => {
  it('guesses the protocol from the address and keeps an optional referer', () => {
    expect(normalizeNewCamera({ name: 'A', address: 'B', url: 'https://x.rs/live/index.m3u8', referer: 'https://x.rs/' })).toEqual({
      name: 'A',
      address: 'B',
      url: 'https://x.rs/live/index.m3u8',
      protocol: 'HLS',
      referer: 'https://x.rs/',
    });
  });

  it('refuses a camera without a name or with an unusable address', () => {
    expect(() => normalizeNewCamera({ address: 'B', url: 'https://x.rs/a.m3u8' })).toThrow(CameraEditError);
    expect(() => normalizeNewCamera({ name: 'A', address: 'B', url: 'not a url' })).toThrow('valid URL');
    expect(() => normalizeNewCamera({ name: 'A', address: 'B', url: 'ftp://x.rs/a' })).toThrow('must start with');
  });
});

describe('protocolFor', () => {
  it.each([
    ['rtsp://cam.local/stream', 'RTSP'],
    ['https://x.rs/a/playlist.M3U8', 'HLS'],
    ['http://x.rs/video.mjpg', 'MJPEG'],
    ['https://x.rs/snapshot.jpg', 'HTTP'],
  ])('%s is %s', (url, protocol) => {
    expect(protocolFor(new URL(url))).toBe(protocol);
  });
});

describe('slugFor', () => {
  it('makes a lowercase ASCII id, unique among the taken ones', () => {
    expect(slugFor('Đeram – Bulevar kralja Aleksandra', new Set())).toBe('djeram-bulevar-kralja-aleksandra');
    expect(slugFor('Šumice', new Set(['sumice', 'sumice-2']))).toBe('sumice-3');
    expect(slugFor('!!!', new Set())).toBe('camera');
  });
});

describe('CameraEditor', () => {
  it('saves a change and reports what kind it was', async () => {
    const t = setup();

    const camera = await t.editor.update('cam-1', { name: 'Brankov most', directions: { a: 'Zemun', b: 'Centar' } });

    expect(camera).toEqual(expect.objectContaining({ name: 'Brankov most', directions: { a: 'Zemun', b: 'Centar' } }));
    expect(t.saved()[0].name).toBe('Brankov most');
    expect(t.changes.map((c) => c.change)).toEqual([{ details: true, zones: false, hidden: false, added: false }]);
  });

  it('reports zone and hidden changes separately, and clearing removes the field', async () => {
    const t = setup([makeCamera({ ignoreZones: [{ points: [[0, 0], [1, 0], [1, 1]] }] })]);

    await t.editor.update('cam-1', { ignoreZones: [], hidden: true });

    expect(t.saved()[0]).not.toHaveProperty('ignoreZones');
    expect(t.saved()[0].hidden).toBe(true);
    expect(t.changes[0].change).toEqual({ details: false, zones: true, hidden: true, added: false });

    await t.editor.update('cam-1', { hidden: false });
    expect(t.saved()[0]).not.toHaveProperty('hidden');
  });

  it('writes nothing when nothing changed', async () => {
    const t = setup();
    await t.editor.update('cam-1', { name: 'Camera 1', address: 'Square 1', ignoreZones: [] });
    expect(t.store.save).not.toHaveBeenCalled();
    expect(t.changes).toEqual([]);
  });

  it('answers 404 for an unknown camera and 409 while the availability check runs', async () => {
    await expect(setup().editor.update('nope', { name: 'X' })).rejects.toMatchObject({ status: 404, code: 'not-found' });
    await expect(setup([makeCamera()], { revalidating: true }).editor.update('cam-1', { name: 'X' })).rejects.toMatchObject({ status: 409, code: 'revalidating' });
    await expect(setup([makeCamera()], { revalidating: true }).editor.add({ name: 'A', address: 'B', url: 'https://x.rs/a.m3u8' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('adds a probed camera with a fresh id and its referer as a header', async () => {
    const t = setup();

    const camera = await t.editor.add({ name: 'Camera 1', address: 'Bulevar', url: 'https://x.rs/b.m3u8', referer: 'https://x.rs/' });

    expect(camera).toEqual(
      expect.objectContaining({
        id: 'camera-1',
        protocol: 'HLS',
        status: 'active',
        resolution: '704x576',
        lastVerifiedAt: '2026-10-22T10:00:00.000Z',
        headers: { Referer: 'https://x.rs/' },
      }),
    );
    expect(t.validator.validate).toHaveBeenCalledTimes(1);
    expect(t.saved().map((c) => c.id)).toEqual(['cam-1', 'camera-1']);
    expect(t.changes[0].change.added).toBe(true);
  });

  it('refuses a stream address that is already in the registry', async () => {
    const t = setup();
    await expect(t.editor.add({ name: 'Copy', address: 'B', url: 'https://example.com/cam-1.m3u8' })).rejects.toMatchObject({ status: 409, code: 'duplicate-url' });
    expect(t.validator.validate).not.toHaveBeenCalled();
  });

  it('deletes a camera and reports it as removed', async () => {
    const t = setup([makeCamera(), makeCamera({ id: 'cam-2', url: 'https://example.com/cam-2.m3u8' })]);

    const removed = await t.editor.remove('cam-1');

    expect(removed.id).toBe('cam-1');
    expect(t.saved().map((c) => c.id)).toEqual(['cam-2']);
    expect(t.changes[0].change.removed).toBe(true);
    await expect(t.editor.remove('cam-1')).rejects.toMatchObject({ status: 404, code: 'not-found' });
    await expect(setup([makeCamera()], { revalidating: true }).editor.remove('cam-1')).rejects.toMatchObject({ status: 409, code: 'revalidating' });
  });

  it('runs edits one after another so a quick second edit keeps the first', async () => {
    const t = setup();
    await Promise.all([t.editor.update('cam-1', { name: 'First' }), t.editor.update('cam-1', { address: 'Second' })]);
    expect(t.saved()[0]).toEqual(expect.objectContaining({ name: 'First', location: { address: 'Second' } }));
  });
});
