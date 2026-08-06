import { SseChannel, SseRequest, SseResponse, SseTimer } from './sseChannel';

function makeResponse() {
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  const res = {
    writableEnded: false,
    setHeader: jest.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      chunks.push(chunk);
    }),
  };
  return { res: res as unknown as SseResponse & typeof res, headers, chunks };
}

function makeRequest() {
  let closeListener: (() => void) | null = null;
  const setTimeout = jest.fn();
  const setKeepAlive = jest.fn();
  const req: SseRequest = {
    socket: { setTimeout, setKeepAlive },
    on: (_event, listener) => {
      closeListener = listener;
    },
  };
  return { req, setTimeout, setKeepAlive, fireClose: () => closeListener?.() };
}

/** A timer that records intervals instead of running them, so the heartbeat can be fired on demand. */
function makeTimer() {
  const intervals: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  const timer: SseTimer = {
    setInterval: (fn, ms) => {
      const id = nextId++;
      intervals.push({ id, fn, ms });
      return id;
    },
    clearInterval: (handle) => {
      const idx = intervals.findIndex((i) => i.id === handle);
      if (idx >= 0) intervals.splice(idx, 1);
    },
  };
  return { timer, intervals };
}

function open(overrides: { heartbeatMs?: number } = {}) {
  const { res, headers, chunks } = makeResponse();
  const { req, setTimeout, setKeepAlive, fireClose } = makeRequest();
  const { timer, intervals } = makeTimer();
  const onClose = jest.fn();
  const channel = SseChannel.open(req, res, onClose, { timer, ...overrides });
  return { channel, res, headers, chunks, intervals, onClose, fireClose, setTimeout, setKeepAlive };
}

describe('SseChannel', () => {
  it('sets the headers an event stream needs and flushes them immediately', () => {
    const { headers, res } = open();

    expect(headers).toEqual({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
  });

  // Node's default socket timeout would close a long-lived, mostly-idle
  // stream out from under us.
  it('disables the socket timeout and enables keep-alive', () => {
    const { setTimeout, setKeepAlive } = open();

    expect(setTimeout).toHaveBeenCalledWith(0);
    expect(setKeepAlive).toHaveBeenCalledWith(true);
  });

  it('writes a payload as a JSON data event', () => {
    const { channel, chunks } = open();

    channel.send({ cameraId: 'cam-1', totalCount: 3 });

    expect(chunks).toEqual(['data: {"cameraId":"cam-1","totalCount":3}\n\n']);
  });

  // A dashboard stream can legitimately sit silent for minutes, and proxies
  // drop connections with no traffic after ~30-60s.
  it('sends a heartbeat comment on the configured interval', () => {
    const { chunks, intervals } = open({ heartbeatMs: 25_000 });

    expect(intervals).toHaveLength(1);
    expect(intervals[0].ms).toBe(25_000);

    intervals[0].fn();
    expect(chunks).toEqual([': ping\n\n']);
  });

  it('stops the heartbeat when the request closes, and notifies the caller first', () => {
    const { intervals, onClose, fireClose } = open();

    fireClose();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(intervals).toHaveLength(0);
  });

  // The heartbeat outliving its connection is what would leak a timer per
  // dropped viewer - and fire writes at a dead socket forever.
  it('does not write after closing, even if the heartbeat somehow fires again', () => {
    const { chunks, intervals, fireClose } = open();
    const heartbeat = intervals[0].fn;

    fireClose();
    heartbeat();

    expect(chunks).toHaveLength(0);
  });

  it('ignores a send on an already-ended response', () => {
    const { channel, res, chunks } = open();
    (res as { writableEnded: boolean }).writableEnded = true;

    channel.send({ any: 'payload' });

    expect(chunks).toHaveLength(0);
  });

  // A write racing a just-closed connection must not unwind into the
  // analysis service's publish loop and abandon every other subscriber.
  it('swallows a write that throws on a broken socket', () => {
    const { channel, res } = open();
    (res.write as jest.Mock).mockImplementation(() => {
      throw new Error('EPIPE');
    });

    expect(() => channel.send({ any: 'payload' })).not.toThrow();
  });

  it('close() is idempotent', () => {
    const { channel, intervals, fireClose } = open();

    fireClose();
    channel.close();

    expect(intervals).toHaveLength(0);
  });
});
