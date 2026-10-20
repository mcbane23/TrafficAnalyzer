import { CameraAnalysisResult } from '../types/analysis';
import {
  CameraHeatmap,
  CameraStats,
  CameraSummary,
  HeatmapCell,
  LiveCounts,
  PassageCounts,
  StatsBucket,
  StatsBucketEntry,
  StatsRange,
  StatsSummary,
} from '../types/stats';
import { CameraPassageModel } from './passageModel';
import { BucketQuery, CoverageBucketRow, MINUTE_MS, MinuteSample, PassageBucketRow, TrafficStatsStore } from './trafficStatsStore';

const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The slice of `TrafficStatsStore` this service uses - the seam a test can fake. */
export type TrafficStatsStoreLike = Pick<
  TrafficStatsStore,
  'recordPassage' | 'recordMinutes' | 'passageBuckets' | 'coverageBuckets' | 'axisMoments'
>;

export const RANGE_MS: Record<StatsRange, number> = {
  '1h': HOUR_MS,
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};

export const BUCKET_MS: Record<StatsBucket, number> = {
  '5m': 5 * MINUTE_MS,
  '15m': 15 * MINUTE_MS,
  '1h': HOUR_MS,
  '1d': DAY_MS,
};

/** Bucket sizes allowed per range, default first - bounds every response to at most a few hundred buckets. */
export const ALLOWED_BUCKETS: Record<StatsRange, StatsBucket[]> = {
  '1h': ['5m', '15m'],
  '24h': ['1h', '15m'],
  '7d': ['1h', '1d'],
  '30d': ['1d'],
};

/** Thrown for a request the API should answer with 400 rather than 500. */
export class StatsQueryError extends Error {}

export function parseRange(value: unknown): StatsRange {
  if (value === undefined) return '24h';
  if (typeof value === 'string' && value in RANGE_MS) return value as StatsRange;
  throw new StatsQueryError(`Invalid range "${String(value)}" - expected one of ${Object.keys(RANGE_MS).join(', ')}.`);
}

export function parseBucket(range: StatsRange, value: unknown): StatsBucket {
  if (value === undefined) return ALLOWED_BUCKETS[range][0];
  if (typeof value === 'string' && (ALLOWED_BUCKETS[range] as string[]).includes(value)) return value as StatsBucket;
  throw new StatsQueryError(`Invalid bucket "${String(value)}" for range ${range} - expected one of ${ALLOWED_BUCKETS[range].join(', ')}.`);
}

function emptyCounts(): PassageCounts {
  return { total: 0, a: 0, b: 0, unknown: 0, car: 0, large: 0 };
}

function addCounts(target: PassageCounts, source: PassageCounts): void {
  target.total += source.total;
  target.a += source.a;
  target.b += source.b;
  target.unknown += source.unknown;
  target.car += source.car;
  target.large += source.large;
}

function pickCounts(row: PassageCounts): PassageCounts {
  return { total: row.total, a: row.a, b: row.b, unknown: row.unknown, car: row.car, large: row.large };
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  /** 0 = Monday ... 6 = Sunday. */
  weekday: number;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Calendar maths in the stats time zone (Belgrade by default) rather than
 * the server's own, which in a container is usually UTC - "today" and the
 * hour-of-day heatmap have to mean local time to be useful.
 */
class ZonedCalendar {
  private readonly format: Intl.DateTimeFormat;

  constructor(readonly timeZone: string) {
    this.format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      weekday: 'short',
    });
  }

  parts(ms: number): ZonedParts {
    const values: Record<string, string> = {};
    for (const part of this.format.formatToParts(new Date(ms))) values[part.type] = part.value;
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      weekday: WEEKDAYS.indexOf(values.weekday),
    };
  }

  /** Epoch ms of local midnight on the local day containing `ms`. */
  startOfDay(ms: number): number {
    const p = this.parts(ms);
    const wallMidnightAsUtc = Date.UTC(p.year, p.month - 1, p.day);
    // Two passes settle the offset even when midnight is near a DST change.
    let guess = wallMidnightAsUtc - this.offset(ms);
    guess = wallMidnightAsUtc - this.offset(guess);
    return guess;
  }

  /** Local midnight `days` local days after the one starting at `dayStartMs` (DST-safe). */
  addDays(dayStartMs: number, days: number): number {
    return this.startOfDay(dayStartMs + days * DAY_MS + 12 * HOUR_MS);
  }

  private offset(ms: number): number {
    const p = this.parts(ms);
    const minutesAndBelow = ms % HOUR_MS;
    return Date.UTC(p.year, p.month - 1, p.day, p.hour) + minutesAndBelow - ms;
  }
}

export interface TrafficStatsServiceOptions {
  /** IANA zone used for day buckets, "today" and the heatmap. Defaults to Europe/Belgrade. */
  timeZone?: string;
  /** How far back persisted passages re-seed a camera's road axis on first use. Defaults to 7 days. */
  axisSeedMs?: number;
  /** Minimum net movement for a passage to get a direction - passed to each camera's DirectionModel. */
  minDisplacement?: number;
  now?: () => Date;
}

interface MinuteAccumulator {
  minute: number;
  frames: number;
  occupancySum: number;
  occupancyFrames: number;
}

/**
 * Turns the analysis pipeline's per-frame results into traffic statistics.
 *
 * Ingest (`handleResult`, wired to `TrafficAnalysisService`'s `onResult`
 * hook): every finished track becomes one persisted `VehiclePassage`,
 * labelled with a direction and size class by that camera's
 * `CameraPassageModel`; every frame also counts towards that minute's
 * coverage/occupancy sample, written once the minute is over.
 *
 * Query (`getCameraStats` & co.): bucketed aggregates over those two
 * tables, with gaps where the camera wasn't being analyzed reported as
 * low coverage rather than as zero traffic.
 */
export class TrafficStatsService {
  private readonly calendar: ZonedCalendar;
  private readonly axisSeedMs: number;
  private readonly minDisplacement: number;
  private readonly now: () => Date;
  private readonly models = new Map<string, CameraPassageModel>();
  private readonly minutes = new Map<string, MinuteAccumulator>();

  constructor(
    private readonly store: TrafficStatsStoreLike,
    options: TrafficStatsServiceOptions = {},
  ) {
    this.calendar = new ZonedCalendar(options.timeZone ?? 'Europe/Belgrade');
    this.axisSeedMs = options.axisSeedMs ?? 7 * DAY_MS;
    this.minDisplacement = options.minDisplacement ?? 0.05;
    this.now = options.now ?? (() => new Date());
  }

  get timeZone(): string {
    return this.calendar.timeZone;
  }

  handleResult(result: CameraAnalysisResult): void {
    if (result.error || result.warmingUp) return;

    const model = this.modelFor(result.cameraId);
    for (const track of result.finishedTracks ?? []) {
      try {
        this.store.recordPassage(model.toPassage(track));
      } catch (err) {
        console.error(`[TrafficStatsService] failed to persist passage for camera "${result.cameraId}":`, err);
      }
    }

    const minute = Math.floor(Date.parse(result.timestamp) / MINUTE_MS);
    let acc = this.minutes.get(result.cameraId);
    if (acc && acc.minute !== minute) {
      this.writeMinutes([[result.cameraId, acc]]);
      acc = undefined;
    }
    if (!acc) {
      acc = { minute, frames: 0, occupancySum: 0, occupancyFrames: 0 };
      this.minutes.set(result.cameraId, acc);
    }
    acc.frames += 1;
    if (result.occupancy !== undefined) {
      acc.occupancySum += result.occupancy;
      acc.occupancyFrames += 1;
    }
  }

  /** Writes every camera's in-progress minute - call on shutdown so the last minute isn't lost. */
  flush(): void {
    this.writeMinutes([...this.minutes.entries()]);
    this.minutes.clear();
  }

  getCameraStats(cameraId: string, range: StatsRange, bucket: StatsBucket = ALLOWED_BUCKETS[range][0]): CameraStats {
    if (!ALLOWED_BUCKETS[range].includes(bucket)) {
      throw new StatsQueryError(`Bucket ${bucket} is not allowed for range ${range}.`);
    }
    const nowMs = this.now().getTime();
    const starts = this.bucketStarts(range, bucket, nowMs);
    const fromMs = starts[0];
    // Day buckets are local days, which don't sit on epoch boundaries, so
    // they're rolled up from hourly rows instead of grouped in SQL directly.
    const sqlBucketMs = bucket === '1d' ? HOUR_MS : BUCKET_MS[bucket];
    const query: BucketQuery = { cameraId, fromMs, toMs: nowMs, bucketMs: sqlBucketMs };
    const passages = this.store.passageBuckets(query);
    const coverage = this.store.coverageBuckets(query);

    const entries = starts.map((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] : bucket === '1d' ? this.calendar.addDays(start, 1) : start + BUCKET_MS[bucket];
      return this.buildEntry(start, end, nowMs, passages, coverage);
    });

    const totals = emptyCounts();
    entries.forEach((entry) => addCounts(totals, entry));
    const coveredMinutes = coverage.reduce((sum, row) => sum + row.coveredMinutes, 0);
    const elapsedMinutes = Math.max(1, (nowMs - fromMs) / MINUTE_MS);

    return {
      cameraId,
      range,
      bucket,
      from: new Date(fromMs).toISOString(),
      to: new Date(nowMs).toISOString(),
      timeZone: this.calendar.timeZone,
      axis: this.modelFor(cameraId).direction.axis(),
      totals,
      coverage: Math.min(1, coveredMinutes / elapsedMinutes),
      buckets: entries,
    };
  }

  /** Average vehicles per analyzed hour, by local weekday and hour of day, over the last `days` days. */
  getHeatmap(cameraId: string, days = 7): CameraHeatmap {
    if (!Number.isInteger(days) || days < 1 || days > 28) {
      throw new StatsQueryError('days must be an integer between 1 and 28.');
    }
    const nowMs = this.now().getTime();
    const fromMs = this.calendar.addDays(this.calendar.startOfDay(nowMs), -(days - 1));
    const query: BucketQuery = { cameraId, fromMs, toMs: nowMs, bucketMs: HOUR_MS };

    const slots = new Map<number, { count: number; coveredMinutes: number }>();
    const slotFor = (ms: number) => {
      const p = this.calendar.parts(ms);
      const key = p.weekday * 24 + p.hour;
      let slot = slots.get(key);
      if (!slot) {
        slot = { count: 0, coveredMinutes: 0 };
        slots.set(key, slot);
      }
      return slot;
    };
    for (const row of this.store.passageBuckets(query)) slotFor(row.startMs).count += row.total;
    for (const row of this.store.coverageBuckets(query)) slotFor(row.startMs).coveredMinutes += row.coveredMinutes;

    const cells: HeatmapCell[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      for (let hour = 0; hour < 24; hour++) {
        const slot = slots.get(weekday * 24 + hour);
        // Under 10 analyzed minutes is too thin to extrapolate to an hourly rate.
        const vehiclesPerHour = slot && slot.coveredMinutes >= 10 ? Math.round((slot.count / slot.coveredMinutes) * 60) : null;
        cells.push({ weekday, hour, vehiclesPerHour });
      }
    }
    return { cameraId, days, timeZone: this.calendar.timeZone, cells };
  }

  /** Per-camera totals for the range plus a 24-hour hourly sparkline each, for the dashboard. */
  getSummary(range: StatsRange): StatsSummary {
    const nowMs = this.now().getTime();
    const fromMs = nowMs - RANGE_MS[range];
    const whole: BucketQuery = { fromMs, toMs: nowMs, bucketMs: Number.MAX_SAFE_INTEGER };

    const sparkFrom = (Math.floor(nowMs / HOUR_MS) - 23) * HOUR_MS;
    const hourly: BucketQuery = { fromMs: sparkFrom, toMs: nowMs, bucketMs: HOUR_MS };
    const sparkPassages = this.store.passageBuckets(hourly);
    const sparkCoverage = this.store.coverageBuckets(hourly);

    const byCamera = new Map<string, CameraSummary>();
    const summaryFor = (cameraId: string) => {
      let summary = byCamera.get(cameraId);
      if (!summary) {
        summary = { cameraId, ...emptyCounts(), coverage: 0, sparkline: new Array(24).fill(null) };
        byCamera.set(cameraId, summary);
      }
      return summary;
    };

    for (const row of this.store.passageBuckets(whole)) addCounts(summaryFor(row.cameraId), row);
    const elapsedMinutes = RANGE_MS[range] / MINUTE_MS;
    for (const row of this.store.coverageBuckets(whole)) {
      summaryFor(row.cameraId).coverage = Math.min(1, row.coveredMinutes / elapsedMinutes);
    }
    for (const row of sparkCoverage) {
      if (row.coveredMinutes > 0) summaryFor(row.cameraId).sparkline[(row.startMs - sparkFrom) / HOUR_MS] = 0;
    }
    for (const row of sparkPassages) {
      const line = summaryFor(row.cameraId).sparkline;
      const i = (row.startMs - sparkFrom) / HOUR_MS;
      line[i] = (line[i] ?? 0) + row.total;
    }

    const totals = emptyCounts();
    const cameras = [...byCamera.values()].sort((x, y) => y.total - x.total);
    cameras.forEach((camera) => addCounts(totals, camera));
    return { range, from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString(), totals, cameras };
  }

  getLiveCounts(cameraId: string): LiveCounts {
    const nowMs = this.now().getTime();
    const countSince = (fromMs: number) => {
      const counts = emptyCounts();
      for (const row of this.store.passageBuckets({ cameraId, fromMs, toMs: nowMs + 1, bucketMs: Number.MAX_SAFE_INTEGER })) {
        addCounts(counts, row);
      }
      return counts;
    };
    return {
      cameraId,
      last5m: countSince(nowMs - 5 * MINUTE_MS),
      last1h: countSince(nowMs - HOUR_MS),
      today: countSince(this.calendar.startOfDay(nowMs)),
    };
  }

  /** CSV export of a stats response, one row per bucket. */
  toCsv(stats: CameraStats): string {
    const header = 'bucket_start,total,direction_a,direction_b,direction_unknown,car,large,occupancy,coverage';
    const lines = stats.buckets.map((b) =>
      [b.start, b.total, b.a, b.b, b.unknown, b.car, b.large, b.occupancy === null ? '' : b.occupancy.toFixed(4), b.coverage.toFixed(4)].join(','),
    );
    return [header, ...lines].join('\n') + '\n';
  }

  private modelFor(cameraId: string): CameraPassageModel {
    let model = this.models.get(cameraId);
    if (!model) {
      model = new CameraPassageModel(cameraId, { direction: { minDisplacement: this.minDisplacement } });
      try {
        const since = this.now().getTime() - this.axisSeedMs;
        model.direction.seed(this.store.axisMoments(cameraId, since, this.minDisplacement));
      } catch (err) {
        console.error(`[TrafficStatsService] failed to seed road axis for camera "${cameraId}":`, err);
      }
      this.models.set(cameraId, model);
    }
    return model;
  }

  private writeMinutes(entries: Array<[string, MinuteAccumulator]>): void {
    const samples: MinuteSample[] = entries.map(([cameraId, acc]) => ({ cameraId, ...acc }));
    try {
      this.store.recordMinutes(samples);
    } catch (err) {
      console.error('[TrafficStatsService] failed to persist analysis coverage:', err);
    }
  }

  private bucketStarts(range: StatsRange, bucket: StatsBucket, nowMs: number): number[] {
    if (bucket === '1d') {
      const days = Math.round(RANGE_MS[range] / DAY_MS);
      const today = this.calendar.startOfDay(nowMs);
      return Array.from({ length: days }, (_, i) => this.calendar.addDays(today, i - (days - 1)));
    }
    const size = BUCKET_MS[bucket];
    const count = RANGE_MS[range] / size;
    const current = Math.floor(nowMs / size) * size;
    return Array.from({ length: count }, (_, i) => current - (count - 1 - i) * size);
  }

  private buildEntry(
    start: number,
    end: number,
    nowMs: number,
    passages: PassageBucketRow[],
    coverage: CoverageBucketRow[],
  ): StatsBucketEntry {
    const counts = emptyCounts();
    passages.filter((row) => row.startMs >= start && row.startMs < end).forEach((row) => addCounts(counts, pickCounts(row)));
    let coveredMinutes = 0;
    let occupancySum = 0;
    let occupancyFrames = 0;
    for (const row of coverage) {
      if (row.startMs < start || row.startMs >= end) continue;
      coveredMinutes += row.coveredMinutes;
      occupancySum += row.occupancySum;
      occupancyFrames += row.occupancyFrames;
    }
    // The current bucket is only judged on the part of it that has happened.
    const elapsedMinutes = Math.max(1, (Math.min(end, nowMs) - start) / MINUTE_MS);
    return {
      start: new Date(start).toISOString(),
      ...counts,
      occupancy: occupancyFrames > 0 ? occupancySum / occupancyFrames : null,
      coverage: Math.min(1, coveredMinutes / elapsedMinutes),
    };
  }
}
