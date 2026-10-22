/**
 * Server health metrics for the Admin page (`GET /api/admin/metrics`).
 * Every figure is a snapshot of how the server is behaving right now; rates
 * are averaged over the last few seconds, not since boot.
 */

/** Throughput of one frame-processing loop over a short trailing window. */
export interface ThroughputSnapshot {
  /** Frames processed per second. */
  fps: number;
  /** Mean time spent processing a frame (ms), or null with no frames in the window. */
  avgMs: number | null;
  /**
   * Seconds of stream covered per second of wall clock: about 1 when the
   * loop keeps up with the live picture, below 1 when it falls behind.
   * Null when the frames carry no stream time.
   */
  streamRatio: number | null;
}

/** Supervision counters of one long-lived ffmpeg capture, since it was opened. */
export interface CaptureCounters {
  /** ffmpeg runs started, including the first. */
  starts: number;
  /** Runs killed because they stopped producing frames. */
  stalls: number;
  /** Decoded frames thrown away because the consumer was behind. */
  dropped: number;
  /** When the last frame was decoded (ISO), or null if none yet. */
  lastFrameAt: string | null;
  lastError: string | null;
}

export interface CameraAnalysisMetrics extends ThroughputSnapshot {
  cameraId: string;
  name: string;
  /** Error results (failed captures) in the window. */
  errors: number;
  capture: CaptureCounters | null;
}

export interface OverlayCameraMetrics extends ThroughputSnapshot {
  cameraId: string;
  name: string;
  viewers: number;
  /** Mean boxes drawn per frame. */
  vehiclesPerFrame: number | null;
  capture: CaptureCounters | null;
}

export interface CpuSample {
  /** ISO time of the sample. */
  at: string;
  /** Whole-machine CPU busy, 0-100 (all cores together). */
  system: number | null;
  /** This server's CPU (Node plus its ffmpeg children), as % of one core. */
  process: number | null;
  /** Event loop delay p99 (ms) since the previous sample. */
  eventLoopMs: number | null;
}

export interface ServerMetrics {
  generatedAt: string;
  host: {
    hostname: string;
    platform: string;
    cpuModel: string;
    cores: number;
    /** CPUs the container may use (cgroup quota), or null when unlimited/unknown. */
    cpuLimit: number | null;
    loadAverage: [number, number, number];
    uptimeSec: number;
    memory: { totalBytes: number; availableBytes: number };
    /** Free and total space on the volume holding the databases, or null when unknown. */
    disk: { totalBytes: number; freeBytes: number } | null;
    gpu: { device: string; model: string | null; freqMhz: number | null; maxFreqMhz: number | null };
  };
  process: {
    nodeVersion: string;
    pid: number;
    uptimeSec: number;
    rssBytes: number;
    heapUsedBytes: number;
    /**
     * Memory held by the ffmpeg children, or null where it can't be read:
     * their proportional set size, so the shared libraries every capture maps
     * are counted once between them rather than once per process (summed RSS
     * overstated it about 2x with 22 cameras).
     */
    childrenMemoryBytes: number | null;
    /** Running ffmpeg processes started by this server. */
    ffmpegProcesses: number | null;
    /** Node's own CPU and its children's, as % of one core, from the latest sample. */
    nodeCpu: number | null;
    childrenCpu: number | null;
  };
  /** Latest sample plus the last ~10 minutes, oldest first. */
  cpu: CpuSample[];
  analysis: {
    fpsTarget: number;
    threads: number;
    /** Frames being analyzed right now, and frames waiting for a slot. */
    activeJobs: number;
    queuedJobs: number;
    maxConcurrency: number;
    cameras: CameraAnalysisMetrics[];
  };
  overlay: {
    enabled: boolean;
    maxCameras: number;
    cameras: OverlayCameraMetrics[];
  };
  storage: Array<{ name: string; bytes: number | null }>;
}

/** Which cameras the fleet analysis runs on - switched on the Admin page, see AnalysisSettingsStore. */
export interface AnalysisSettings {
  /** False analyzes no camera at all (no statistics, badges or thumbnails; the live view still works). */
  enabled: boolean;
  /** Ids of cameras left out of the analysis. */
  disabledCameras: string[];
}

/** One camera's row in the Admin page's analysis switches. */
export interface AnalysisCameraSetting {
  id: string;
  name: string;
  /** Registry status: only active cameras can be analyzed. */
  active: boolean;
  /** Its own switch (independent of the global one). */
  enabled: boolean;
}

export interface AnalysisSettingsResponse extends AnalysisSettings {
  cameras: AnalysisCameraSetting[];
}
