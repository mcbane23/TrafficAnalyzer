import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { CameraAnalysisMetrics, CpuSample, OverlayCameraMetrics, ServerMetrics } from '../types/admin';

/** One child process of this server, as read from `/proc`. */
export interface ChildProcessInfo {
  pid: number;
  command: string;
  /** User + system CPU time since the process started, in ms. */
  cpuMs: number;
  /**
   * Proportional set size (`/proc/<pid>/smaps_rollup`): pages shared with
   * other processes, such as the libraries every ffmpeg maps, are split
   * between them. Falls back to RSS where that file can't be read.
   */
  memoryBytes: number;
}

/** Narrow seam over the OS counters a sample is computed from, so the delta arithmetic is testable without real load. */
export interface SystemReader {
  /** Whole-machine CPU time, summed over all cores (ms). */
  cpuTimes(): { idleMs: number; totalMs: number };
  /** This process's own CPU time, all threads (ms). */
  processCpuMs(): number;
  /**
   * Direct children (the ffmpeg captures) still running, plus the CPU time
   * of children that already exited and were reaped - together they make a
   * running total that doesn't drop when a capture restarts. Null where
   * `/proc` isn't available.
   */
  children(): { running: ChildProcessInfo[]; reapedCpuMs: number } | null;
  /** Event loop delay p99 (ms) since the previous call, or null when unavailable. */
  eventLoopDelayMs(): number | null;
}

/** What the analysis and overlay services report - see their `getMetrics()`. */
export interface AnalysisMetricsSource {
  getMetrics(): { activeJobs: number; queuedJobs: number; maxConcurrency: number; cameras: CameraAnalysisMetrics[] };
}
export interface OverlayMetricsSource {
  getMetrics(): { maxCameras: number; cameras: OverlayCameraMetrics[] };
}

export interface ServerMetricsOptions {
  analysis: AnalysisMetricsSource;
  overlay: OverlayMetricsSource | null;
  config: {
    analysisFps: number;
    analysisThreads: number;
    overlayDevice: string;
    /** The overlay model actually loaded, once it has been. */
    overlayModel: () => string | null;
  };
  /** Directory holding the databases - its volume is the one whose free space is reported. */
  dataDir: string;
  /** Files whose size is reported, each with the SQLite sidecars (`-wal`, `-shm`) counted in. */
  databases: Array<{ name: string; path: string }>;
  /** How often (ms) CPU is sampled. Defaults to 5000. */
  sampleIntervalMs?: number;
  /** Samples kept for the trend chart. Defaults to 120 (10 minutes at 5 s). */
  historySize?: number;
  reader?: SystemReader;
  now?: () => Date;
}

interface Baseline {
  at: number;
  cpu: { idleMs: number; totalMs: number };
  processCpuMs: number;
  childrenCpuMs: number | null;
}

/**
 * ServerMetricsService gathers the server-health figures shown on the Admin
 * page: CPU (whole machine and this server's own, ffmpeg children
 * included), memory, event-loop delay, how the analysis and live overlay
 * are keeping up, and how big the databases have grown.
 *
 * CPU is a rate, so it needs two readings: a background timer samples
 * every few seconds (cheap - a few small `/proc` reads) and keeps the last
 * ten minutes for the trend line, so the page has a history the moment it
 * opens and two open tabs don't shorten each other's measurement window.
 */
export class ServerMetricsService {
  private readonly reader: SystemReader;
  private readonly now: () => Date;
  private readonly sampleIntervalMs: number;
  private readonly historySize: number;
  private readonly cpuLimit: number | null;
  private baseline: Baseline | null = null;
  private history: CpuSample[] = [];
  private latest: { nodeCpu: number | null; childrenCpu: number | null; ffmpeg: number | null; childrenMemory: number | null } = {
    nodeCpu: null,
    childrenCpu: null,
    ffmpeg: null,
    childrenMemory: null,
  };
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ServerMetricsOptions) {
    this.reader = options.reader ?? createSystemReader();
    this.now = options.now ?? (() => new Date());
    this.sampleIntervalMs = options.sampleIntervalMs ?? 5_000;
    this.historySize = options.historySize ?? 120;
    this.cpuLimit = readCgroupCpuLimit();
  }

  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.sampleIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Takes one CPU reading against the previous one. The first call only sets the baseline. */
  sample(): CpuSample | null {
    const at = this.now().getTime();
    const cpu = this.reader.cpuTimes();
    const processCpuMs = this.reader.processCpuMs();
    const children = this.reader.children();
    const childList = children?.running ?? null;
    const childrenCpuMs = children ? children.reapedCpuMs + children.running.reduce((sum, c) => sum + c.cpuMs, 0) : null;
    const eventLoopMs = this.reader.eventLoopDelayMs();
    const previous = this.baseline;
    this.baseline = { at, cpu, processCpuMs, childrenCpuMs };
    if (!previous) return null;

    const wallMs = at - previous.at;
    if (wallMs <= 0) return null;
    const totalDelta = cpu.totalMs - previous.cpu.totalMs;
    const system = totalDelta > 0 ? clampPercent((1 - (cpu.idleMs - previous.cpu.idleMs) / totalDelta) * 100, 100) : null;
    const nodeCpu = Math.max(0, ((processCpuMs - previous.processCpuMs) / wallMs) * 100);

    const childrenCpu =
      childrenCpuMs !== null && previous.childrenCpuMs !== null ? Math.max(0, ((childrenCpuMs - previous.childrenCpuMs) / wallMs) * 100) : null;
    this.latest = {
      nodeCpu,
      childrenCpu,
      ffmpeg: childList ? childList.filter((c) => c.command === 'ffmpeg').length : null,
      childrenMemory: childList ? childList.reduce((sum, c) => sum + c.memoryBytes, 0) : null,
    };

    const entry: CpuSample = {
      at: new Date(at).toISOString(),
      system: system === null ? null : round1(system),
      process: round1(nodeCpu + (childrenCpu ?? 0)),
      eventLoopMs: eventLoopMs === null ? null : round1(eventLoopMs),
    };
    this.history.push(entry);
    if (this.history.length > this.historySize) this.history.splice(0, this.history.length - this.historySize);
    return entry;
  }

  getMetrics(): ServerMetrics {
    const memory = process.memoryUsage();
    const cpus = os.cpus();
    const { analysis, overlay, config } = this.options;
    return {
      generatedAt: this.now().toISOString(),
      host: {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        cpuModel: cpus[0]?.model.trim() ?? 'unknown',
        cores: cpus.length,
        cpuLimit: this.cpuLimit,
        loadAverage: os.loadavg().map(round2) as [number, number, number],
        uptimeSec: Math.round(os.uptime()),
        memory: { totalBytes: os.totalmem(), availableBytes: os.freemem() },
        disk: readDisk(this.options.dataDir),
        gpu: { device: config.overlayDevice, model: config.overlayModel(), ...readGpuFrequency() },
      },
      process: {
        nodeVersion: process.version,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        childrenMemoryBytes: this.latest.childrenMemory,
        ffmpegProcesses: this.latest.ffmpeg,
        nodeCpu: this.latest.nodeCpu === null ? null : round1(this.latest.nodeCpu),
        childrenCpu: this.latest.childrenCpu === null ? null : round1(this.latest.childrenCpu),
      },
      cpu: [...this.history],
      analysis: { fpsTarget: config.analysisFps, threads: config.analysisThreads, ...analysis.getMetrics() },
      overlay: overlay ? { enabled: true, ...overlay.getMetrics() } : { enabled: false, maxCameras: 0, cameras: [] },
      storage: this.options.databases.map(({ name, path: file }) => ({ name, bytes: fileSize(file) })),
    };
  }
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
const clampPercent = (value: number, max: number) => Math.min(max, Math.max(0, value));

/** A database's size on disk, with its SQLite write-ahead log and shared-memory sidecars. Null if it doesn't exist. */
function fileSize(file: string): number | null {
  let total: number | null = null;
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      total = (total ?? 0) + fs.statSync(candidate).size;
    } catch {
      // Missing sidecars are normal.
    }
  }
  return total;
}

function readDisk(dir: string): { totalBytes: number; freeBytes: number } | null {
  try {
    const stats = fs.statfsSync(dir);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}

/** The container's CPU quota from cgroup v2 (`cpu.max`), in CPUs - null when unlimited or not in a cgroup. */
function readCgroupCpuLimit(): number | null {
  try {
    const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (quota === 'max') return null;
    const cpus = Number(quota) / Number(period);
    return Number.isFinite(cpus) && cpus > 0 ? round2(cpus) : null;
  } catch {
    return null;
  }
}

/**
 * The Intel GPU's current and maximum frequency (i915 sysfs). There is no
 * cheap "GPU busy %" without perf counters, but the frequency rising above
 * idle while the overlay runs is a fair sign the model is really on the GPU.
 */
function readGpuFrequency(): { freqMhz: number | null; maxFreqMhz: number | null } {
  try {
    for (const card of fs.readdirSync('/sys/class/drm').filter((name) => /^card\d+$/.test(name))) {
      const dir = path.join('/sys/class/drm', card);
      const read = (file: string) => {
        try {
          const value = Number(fs.readFileSync(path.join(dir, file), 'utf8').trim());
          return Number.isFinite(value) ? value : null;
        } catch {
          return null;
        }
      };
      const freqMhz = read('gt_act_freq_mhz');
      if (freqMhz !== null) return { freqMhz, maxFreqMhz: read('gt_RP0_freq_mhz') ?? read('gt_max_freq_mhz') };
    }
  } catch {
    // No DRM devices visible (no /dev/dri passthrough, or not Linux).
  }
  return { freqMhz: null, maxFreqMhz: null };
}

/** A process's proportional set size in bytes, from `/proc/<pid>/smaps_rollup`, or null if it can't be read. */
export function readPss(pid: string | number): number | null {
  try {
    return parsePss(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
  } catch {
    return null;
  }
}

/** The `Pss:` line of an smaps_rollup file, in bytes. */
export function parsePss(text: string): number | null {
  const match = /^Pss:\s+(\d+) kB/m.exec(text);
  return match ? Number(match[1]) * 1024 : null;
}

/** Clock ticks per second in `/proc/<pid>/stat` - USER_HZ, 100 on every mainstream Linux build. */
const CLOCK_TICKS_PER_SEC = 100;
const PAGE_SIZE = 4096;

/** Parses one `/proc/<pid>/stat` line; the command sits in parentheses and may itself contain spaces or parentheses. */
export function parseProcStat(
  line: string,
): { command: string; ppid: number; cpuMs: number; reapedChildrenCpuMs: number; rssBytes: number } | null {
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  // Fields from the 3rd (state) on.
  const rest = line.slice(close + 2).split(' ');
  const ppid = Number(rest[1]);
  const ticks = Number(rest[11]) + Number(rest[12]);
  const childTicks = Number(rest[13]) + Number(rest[14]);
  const rssPages = Number(rest[21]);
  if (!Number.isFinite(ppid) || !Number.isFinite(ticks)) return null;
  return {
    command: line.slice(open + 1, close),
    ppid,
    cpuMs: (ticks * 1000) / CLOCK_TICKS_PER_SEC,
    reapedChildrenCpuMs: Number.isFinite(childTicks) ? (childTicks * 1000) / CLOCK_TICKS_PER_SEC : 0,
    rssBytes: Number.isFinite(rssPages) ? rssPages * PAGE_SIZE : 0,
  };
}

function createSystemReader(): SystemReader {
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const hasProc = fs.existsSync('/proc/self/stat');
  return {
    cpuTimes() {
      let idleMs = 0;
      let totalMs = 0;
      for (const cpu of os.cpus()) {
        const t = cpu.times;
        idleMs += t.idle;
        totalMs += t.user + t.nice + t.sys + t.idle + t.irq;
      }
      return { idleMs, totalMs };
    },
    processCpuMs() {
      const usage = process.cpuUsage();
      return (usage.user + usage.system) / 1000;
    },
    children() {
      if (!hasProc) return null;
      const result: ChildProcessInfo[] = [];
      let reapedCpuMs = 0;
      try {
        reapedCpuMs = parseProcStat(fs.readFileSync('/proc/self/stat', 'utf8'))?.reapedChildrenCpuMs ?? 0;
      } catch {
        return null;
      }
      let entries: string[];
      try {
        entries = fs.readdirSync('/proc');
      } catch {
        return null;
      }
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = parseProcStat(fs.readFileSync(`/proc/${entry}/stat`, 'utf8'));
          if (stat && stat.ppid === process.pid) result.push({ pid: Number(entry), command: stat.command, cpuMs: stat.cpuMs, memoryBytes: readPss(entry) ?? stat.rssBytes });
        } catch {
          // The process exited between listing and reading.
        }
      }
      return { running: result, reapedCpuMs };
    },
    eventLoopDelayMs() {
      const p99 = loopDelay.percentile(99) / 1e6;
      loopDelay.reset();
      return Number.isFinite(p99) && p99 > 0 ? p99 : null;
    },
  };
}
