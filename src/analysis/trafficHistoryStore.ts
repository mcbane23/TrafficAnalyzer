import Database from 'better-sqlite3';
import { StoredAnalysisResult, TrafficLevel } from '../types/analysis';

/** Named parameters bound by the insert statement. */
interface InsertParams {
  cameraId: string;
  timestamp: string;
  totalCount: number;
  trafficLevel: TrafficLevel;
}

interface Row {
  camera_id: string;
  timestamp: string;
  total_count: number;
  traffic_level: TrafficLevel;
}

function rowToResult(row: Row): StoredAnalysisResult {
  return {
    cameraId: row.camera_id,
    timestamp: row.timestamp,
    totalCount: row.total_count,
    trafficLevel: row.traffic_level,
  };
}

/**
 * TrafficHistoryStore persists every analysis result to a local SQLite
 * database file (via better-sqlite3), consistent with this project's
 * existing "no separate database server" approach (see
 * `CameraRegistryStore`'s use of a plain JSON file). Results are retained
 * indefinitely - there's no automatic pruning in this feature.
 */
export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_HISTORY_LIMIT = 1000;

/**
 * Coerces a caller-supplied row limit into a sane positive integer.
 *
 * This matters beyond tidiness: the limit reaches here from a query
 * string, and binding a non-numeric value produces SQL `LIMIT NULL`, which
 * SQLite reads as *no limit at all*. Since results are retained
 * indefinitely, `?limit=abc` would otherwise load a camera's entire
 * history into memory and serialize it to JSON.
 */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_HISTORY_LIMIT;
  return Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.floor(limit)));
}

export class TrafficHistoryStore {
  private readonly db: Database.Database;
  // Statements are compiled once and reused. `record` runs on every tick of
  // every camera - up to a few times a second for a camera being watched -
  // and re-preparing the same INSERT each time is pure repeated SQL parsing.
  private readonly insertStatement: Database.Statement<[InsertParams]>;
  private readonly latestForAllStatement: Database.Statement<[], Row>;
  private readonly historyStatement: Database.Statement<[string, number], Row>;
  private readonly historySinceStatement: Database.Statement<[string, string, number], Row>;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
      // With WAL, NORMAL keeps writes durable across process crashes (only a
      // host power loss can lose the most recent commits) without an fsync per
      // insert - worth it for a high-frequency, reconstructible analytics log.
      this.db.pragma('synchronous = NORMAL');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traffic_analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        total_count INTEGER NOT NULL,
        traffic_level TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_traffic_analysis_camera_ts ON traffic_analysis (camera_id, timestamp);
    `);
    this.migrateLegacySchema();

    this.insertStatement = this.db.prepare<InsertParams>(
      `INSERT INTO traffic_analysis (camera_id, timestamp, total_count, traffic_level)
       VALUES (@cameraId, @timestamp, @totalCount, @trafficLevel)`,
    );
    this.latestForAllStatement = this.db.prepare<[], Row>(
      `SELECT t.* FROM traffic_analysis t
       INNER JOIN (SELECT camera_id, MAX(id) AS max_id FROM traffic_analysis GROUP BY camera_id) latest
         ON t.camera_id = latest.camera_id AND t.id = latest.max_id`,
    );
    this.historyStatement = this.db.prepare<[string, number], Row>(
      `SELECT * FROM (
         SELECT * FROM traffic_analysis WHERE camera_id = ? ORDER BY timestamp DESC LIMIT ?
       ) ORDER BY timestamp ASC`,
    );
    this.historySinceStatement = this.db.prepare<[string, string, number], Row>(
      `SELECT * FROM (
         SELECT * FROM traffic_analysis WHERE camera_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?
       ) ORDER BY timestamp ASC`,
    );
  }

  /**
   * Drops the `counts_by_class` column left over from the schema this table
   * had under the previous (classifying) detector, if present. `CREATE
   * TABLE IF NOT EXISTS` above is a no-op against a database file that
   * already exists on disk, so a store created before this feature's
   * refactor to motion-based detection still has that column, NOT NULL -
   * and `record()` below no longer populates it, so every insert against
   * such a database fails its NOT NULL constraint. That failure happens
   * before `publish()` in `TrafficAnalysisService.analyzeCamera`, so
   * results stop reaching subscribers entirely, and the promise rejection
   * is swallowed by the tick queue - no crash, no log, just silence.
   */
  private migrateLegacySchema(): void {
    const columns = this.db.pragma('table_info(traffic_analysis)') as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'counts_by_class')) {
      this.db.exec('ALTER TABLE traffic_analysis DROP COLUMN counts_by_class');
    }
  }

  record(result: StoredAnalysisResult): void {
    this.insertStatement.run({
      cameraId: result.cameraId,
      timestamp: result.timestamp,
      totalCount: result.totalCount,
      trafficLevel: result.trafficLevel,
    });
  }

  /** The latest recorded result for every camera that has at least one recorded result. */
  getLatestForAllCameras(): StoredAnalysisResult[] {
    return this.latestForAllStatement.all().map(rowToResult);
  }

  /** History for one camera, oldest-first, optionally restricted to results at/after `sinceIso`, capped at the most recent `limit` (default 100, max 1000). */
  getHistory(cameraId: string, options: { sinceIso?: string; limit?: number } = {}): StoredAnalysisResult[] {
    const limit = normalizeLimit(options.limit);
    const rows = options.sinceIso
      ? this.historySinceStatement.all(cameraId, options.sinceIso, limit)
      : this.historyStatement.all(cameraId, limit);
    return rows.map(rowToResult);
  }

  close(): void {
    this.db.close();
  }
}
