/**
 * The parts of an Express request a live stream actually depends on.
 * Narrow on purpose: it's what lets this module be tested against a plain
 * object rather than a real HTTP connection.
 */
export interface SseRequest {
  socket: {
    setTimeout(ms: number): unknown;
    setKeepAlive(enable: boolean): unknown;
  };
  on(event: 'close', listener: () => void): unknown;
}

/** The parts of an Express response a live stream actually depends on. */
export interface SseResponse {
  writableEnded: boolean;
  setHeader(name: string, value: string): unknown;
  flushHeaders(): unknown;
  write(chunk: string): unknown;
}

/** Injectable timer seam, so heartbeat behaviour can be driven without waiting 25 real seconds. */
export interface SseTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimer: SseTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    // Don't hold the event loop open purely for a heartbeat.
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/** How often an idle connection is sent a comment line to keep intermediaries from reaping it. */
export const SSE_HEARTBEAT_MS = 25_000;

export interface SseChannelOptions {
  heartbeatMs?: number;
  timer?: SseTimer;
}

/**
 * One open Server-Sent Events connection.
 *
 * Everything it takes to keep a long-lived, mostly-idle stream alive lives
 * here rather than in route handlers: the headers, the disabled socket
 * timeout, the heartbeat, and the write guards. That matters because a
 * dashboard stream can legitimately sit silent for a long time - every
 * camera's background tick is suppressed while another camera is being
 * watched - and proxies commonly drop a connection with no traffic after
 * ~30-60s.
 *
 * Failures are contained rather than propagated. Writes happen from the
 * analysis service's publish loop and from a heartbeat timer, neither of
 * which has a caller that could handle an error: a write racing a
 * just-closed connection would otherwise stop the remaining subscribers for
 * that tick from being notified, or - from the timer - crash the process
 * outright.
 */
export class SseChannel {
  private readonly res: SseResponse;
  private readonly timer: SseTimer;
  private readonly heartbeat: unknown;
  private closed = false;

  private constructor(res: SseResponse, options: SseChannelOptions) {
    this.res = res;
    this.timer = options.timer ?? defaultTimer;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Stops nginx buffering the stream and delaying events behind it.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    this.heartbeat = this.timer.setInterval(() => this.writeRaw(': ping\n\n'), options.heartbeatMs ?? SSE_HEARTBEAT_MS);
  }

  /**
   * Opens a channel on this request/response pair and ties its lifetime to
   * the connection: when the request closes, `onClose` runs and the channel
   * tears itself down. A caller that never remembers to close anything
   * still cannot leak the heartbeat.
   */
  static open(req: SseRequest, res: SseResponse, onClose: () => void, options: SseChannelOptions = {}): SseChannel {
    const channel = new SseChannel(res, options);

    // Node's default socket timeout would otherwise close a long-lived,
    // mostly-idle stream.
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true);
    req.on('close', () => {
      onClose();
      channel.close();
    });

    return channel;
  }

  /** Sends one event carrying a JSON payload. Never throws, even on a dead connection. */
  send(payload: unknown): void {
    this.writeRaw(`data: ${JSON.stringify(payload)}\n\n`);
  }

  /** Stops the heartbeat. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.timer.clearInterval(this.heartbeat);
  }

  private writeRaw(chunk: string): void {
    if (this.closed || this.res.writableEnded) return;
    try {
      this.res.write(chunk);
    } catch {
      // Connection went away between the close event and this write.
    }
  }
}
