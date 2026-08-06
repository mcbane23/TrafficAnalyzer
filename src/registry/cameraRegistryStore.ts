import { readFile, stat, writeFile } from 'node:fs/promises';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { CameraEntry } from '../types/camera';

/**
 * How long a cached registry read is trusted before the file's mtime/size
 * are re-checked. Keeps a burst of requests (the HLS proxy fetches a
 * playlist plus its segments continuously, per viewer) down to a single
 * `stat` at most once per second, while still picking up an edit made
 * outside this process almost immediately.
 */
const STAT_TTL_MS = 1000;

interface RegistryCache {
  /** The raw file contents, already schema-validated. */
  raw: string;
  mtimeMs: number;
  size: number;
  /** When the underlying file was last `stat`ed for staleness. */
  checkedAt: number;
}

/**
 * CameraRegistryStore loads and saves the camera registry JSON file,
 * validating its contents against the registry's JSON Schema on every
 * read and write so the file on disk can never silently drift from its
 * documented contract.
 *
 * Reads are cached: the registry is small, changes rarely (only via
 * `save`, or a manual edit), and is read on the hot path of every camera
 * API request and every proxied HLS playlist/segment fetch. The cache is
 * keyed on the file's mtime+size so an external edit is still picked up,
 * and `save` refreshes it directly. Only the file read and schema
 * validation are shared, though - each `load` still parses its own copy,
 * because callers (notably `RevalidationService`) mutate the entries they
 * are handed before writing them back.
 *
 * This module intentionally knows nothing about *how* a camera is
 * validated (that's `CameraValidator`'s job) - it only knows how to get
 * a well-formed list of `CameraEntry` objects in and out of a file.
 */
export class CameraRegistryStore {
  private readonly registryPath: string;
  private readonly schemaPath: string;
  private readonly ajv: Ajv2020;
  private compiledValidator?: Promise<ValidateFunction>;
  private cache: RegistryCache | null = null;
  /** De-dupes concurrent cache misses so a burst of requests triggers one read+validate, not N. */
  private inFlightRead: Promise<string> | null = null;

  constructor(registryPath: string, schemaPath: string) {
    this.registryPath = registryPath;
    this.schemaPath = schemaPath;
    this.ajv = new Ajv2020({ allErrors: true });
    addFormats(this.ajv);
  }

  async load(): Promise<CameraEntry[]> {
    const raw = await this.readValidated();
    // Parsed per call rather than shared: callers treat the returned
    // entries as their own to mutate.
    return JSON.parse(raw) as CameraEntry[];
  }

  async save(entries: CameraEntry[]): Promise<void> {
    await this.assertValid(entries);
    const raw = `${JSON.stringify(entries, null, 2)}\n`;
    await writeFile(this.registryPath, raw, 'utf-8');
    this.cache = await this.describeCache(raw);
  }

  /** Returns the registry file's validated contents, from cache when it's still current. */
  private async readValidated(): Promise<string> {
    const cached = this.cache;
    if (cached && !(await this.isStale(cached))) {
      return cached.raw;
    }

    if (!this.inFlightRead) {
      this.inFlightRead = this.readAndValidate().finally(() => {
        this.inFlightRead = null;
      });
    }
    return this.inFlightRead;
  }

  private async readAndValidate(): Promise<string> {
    const raw = await readFile(this.registryPath, 'utf-8');
    await this.assertValid(JSON.parse(raw));
    this.cache = await this.describeCache(raw);
    return raw;
  }

  private async isStale(cached: RegistryCache): Promise<boolean> {
    const now = Date.now();
    if (now - cached.checkedAt < STAT_TTL_MS) return false;
    try {
      const stats = await stat(this.registryPath);
      cached.checkedAt = now;
      return stats.mtimeMs !== cached.mtimeMs || stats.size !== cached.size;
    } catch {
      // Treat an unreadable file as stale so the next real read surfaces the error.
      return true;
    }
  }

  /** Builds a cache entry for freshly-read/written contents, or null if the file can't be stat'ed (so the next load re-reads). */
  private async describeCache(raw: string): Promise<RegistryCache | null> {
    try {
      const stats = await stat(this.registryPath);
      return { raw, mtimeMs: stats.mtimeMs, size: stats.size, checkedAt: Date.now() };
    } catch {
      return null;
    }
  }

  private async assertValid(data: unknown): Promise<void> {
    const validate = await this.getValidator();
    const valid = validate(data);
    if (!valid) {
      const details = this.ajv.errorsText(validate.errors, { separator: '\n  - ' });
      throw new Error(`Camera registry (${this.registryPath}) failed schema validation:\n  - ${details}`);
    }
  }

  private getValidator(): Promise<ValidateFunction> {
    // Memoize the promise, not its result, so concurrent callers can't each
    // read and compile the schema before the first one finishes.
    if (!this.compiledValidator) {
      this.compiledValidator = (async () => {
        const schemaRaw = await readFile(this.schemaPath, 'utf-8');
        return this.ajv.compile(JSON.parse(schemaRaw));
      })().catch((err) => {
        this.compiledValidator = undefined;
        throw err;
      });
    }
    return this.compiledValidator;
  }
}
