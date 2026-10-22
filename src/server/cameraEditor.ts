import { CameraEntry, CameraProtocol, ValidationResult } from '../types/camera';

/** What a camera edit changed, so the caller can apply only that (see `CameraEditorDeps.onChanged`). */
export interface CameraChange {
  /** Name, address or direction names: display only, nothing to restart. */
  details: boolean;
  /** Ignore zones: the camera's analysis and live boxes need the new zones. */
  zones: boolean;
  /** Shown or hidden: the analyzed set changes. */
  hidden: boolean;
  /** A new camera. */
  added: boolean;
}

export interface CameraEditorDeps {
  store: { load(): Promise<CameraEntry[]>; save(entries: CameraEntry[]): Promise<void> };
  /** Probes a new camera's stream, like the availability check. */
  validator: { validate(camera: CameraEntry): Promise<ValidationResult> };
  /** True while the availability check runs: it saves the whole registry when it ends, which would undo an edit made meanwhile. */
  isRevalidating: () => boolean;
  onChanged: (camera: CameraEntry, change: CameraChange) => Promise<void> | void;
}

/** Why the editor refused a request, for the Admin page to word in its own language. */
export type CameraEditErrorCode = 'not-found' | 'revalidating' | 'duplicate-url' | 'no-name' | 'no-address' | 'bad-url' | 'bad-scheme';

/** A request the editor refuses; `status` is the HTTP status to answer with. */
export class CameraEditError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: CameraEditErrorCode,
  ) {
    super(message);
  }
}

export const EDIT_LIMITS = {
  name: 120,
  address: 200,
  direction: 60,
  zoneName: 60,
  zones: 20,
  zonePoints: 50,
} as const;

export interface CameraPatch {
  name?: string;
  address?: string;
  /** Null clears both names. */
  directions?: { a?: string; b?: string } | null;
  ignoreZones?: Array<{ name?: string; points: Array<[number, number]> }>;
  hidden?: boolean;
}

export interface NewCamera {
  name: string;
  address: string;
  url: string;
  protocol: CameraProtocol;
  /** Sent as the `Referer` header, for providers with hotlink protection. */
  referer?: string;
  source?: string;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, max) : undefined;
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * An edit from the Admin page: unknown and malformed fields dropped, text
 * trimmed and capped, zone vertices clamped into the frame. A zone with
 * fewer than 3 usable vertices is dropped, since it covers nothing.
 */
export function normalizeCameraPatch(value: unknown): CameraPatch {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const patch: CameraPatch = {};

  const name = text(input.name, EDIT_LIMITS.name);
  if (name) patch.name = name;
  const address = text(input.address, EDIT_LIMITS.address);
  if (address) patch.address = address;

  if (input.directions === null) patch.directions = null;
  else if (input.directions && typeof input.directions === 'object') {
    const raw = input.directions as Record<string, unknown>;
    const directions: { a?: string; b?: string } = {};
    const a = text(raw.a, EDIT_LIMITS.direction);
    const b = text(raw.b, EDIT_LIMITS.direction);
    if (a) directions.a = a;
    if (b) directions.b = b;
    patch.directions = a || b ? directions : null;
  }

  if (Array.isArray(input.ignoreZones)) {
    patch.ignoreZones = input.ignoreZones.slice(0, EDIT_LIMITS.zones).flatMap((zone) => {
      if (!zone || typeof zone !== 'object' || !Array.isArray((zone as { points?: unknown }).points)) return [];
      const points = ((zone as { points: unknown[] }).points)
        .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)))
        .slice(0, EDIT_LIMITS.zonePoints)
        .map(([x, y]): [number, number] => [round(Math.min(1, Math.max(0, x))), round(Math.min(1, Math.max(0, y)))]);
      if (points.length < 3) return [];
      const zoneName = text((zone as { name?: unknown }).name, EDIT_LIMITS.zoneName);
      return [zoneName ? { name: zoneName, points } : { points }];
    });
  }

  if (typeof input.hidden === 'boolean') patch.hidden = input.hidden;
  return patch;
}

/** The stream protocol a URL most likely uses. */
export function protocolFor(url: URL): CameraProtocol {
  if (url.protocol === 'rtsp:' || url.protocol === 'rtsps:') return 'RTSP';
  const pathname = url.pathname.toLowerCase();
  if (pathname.endsWith('.m3u8')) return 'HLS';
  if (pathname.includes('mjpg') || pathname.includes('mjpeg')) return 'MJPEG';
  return 'HTTP';
}

/** A new camera from the Admin page's form; throws a 400 `CameraEditError` naming the first problem. */
export function normalizeNewCamera(value: unknown): NewCamera {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const name = text(input.name, EDIT_LIMITS.name);
  if (!name) throw new CameraEditError('A camera needs a name.', 400, 'no-name');
  const address = text(input.address, EDIT_LIMITS.address);
  if (!address) throw new CameraEditError('A camera needs an address.', 400, 'no-address');
  let url: URL;
  try {
    url = new URL(typeof input.url === 'string' ? input.url.trim() : '');
  } catch {
    throw new CameraEditError('The stream address is not a valid URL.', 400, 'bad-url');
  }
  if (!['http:', 'https:', 'rtsp:', 'rtsps:'].includes(url.protocol)) {
    throw new CameraEditError('The stream address must start with http://, https:// or rtsp://.', 400, 'bad-scheme');
  }
  const camera: NewCamera = { name, address, url: url.toString(), protocol: protocolFor(url) };
  const referer = text(input.referer, 500);
  if (referer) camera.referer = referer;
  const source = text(input.source, EDIT_LIMITS.name);
  if (source) camera.source = source;
  return camera;
}

/** A registry id (lowercase slug) for a name, unique among `taken`: "Đeram – Ulica" -> "djeram-ulica". */
export function slugFor(name: string, taken: Set<string>): string {
  const base =
    name
      .replace(/[đĐ]/g, 'dj')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'camera';
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Edits the camera registry from the Admin page: a camera's name, address,
 * direction names, ignore zones and whether it is hidden, and adding a new
 * camera (probed first, like the availability check). Every write goes
 * through `CameraRegistryStore`, so the schema still guards the file, and
 * writes are queued one after another so two quick edits can't lose one.
 * `onChanged` tells the caller what changed, so it can apply it without a
 * restart.
 */
export class CameraEditor {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: CameraEditorDeps) {}

  update(cameraId: string, input: unknown): Promise<CameraEntry> {
    return this.serialize(async () => {
      this.assertNotRevalidating();
      const patch = normalizeCameraPatch(input);
      const entries = await this.deps.store.load();
      const camera = entries.find((entry) => entry.id === cameraId);
      if (!camera) throw new CameraEditError(`Camera not found: ${cameraId}`, 404, 'not-found');

      const change: CameraChange = { details: false, zones: false, hidden: false, added: false };
      if (patch.name !== undefined && patch.name !== camera.name) {
        camera.name = patch.name;
        change.details = true;
      }
      if (patch.address !== undefined && patch.address !== camera.location.address) {
        camera.location = { ...camera.location, address: patch.address };
        change.details = true;
      }
      if (patch.directions !== undefined && !sameJson(patch.directions, camera.directions)) {
        if (patch.directions === null) delete camera.directions;
        else camera.directions = patch.directions;
        change.details = true;
      }
      if (patch.ignoreZones !== undefined && !sameJson(patch.ignoreZones.length ? patch.ignoreZones : null, camera.ignoreZones)) {
        if (patch.ignoreZones.length) camera.ignoreZones = patch.ignoreZones;
        else delete camera.ignoreZones;
        change.zones = true;
      }
      if (patch.hidden !== undefined && patch.hidden !== Boolean(camera.hidden)) {
        if (patch.hidden) camera.hidden = true;
        else delete camera.hidden;
        change.hidden = true;
      }

      if (change.details || change.zones || change.hidden) {
        await this.deps.store.save(entries);
        await this.deps.onChanged(camera, change);
      }
      return camera;
    });
  }

  add(input: unknown): Promise<CameraEntry> {
    const fields = normalizeNewCamera(input);
    return this.serialize(async () => {
      this.assertNotRevalidating();
      const entries = await this.deps.store.load();
      if (entries.some((entry) => entry.url === fields.url)) {
        throw new CameraEditError('A camera with this stream address already exists.', 409, 'duplicate-url');
      }
      const camera: CameraEntry = {
        id: slugFor(fields.name, new Set(entries.map((entry) => entry.id))),
        name: fields.name,
        location: { address: fields.address },
        source: fields.source ?? 'Added on the Admin page',
        url: fields.url,
        protocol: fields.protocol,
        status: 'inactive',
        lastVerifiedAt: null,
        ...(fields.referer ? { headers: { Referer: fields.referer } } : {}),
      };
      const result = await this.deps.validator.validate(camera);
      camera.status = result.status;
      camera.lastVerifiedAt = result.checkedAt;
      camera.lastError = result.error ?? null;
      if (result.resolution) camera.resolution = result.resolution;

      // Re-read: the probe takes seconds, and the queue only orders this editor's own writes.
      const latest = await this.deps.store.load();
      latest.push(camera);
      await this.deps.store.save(latest);
      await this.deps.onChanged(camera, { details: false, zones: false, hidden: false, added: true });
      return camera;
    });
  }

  private assertNotRevalidating(): void {
    if (this.deps.isRevalidating()) {
      throw new CameraEditError('The camera availability check is running; try again when it finishes.', 409, 'revalidating');
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
