import Database from 'better-sqlite3';
import { StoredAnalysisResult, TrafficLevel, VehicleClass, emptyClassCounts } from '../types/analysis';

interface Row {
  camera_id: string;
  timestamp: string;
  total_count: number;
  counts_by_class: string;
  traffic_level: TrafficLevel;
}

function rowToResult(row: Row): StoredAnalysisResult {
  return {
    cameraId: row.camera_id,
    timestamp: row.timestamp,
    totalCount: row.total_count,
    countsByClass: { ...emptyClassCounts(), ...(JSON.parse(row.counts_by_class) as Partial<Record<VehicleClass, number>>) },
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
export class TrafficHistoryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traffic_analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        total_count INTEGER NOT NULL,
        counts_by_class TEXT NOT NULL,
        traffic_level TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_traffic_analysis_camera_ts ON traffic_analysis (camera_id, timestamp);
    `);
  }

  record(result: StoredAnalysisResult): void {
    this.db
      .prepare(
        `INSERT INTO traffic_analysis (camera_id, timestamp, total_count, counts_by_class, traffic_level)
         VALUES (@cameraId, @timestamp, @totalCount, @countsByClass, @trafficLevel)`,
      )
      .run({
        cameraId: result.cameraId,
        timestamp: result.timestamp,
        totalCount: result.totalCount,
        countsByClass: JSON.stringify(result.countsByClass),
        trafficLevel: result.trafficLevel,
      });
  }

  /** The latest recorded result for every camera that has at least one recorded result. */
  getLatestForAllCameras(): StoredAnalysisResult[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM traffic_analysis t
         INNER JOIN (SELECT camera_id, MAX(id) AS max_id FROM traffic_analysis GROUP BY camera_id) latest
           ON t.camera_id = latest.camera_id AND t.id = latest.max_id`,
      )
      .all() as Row[];
    return rows.map(rowToResult);
  }

  /** History for one camera, oldest-first, optionally restricted to results at/after `sinceIso`, capped at the most recent `limit` (default 100). */
  getHistory(cameraId: string, options: { sinceIso?: string; limit?: number } = {}): StoredAnalysisResult[] {
    const limit = options.limit ?? 100;
    const rows = options.sinceIso
      ? (this.db
          .prepare(
            `SELECT * FROM (
               SELECT * FROM traffic_analysis WHERE camera_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?
             ) ORDER BY timestamp ASC`,
          )
          .all(cameraId, options.sinceIso, limit) as Row[])
      : (this.db
          .prepare(
            `SELECT * FROM (
               SELECT * FROM traffic_analysis WHERE camera_id = ? ORDER BY timestamp DESC LIMIT ?
             ) ORDER BY timestamp ASC`,
          )
          .all(cameraId, limit) as Row[]);
    return rows.map(rowToResult);
  }

  close(): void {
    this.db.close();
  }
}
