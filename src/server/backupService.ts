import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AnalysisSettings } from '../types/admin';
import type { CameraEntry } from '../types/camera';

/** Bumped when a backup's layout changes in a way an older restore can't read. */
const BACKUP_FORMAT = '1';
const META_TABLE = 'trafficanalyzer_backup';

export interface BackupDeps {
  stats: {
    backupTo(filePath: string): Promise<void>;
    restoreFrom(filePath: string): { passages: number; hours: number; minutes: number };
  };
  settings: { current(): AnalysisSettings; apply(settings: AnalysisSettings): Promise<unknown> };
  cameras: { load(): Promise<CameraEntry[]>; replaceAll(entries: CameraEntry[]): Promise<unknown> };
  /** Called after the statistics were replaced, to drop anything worked out from the old ones. */
  onStatsRestored?: () => void;
  appVersion?: string;
  tmpDir?: string;
  now?: () => Date;
}

export interface RestoreSummary {
  createdAt: string | null;
  passages: number;
  cameras: number;
}

/** A file that isn't a backup this version can restore; the message is shown to the user. */
export class BackupError extends Error {
  constructor(
    message: string,
    readonly code: 'not-backup' | 'newer-format',
  ) {
    super(message);
  }
}

/**
 * Backup and restore from the Admin page. A backup is a single SQLite file:
 * a consistent copy of the statistics database, plus one extra table holding
 * the analysis settings and the camera registry (names, directions, ignore
 * zones). The Admin password is left out on purpose, so restoring never
 * locks anyone out or opens Admin up.
 *
 * Restoring replaces all three in place while the server runs: the cameras
 * first (they are schema-checked, so a bad file fails before anything
 * changes), then the statistics in one transaction, then the settings.
 */
export class BackupService {
  private readonly tmpDir: string;
  private readonly now: () => Date;

  constructor(private readonly deps: BackupDeps) {
    this.tmpDir = deps.tmpDir ?? os.tmpdir();
    this.now = deps.now ?? (() => new Date());
  }

  /** A path for a temporary file; the caller deletes it. */
  tempPath(): string {
    return path.join(this.tmpDir, `trafficanalyzer-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  }

  /** Writes a backup to a new temporary file and returns its path; the caller deletes it. */
  async create(): Promise<string> {
    const file = this.tempPath();
    try {
      await this.deps.stats.backupTo(file);
      const db = new Database(file);
      try {
        db.pragma('journal_mode = DELETE');
        db.exec(`CREATE TABLE ${META_TABLE} (name TEXT PRIMARY KEY, content TEXT NOT NULL)`);
        const insert = db.prepare(`INSERT INTO ${META_TABLE} (name, content) VALUES (?, ?)`);
        insert.run('format', BACKUP_FORMAT);
        insert.run('created_at', this.now().toISOString());
        insert.run('app_version', this.deps.appVersion ?? '');
        insert.run('analysis-settings', JSON.stringify(this.deps.settings.current()));
        insert.run('cameras', JSON.stringify(await this.deps.cameras.load()));
      } finally {
        db.close();
      }
      return file;
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
  }

  /** Restores the backup at `filePath` (left in place for the caller to delete). */
  async restore(filePath: string): Promise<RestoreSummary> {
    const meta = readMeta(filePath);
    const cameras = JSON.parse(meta.get('cameras') ?? 'null') as unknown;
    const settings = JSON.parse(meta.get('analysis-settings') ?? 'null') as unknown;
    if (!Array.isArray(cameras) || !settings || typeof settings !== 'object') {
      throw new BackupError('The backup is missing the cameras or the settings.', 'not-backup');
    }
    await this.deps.cameras.replaceAll(cameras as CameraEntry[]);
    const counts = this.deps.stats.restoreFrom(filePath);
    this.deps.onStatsRestored?.();
    await this.deps.settings.apply(settings as AnalysisSettings);
    return { createdAt: meta.get('created_at') ?? null, passages: counts.passages, cameras: cameras.length };
  }
}

function readMeta(filePath: string): Map<string, string> {
  let db: Database.Database;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch {
    throw new BackupError('This file is not a TrafficAnalyzer backup.', 'not-backup');
  }
  try {
    const rows = db.prepare(`SELECT name, content FROM ${META_TABLE}`).all() as Array<{ name: string; content: string }>;
    const meta = new Map(rows.map((row) => [row.name, row.content]));
    if (!meta.has('format')) throw new BackupError('This file is not a TrafficAnalyzer backup.', 'not-backup');
    if (Number(meta.get('format')) > Number(BACKUP_FORMAT)) {
      throw new BackupError('The backup comes from a newer version of TrafficAnalyzer; update this one first.', 'newer-format');
    }
    return meta;
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError('This file is not a TrafficAnalyzer backup.', 'not-backup');
  } finally {
    db.close();
  }
}
