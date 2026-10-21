import { ThroughputWindow } from './throughputWindow';

function makeWindow(windowMs = 10_000) {
  let now = 0;
  const window = new ThroughputWindow(windowMs, () => now);
  return { window, advance: (ms: number) => (now += ms) };
}

describe('ThroughputWindow', () => {
  it('reports nothing before any frame', () => {
    const { window } = makeWindow();
    expect(window.snapshot()).toEqual({ fps: 0, avgMs: null, streamRatio: null, count: 0, avgValue: null });
  });

  it('computes frames per second, mean time and the averaged value over the window', () => {
    const { window, advance } = makeWindow();
    for (let i = 0; i < 30; i++) {
      window.record(i % 2 === 0 ? 40 : 60, undefined, 3);
      advance(333);
    }
    const snapshot = window.snapshot();
    expect(snapshot.fps).toBeCloseTo(3, 0);
    expect(snapshot.avgMs).toBe(50);
    expect(snapshot.avgValue).toBe(3);
  });

  it('forgets frames older than the window', () => {
    const { window, advance } = makeWindow(10_000);
    window.record(100);
    advance(11_000);
    window.record(20);
    expect(window.snapshot()).toMatchObject({ count: 1, avgMs: 20 });
  });

  it('measures stream time against wall time, below 1 when falling behind', () => {
    const { window, advance } = makeWindow();
    for (let i = 0; i <= 9; i++) {
      window.record(10, 1000 + i * 0.8);
      advance(1000);
    }
    expect(window.snapshot().streamRatio).toBeCloseTo(0.8, 5);
  });

  it('only counts the stream clock after a capture restart reset it', () => {
    const { window, advance } = makeWindow();
    window.record(10, 5000);
    advance(1000);
    window.record(10, 5001);
    advance(1000);
    for (let i = 0; i <= 4; i++) {
      window.record(10, 10 + i);
      advance(1000);
    }
    expect(window.snapshot().streamRatio).toBeCloseTo(1, 5);
  });
});
