import Database from 'better-sqlite3';
import { PassageCounts, VehiclePassage } from '../types/stats';
import { AxisMoments } from './passageModel';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
/** Bucket size meaning "the whole query range as one bucket". */
export const WHOLE_RANGE_BUCKET = Number.MAX_SAFE_INTEGER;

/** Passage counts for one camera and one time bucket. */
export interface PassageBucketRow extends PassageCounts {
  cameraId: string;
  /** Bucket start, epoch ms (buckets are aligned to the Unix epoch). */
  startMs: number;
}

/** Analysis coverage and occupancy for one camera and one time bucket. */
export interface CoverageBucketRow {
  cameraId: string;
  startMs: number;
  /** Minutes in this bucket during which at least one frame was analyzed. */
  coveredMinutes: number;
  occupancySum: number;
  occupancyFrames: number;
}

/** Frames analyzed for one camera within one minute, with the occupancy samples among them. */
export interface MinuteSample {
  cameraId: string;
  /** Epoch minute (floor(ms / 60000)). */
  minute: number;
  frames: number;
  occupancySum: number;
  occupancyFrames: number;
}

export interface BucketQuery {
  /** Omit for every camera. */
  cameraId?: string;
  fromMs: number;
  toMs: number;
  bucketMs: number;
}

interface PassageBucketDbRow {
  camera_id: string;
  bucket: number;
  total: number;
  a: number;
  b: number;
  unknown: number;
  car: number;
  large: number;
}

interface CoverageDbRow {
  camera_id: string;
  bucket: number;
  covered: number;
  occupancy_sum: number;
  occupancy_frames: number;
}

function toBucketRow(row: PassageBucketDbRow): PassageBucketRow {
  return {
    cameraId: row.camera_id,
    startMs: row.bucket,
    total: row.total,
    a: row.a,
    b: row.b,
    unknown: row.unknown,
    car: row.car,
    large: row.large,
  };
}

/**
 * Persists vehicle passages and per-minute analysis coverage to SQLite, and
 * answers the bucketed aggregate queries `TrafficStatsService` builds the
 * stats API from. Kept in its own database file, separate from
 * `TrafficHistoryStore`'s, since the two have unrelated schemas and write
 * patterns (one row per vehicle here vs. one row per camera per window).
 *
 * Coverage is recorded alongside passages because a quiet bucket and an
 * unanalyzed bucket both have zero passages - only coverage tells "no
 * traffic" apart from "no data".
 */
export class TrafficStatsStore {
  private readonly db: Database.Database;
  private readonly insertPassageStatement: Database.Statement;
  private readonly upsertHourStatement: Database.Statement;
  private readonly upsertMinuteStatement: Database.Statement;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vehicle_passages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_id TEXT NOT NULL,
        track_id INTEGER NOT NULL,
        first_seen_ms INTEGER NOT NULL,
        ts_ms INTEGER NOT NULL,
        dx REAL NOT NULL,
        dy REAL NOT NULL,
        direction TEXT,
        size_class TEXT NOT NULL
      );
      -- Covering indexes: every aggregate query reads only these columns, so it never touches the table itself.
      CREATE INDEX IF NOT EXISTS idx_vehicle_passages_camera_ts ON vehicle_passages (camera_id, ts_ms, direction, size_class);
      CREATE INDEX IF NOT EXISTS idx_vehicle_passages_ts ON vehicle_passages (ts_ms, camera_id, direction, size_class);
      -- Hourly roll-up of vehicle_passages, kept in step on every insert, so day/week/month queries read
      -- a few hundred rows per camera instead of one row per vehicle.
      CREATE TABLE IF NOT EXISTS passage_hours (
        camera_id TEXT NOT NULL,
        hour INTEGER NOT NULL,
        total INTEGER NOT NULL,
        a INTEGER NOT NULL,
        b INTEGER NOT NULL,
        unknown INTEGER NOT NULL,
        car INTEGER NOT NULL,
        large INTEGER NOT NULL,
        PRIMARY KEY (camera_id, hour)
      );
      CREATE INDEX IF NOT EXISTS idx_passage_hours_hour ON passage_hours (hour);
      CREATE TABLE IF NOT EXISTS analysis_minutes (
        camera_id TEXT NOT NULL,
        minute INTEGER NOT NULL,
        frames INTEGER NOT NULL,
        occupancy_sum REAL NOT NULL,
        occupancy_frames INTEGER NOT NULL,
        PRIMARY KEY (camera_id, minute)
      );
      CREATE INDEX IF NOT EXISTS idx_analysis_minutes_minute ON analysis_minutes (minute);
    `);
    this.insertPassageStatement = this.db.prepare(
      `INSERT INTO vehicle_passages (camera_id, track_id, first_seen_ms, ts_ms, dx, dy, direction, size_class)
       VALUES (@cameraId, @trackId, @firstSeenMs, @tsMs, @dx, @dy, @direction, @sizeClass)`,
    );
    this.upsertHourStatement = this.db.prepare(
      `INSERT INTO passage_hours (camera_id, hour, total, a, b, unknown, car, large)
       VALUES (@cameraId, @hour, 1, @a, @b, @unknown, @car, @large)
       ON CONFLICT (camera_id, hour) DO UPDATE SET
         total = total + 1, a = a + excluded.a, b = b + excluded.b, unknown = unknown + excluded.unknown,
         car = car + excluded.car, large = large + excluded.large`,
    );
    this.upsertMinuteStatement = this.db.prepare(
      `INSERT INTO analysis_minutes (camera_id, minute, frames, occupancy_sum, occupancy_frames)
       VALUES (@cameraId, @minute, @frames, @occupancySum, @occupancyFrames)
       ON CONFLICT (camera_id, minute) DO UPDATE SET
         frames = frames + excluded.frames,
         occupancy_sum = occupancy_sum + excluded.occupancy_sum,
         occupancy_frames = occupancy_frames + excluded.occupancy_frames`,
    );
  }

  /** A passage is timestamped by when the vehicle was last seen, i.e. when it left. */
  recordPassage(passage: VehiclePassage): void {
    const tsMs = Date.parse(passage.lastSeen);
    this.db.transaction(() => {
      this.insertPassageStatement.run({
        cameraId: passage.cameraId,
        trackId: passage.trackId,
        firstSeenMs: Date.parse(passage.firstSeen),
        tsMs,
        dx: passage.dx,
        dy: passage.dy,
        direction: passage.direction,
        sizeClass: passage.sizeClass,
      });
      this.upsertHourStatement.run({
        cameraId: passage.cameraId,
        hour: Math.floor(tsMs / HOUR_MS),
        a: passage.direction === 'A' ? 1 : 0,
        b: passage.direction === 'B' ? 1 : 0,
        unknown: passage.direction === null ? 1 : 0,
        car: passage.sizeClass === 'car' ? 1 : 0,
        large: passage.sizeClass === 'large' ? 1 : 0,
      });
    })();
  }

  /** Adds to (rather than replaces) a minute's totals, so partial minutes can be flushed more than once. */
  recordMinutes(samples: MinuteSample[]): void {
    if (samples.length === 0) return;
    const tx = this.db.transaction((rows: MinuteSample[]) => {
      for (const row of rows) this.upsertMinuteStatement.run(row);
    });
    tx(samples);
  }

  /**
   * Passage counts per camera per bucket. Hour-or-coarser buckets starting
   * on an hour boundary are served from the hourly roll-up; there `toMs`
   * is rounded up to the end of its hour, which only matters for a `toMs`
   * in the past (callers query up to "now", where nothing lies beyond it).
   */
  passageBuckets(query: BucketQuery): PassageBucketRow[] {
    const cameraFilter = query.cameraId === undefined ? '' : 'AND camera_id = @cameraId';
    const hourly =
      query.fromMs % HOUR_MS === 0 &&
      (query.bucketMs === WHOLE_RANGE_BUCKET || (query.bucketMs >= HOUR_MS && query.bucketMs % HOUR_MS === 0));
    if (hourly) {
      const rows = this.db
        .prepare(
          `SELECT camera_id, ((hour * ${HOUR_MS}) / CAST(@bucketMs AS INTEGER)) * CAST(@bucketMs AS INTEGER) AS bucket,
                  SUM(total) AS total, SUM(a) AS a, SUM(b) AS b, SUM(unknown) AS unknown, SUM(car) AS car, SUM(large) AS large
           FROM passage_hours
           WHERE hour >= @fromHour AND hour < @toHour ${cameraFilter}
           GROUP BY camera_id, bucket
           ORDER BY bucket`,
        )
        .all({
          bucketMs: query.bucketMs,
          fromHour: query.fromMs / HOUR_MS,
          toHour: Math.ceil(query.toMs / HOUR_MS),
          cameraId: query.cameraId ?? null,
        }) as PassageBucketDbRow[];
      return rows.map(toBucketRow);
    }
    const rows = this.db
      .prepare(
        `SELECT camera_id, (ts_ms / CAST(@bucketMs AS INTEGER)) * CAST(@bucketMs AS INTEGER) AS bucket,
                COUNT(*) AS total,
                SUM(direction = 'A') AS a,
                SUM(direction = 'B') AS b,
                SUM(direction IS NULL) AS unknown,
                SUM(size_class = 'car') AS car,
                SUM(size_class = 'large') AS large
         FROM vehicle_passages
         WHERE ts_ms >= @fromMs AND ts_ms < @toMs ${cameraFilter}
         GROUP BY camera_id, bucket
         ORDER BY bucket`,
      )
      .all({ ...query, cameraId: query.cameraId ?? null }) as PassageBucketDbRow[];
    return rows.map(toBucketRow);
  }

  coverageBuckets(query: BucketQuery): CoverageBucketRow[] {
    const cameraFilter = query.cameraId === undefined ? '' : 'AND camera_id = @cameraId';
    const rows = this.db
      .prepare(
        `SELECT camera_id, ((minute * ${MINUTE_MS}) / CAST(@bucketMs AS INTEGER)) * CAST(@bucketMs AS INTEGER) AS bucket,
                SUM(frames > 0) AS covered,
                SUM(occupancy_sum) AS occupancy_sum,
                SUM(occupancy_frames) AS occupancy_frames
         FROM analysis_minutes
         WHERE minute >= @fromMinute AND minute < @toMinute ${cameraFilter}
         GROUP BY camera_id, bucket
         ORDER BY bucket`,
      )
      .all({
        bucketMs: query.bucketMs,
        fromMinute: Math.floor(query.fromMs / MINUTE_MS),
        toMinute: Math.ceil(query.toMs / MINUTE_MS),
        cameraId: query.cameraId ?? null,
      }) as CoverageDbRow[];
    return rows.map((row) => ({
      cameraId: row.camera_id,
      startMs: row.bucket,
      coveredMinutes: row.covered,
      occupancySum: row.occupancy_sum,
      occupancyFrames: row.occupancy_frames,
    }));
  }

  /** Displacement moments of a camera's passages since `sinceMs`, for re-seeding its learned road axis after a restart. */
  axisMoments(cameraId: string, sinceMs: number, minDisplacement: number): AxisMoments {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(dx * dx), 0) AS sxx, COALESCE(SUM(dy * dy), 0) AS syy,
                COALESCE(SUM(dx * dy), 0) AS sxy, COUNT(*) AS n
         FROM vehicle_passages
         WHERE camera_id = ? AND ts_ms >= ? AND dx * dx + dy * dy >= ?`,
      )
      .get(cameraId, sinceMs, minDisplacement * minDisplacement) as AxisMoments;
    return row;
  }

  close(): void {
    this.db.close();
  }
}
