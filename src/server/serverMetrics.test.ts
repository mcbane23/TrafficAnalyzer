import { ChildProcessInfo, ServerMetricsService, SystemReader, parsePss, parseProcStat } from './serverMetrics';

/** A reader whose counters the test sets before each sample. */
function makeReader() {
  const state = {
    cpu: { idleMs: 0, totalMs: 0 },
    processCpuMs: 0,
    children: [] as ChildProcessInfo[] | null,
    reapedCpuMs: 0,
    loopMs: 2 as number | null,
  };
  const reader: SystemReader = {
    cpuTimes: () => state.cpu,
    processCpuMs: () => state.processCpuMs,
    children: () => (state.children ? { running: state.children, reapedCpuMs: state.reapedCpuMs } : null),
    eventLoopDelayMs: () => state.loopMs,
  };
  return { state, reader };
}

function makeService(reader: SystemReader, historySize = 120) {
  let now = Date.parse('2026-10-21T10:00:00Z');
  const service = new ServerMetricsService({
    analysis: { getMetrics: () => ({ activeJobs: 1, queuedJobs: 0, maxConcurrency: 6, cameras: [] }) },
    overlay: null,
    config: { analysisFps: 3, analysisThreads: 2, overlayDevice: 'GPU', overlayModel: () => 'yolo26s on GPU' },
    dataDir: __dirname,
    databases: [{ name: 'Missing', path: '/nonexistent/db.sqlite' }],
    historySize,
    reader,
    now: () => new Date(now),
  });
  return { service, advance: (ms: number) => (now += ms) };
}

const ffmpeg = (pid: number, cpuMs: number): ChildProcessInfo => ({ pid, command: 'ffmpeg', cpuMs, memoryBytes: 10_000_000 });

describe('ServerMetricsService', () => {
  it('needs two readings before it reports CPU', () => {
    const { reader } = makeReader();
    const { service } = makeService(reader);
    expect(service.sample()).toBeNull();
    expect(service.getMetrics().cpu).toEqual([]);
  });

  it('computes machine CPU from idle time and server CPU from Node plus its ffmpeg children', () => {
    const { state, reader } = makeReader();
    const { service, advance } = makeService(reader);
    state.children = [ffmpeg(10, 1000), ffmpeg(11, 500)];
    service.sample();

    advance(5000);
    // 4 cores for 5 s = 20000 ms, 5000 of them idle -> 75 % busy.
    state.cpu = { idleMs: 5000, totalMs: 20_000 };
    // Node used 2500 ms of CPU in 5 s -> 50 % of a core.
    state.processCpuMs = 2500;
    // pid 10 used 1000 ms more; pid 11 used 300 ms more, then exited and was reaped; pid 12 is new
    // with 1200 ms -> 2500 ms -> 50 %.
    state.children = [ffmpeg(10, 2000), ffmpeg(12, 1200)];
    state.reapedCpuMs = 800;
    const sample = service.sample();

    expect(sample).toEqual({ at: '2026-10-21T10:00:05.000Z', system: 75, process: 100, eventLoopMs: 2 });
    const metrics = service.getMetrics();
    expect(metrics.process).toMatchObject({ nodeCpu: 50, childrenCpu: 50, ffmpegProcesses: 2, childrenMemoryBytes: 20_000_000 });
    expect(metrics.host.gpu).toMatchObject({ device: 'GPU', model: 'yolo26s on GPU' });
    expect(metrics.analysis).toMatchObject({ fpsTarget: 3, threads: 2, activeJobs: 1, maxConcurrency: 6 });
    expect(metrics.overlay).toEqual({ enabled: false, maxCameras: 0, cameras: [] });
    expect(metrics.storage).toEqual([{ name: 'Missing', bytes: null }]);
  });

  it('reports only Node when child processes cannot be read', () => {
    const { state, reader } = makeReader();
    const { service, advance } = makeService(reader);
    state.children = null;
    service.sample();
    advance(1000);
    state.processCpuMs = 300;
    expect(service.sample()?.process).toBe(30);
    expect(service.getMetrics().process).toMatchObject({ childrenCpu: null, ffmpegProcesses: null });
  });

  it('keeps only the newest samples', () => {
    const { reader } = makeReader();
    const { service, advance } = makeService(reader, 3);
    for (let i = 0; i < 6; i++) {
      service.sample();
      advance(1000);
    }
    const history = service.getMetrics().cpu;
    expect(history).toHaveLength(3);
    expect(history[2].at).toBe('2026-10-21T10:00:05.000Z');
  });
});

describe('parseProcStat', () => {
  it('reads parent, CPU ticks and RSS, with a command containing spaces and parentheses', () => {
    const fields = ['S', '42', ...Array(9).fill('0'), '150', '50', '30', '20', ...Array(6).fill('0'), '256'];
    expect(parseProcStat(`123 (my (odd) cmd) ${fields.join(' ')}`)).toEqual({
      command: 'my (odd) cmd',
      ppid: 42,
      cpuMs: 2000,
      reapedChildrenCpuMs: 500,
      rssBytes: 256 * 4096,
    });
  });
});

describe('parsePss', () => {
  it('reads the proportional set size from smaps_rollup, not the RSS', () => {
    const rollup = [
      '55d0c0000000-7ffd00000000 ---p 00000000 00:00 0                          [rollup]',
      'Rss:               76832 kB',
      'Pss:               36800 kB',
      'Pss_Anon:          35892 kB',
    ].join('\n');
    expect(parsePss(rollup)).toBe(36800 * 1024);
  });

  it('returns null when there is no Pss line', () => {
    expect(parsePss('Rss: 100 kB')).toBeNull();
  });
});
