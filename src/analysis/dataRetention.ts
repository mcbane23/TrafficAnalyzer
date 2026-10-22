/** The slice of `TrafficHistoryStore` retention needs. */
export interface HistoryPruner {
  latestIds(): number[];
  pruneBefore(cutoffIso: string, keep: number[], batch: number): number;
}

/** The slice of `TrafficStatsStore` retention needs. */
export interface PassagePruner {
  prunePassagesBefore(cutoffMs: number, batch: number): number;
}

export interface RetentionScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DataRetentionOptions {
  history: HistoryPruner;
  passages: PassagePruner;
  /** Days of per-camera history rows to keep. */
  historyDays: number;
  /** Days of individual passages to keep, read on every run (an Admin setting); 0 keeps them forever. */
  passageDays: () => number;
  /** Time between runs. Defaults to an hour. */
  intervalMs?: number;
  /** Rows deleted per step. Defaults to 5000. */
  batchSize?: number;
  now?: () => number;
  scheduler?: RetentionScheduler;
  log?: (message: string) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const defaultScheduler: RetentionScheduler = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Deletes old rows from the two databases, so they stop growing forever:
 * - `traffic-history.db` keeps `historyDays` (it only seeds the dashboard's
 *   badges after a restart; 22 cameras wrote ~20 MB a day into it);
 * - `traffic-stats.db` keeps individual passages for `passageDays`. The
 *   hourly roll-up and the coverage minutes stay, so every count in the
 *   statistics views stays too.
 *
 * Runs at start and then every `intervalMs`. A run deletes in batches with a
 * yield to the event loop between them, so a first run against a database
 * that has grown for months doesn't hold up requests or frame capture.
 * SQLite reuses the freed pages, so the files stop growing; they only shrink
 * with a VACUUM, which is not done here (it would block for minutes on a big
 * file and briefly need its size again in free disk).
 */
export class DataRetentionService {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly now: () => number;
  private readonly scheduler: RetentionScheduler;
  private readonly log: (message: string) => void;
  private handle: unknown = null;
  private stopped = false;

  constructor(private readonly options: DataRetentionOptions) {
    this.intervalMs = options.intervalMs ?? 60 * 60 * 1000;
    this.batchSize = options.batchSize ?? 5000;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.log = options.log ?? ((message) => console.log(message));
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== null) this.scheduler.clearTimeout(this.handle);
    this.handle = null;
  }

  /** One full run: every old row, a batch per event-loop turn. Resolves with what was deleted. */
  async runOnce(): Promise<{ history: number; passages: number }> {
    const now = this.now();
    const historyCutoff = new Date(now - this.options.historyDays * DAY_MS).toISOString();
    const keep = this.options.history.latestIds();
    const history = await this.drain(() => this.options.history.pruneBefore(historyCutoff, keep, this.batchSize));

    const passageDays = this.options.passageDays();
    const passages = passageDays > 0 ? await this.drain(() => this.options.passages.prunePassagesBefore(now - passageDays * DAY_MS, this.batchSize)) : 0;

    if (history || passages) this.log(`[DataRetention] deleted ${history} history rows, ${passages} passages`);
    return { history, passages };
  }

  private async drain(step: () => number): Promise<number> {
    let total = 0;
    for (;;) {
      if (this.stopped) return total;
      const deleted = step();
      total += deleted;
      if (deleted < this.batchSize) return total;
      await new Promise<void>((resolve) => this.scheduler.setTimeout(resolve, 0));
    }
  }

  private schedule(ms: number): void {
    this.handle = this.scheduler.setTimeout(() => {
      this.runOnce()
        .catch((err) => console.error('[DataRetention] failed:', err))
        .finally(() => {
          if (!this.stopped) this.schedule(this.intervalMs);
        });
    }, ms);
  }
}
