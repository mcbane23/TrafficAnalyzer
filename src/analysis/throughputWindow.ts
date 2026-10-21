import { ThroughputSnapshot } from '../types/admin';

interface Sample {
  at: number;
  durationMs: number;
  streamTime?: number;
  value: number;
}

/**
 * Rolling throughput of a frame loop over the last `windowMs`: frames per
 * second, mean processing time and how fast stream time advances against
 * the wall clock. Cheap enough to record on every frame - samples older
 * than the window are pruned as new ones arrive.
 */
export class ThroughputWindow {
  private samples: Sample[] = [];

  constructor(
    private readonly windowMs = 15_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records one processed frame. `value` is an extra per-frame figure to average (e.g. vehicles drawn). */
  record(durationMs: number, streamTime?: number, value = 0): void {
    const at = this.now();
    this.samples.push({ at, durationMs, value, ...(streamTime === undefined ? {} : { streamTime }) });
    this.prune(at);
  }

  snapshot(): ThroughputSnapshot & { count: number; avgValue: number | null } {
    const at = this.now();
    this.prune(at);
    const count = this.samples.length;
    if (count === 0) return { fps: 0, avgMs: null, streamRatio: null, count, avgValue: null };
    // Rate over the full window once it is full; over the time since the first sample before that.
    const span = Math.min(this.windowMs, Math.max(1000, at - this.samples[0].at));
    const totalMs = this.samples.reduce((sum, s) => sum + s.durationMs, 0);
    const totalValue = this.samples.reduce((sum, s) => sum + s.value, 0);
    return {
      fps: (count * 1000) / span,
      avgMs: totalMs / count,
      streamRatio: this.streamRatio(),
      count,
      avgValue: totalValue / count,
    };
  }

  /**
   * Stream seconds per wall second across the timed samples. A capture
   * restart resets the stream clock, so only the run of samples after the
   * last backwards jump counts.
   */
  private streamRatio(): number | null {
    let first = -1;
    let last = -1;
    for (let i = 0; i < this.samples.length; i++) {
      const time = this.samples[i].streamTime;
      if (time === undefined) continue;
      if (last >= 0 && time < (this.samples[last].streamTime as number)) first = i;
      if (first < 0) first = i;
      last = i;
    }
    if (first < 0 || last <= first) return null;
    const wallMs = this.samples[last].at - this.samples[first].at;
    if (wallMs < 2000) return null;
    return ((this.samples[last].streamTime as number) - (this.samples[first].streamTime as number)) / (wallMs / 1000);
  }

  private prune(at: number): void {
    const cutoff = at - this.windowMs;
    let stale = 0;
    while (stale < this.samples.length && this.samples[stale].at < cutoff) stale += 1;
    if (stale > 0) this.samples.splice(0, stale);
  }
}
