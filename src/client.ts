import { connect, type Socket } from "bun";

export interface NBusOptions {
  socket?: string;
}

type Waiter = (line: string) => void;

interface ListenSub {
  kind: "listen";
  bucket: string;
  event: string;
}

interface WatchSub {
  kind: "watch";
  bucket: string;
  key: string;
}

type ActiveSub = ListenSub | WatchSub;

const BACKOFF_START_MS = 100;
const BACKOFF_MAX_MS = 10_000;
const PING_INTERVAL_MS = 30_000;

/**
 * NBus client for the local IPC bus.
 *
 * Line delivery is single-consumer: the socket data handler drains complete
 * lines into `lineQueue`, and `readLine()` pulls from the queue in FIFO order
 * (or registers a waiter if the queue is empty). This guarantees exactly-once,
 * in-order delivery of response lines to awaiting callers, so a SET's `OK` can
 * never be misassigned to a later GET.
 */
export class NBus {
  private path: string;
  private sock: Socket | null = null;
  private buf = "";

  /** Complete lines drained from the socket, not yet consumed by a reader. */
  private lineQueue: string[] = [];
  /** Callers awaiting a line when the queue is empty. FIFO with lineQueue. */
  private waiters: Waiter[] = [];

  /** Subscriptions that must be re-sent transparently after a reconnect. */
  private activeSubs = new Set<ActiveSub>();

  private connected = false;
  private closed = false;
  private connectPromise: Promise<Socket> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: NBusOptions) {
    this.path = opts?.socket ?? "/tmp/nbus.sock";
  }

  // ---------------------------------------------------------------------------
  // Line delivery (single consumer path)
  // ---------------------------------------------------------------------------

  /** Append a raw chunk and drain any complete lines into the queue/waiters. */
  private ingest(chunk: string): void {
    this.buf += chunk;
    while (true) {
      const idx = this.buf.indexOf("\n");
      if (idx === -1) break;
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lineQueue.push(line);
    }
  }

  /** Pull the next line from the queue, or wait for one to arrive. */
  private readLine(): Promise<string> {
    const queued = this.lineQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  private async ensureConnected(): Promise<Socket> {
    if (this.sock && this.connected) return this.sock;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectWithBackoff();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connectWithBackoff(): Promise<Socket> {
    let delay = BACKOFF_START_MS;
    while (!this.closed) {
      try {
        const sock = await this.openSocket();
        this.sock = sock;
        this.connected = true;
        this.startKeepalive();
        this.resubscribe();
        return sock;
      } catch {
        if (this.closed) break;
        await sleep(delay);
        delay = Math.min(delay * 10, BACKOFF_MAX_MS);
      }
    }
    throw new Error("nbus client closed");
  }

  private openSocket(): Promise<Socket> {
    return connect({
      unix: this.path,
      socket: {
        data: (_socket, data) => {
          this.ingest(data.toString());
        },
        error: (_socket, err) => {
          console.error("nbus connection error:", err.message);
          this.handleDisconnect();
        },
        close: () => {
          this.handleDisconnect();
        },
      },
    });
  }

  private handleDisconnect(): void {
    if (!this.connected && !this.sock) return;
    this.connected = false;
    this.sock = null;
    this.buf = "";
    this.stopKeepalive();
    if (this.closed) return;
    // Trigger a background reconnect; pending readLine waiters are preserved
    // and will be satisfied once the re-subscribed stream resumes.
    void this.ensureConnected().catch(() => {
      /* closed during reconnect; ignore */
    });
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.pingTimer = setInterval(() => {
      const sock = this.sock;
      if (sock && this.connected) {
        try {
          sock.write("PING\n");
        } catch {
          this.handleDisconnect();
        }
      }
    }, PING_INTERVAL_MS);
    // Do not keep the process alive solely for keepalive pings.
    (this.pingTimer as unknown as { unref?: () => void }).unref?.();
  }

  private stopKeepalive(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Re-send every tracked subscription after a (re)connect. */
  private resubscribe(): void {
    const sock = this.sock;
    if (!sock) return;
    for (const sub of this.activeSubs) {
      if (sub.kind === "listen") {
        sock.write(`SUB ${sub.bucket} ${sub.event}\n`);
      } else {
        sock.write(`WATCH ${sub.bucket} ${sub.key}\n`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async emit(bucket: string, event: string, data?: unknown): Promise<void> {
    const sock = await this.ensureConnected();
    const payload = data !== undefined ? JSON.stringify(data) : "null";
    sock.write(`EMIT ${bucket} ${event} ${payload}\n`);
  }

  async set(bucket: string, key: string, value: unknown): Promise<void> {
    const sock = await this.ensureConnected();
    sock.write(`SET ${bucket} ${key} ${JSON.stringify(value)}\n`);
    const resp = await this.readLine();
    if (resp.trim() !== "OK") throw new Error(`SET failed: ${resp}`);
  }

  async get<T = unknown>(bucket: string, key: string): Promise<T | null> {
    const sock = await this.ensureConnected();
    sock.write(`GET ${bucket} ${key}\n`);
    const resp = await this.readLine();
    if (resp === "NIL") return null;
    if (resp.startsWith("VALUE ")) return JSON.parse(resp.slice(6)) as T;
    throw new Error(`GET failed: ${resp}`);
  }

  async *listen<T = unknown>(
    bucket: string,
    event = "*"
  ): AsyncGenerator<{ bucket: string; event: string; data: T }> {
    const sub: ListenSub = { kind: "listen", bucket, event };
    this.activeSubs.add(sub);
    try {
      const sock = await this.ensureConnected();
      sock.write(`SUB ${bucket} ${event}\n`);

      while (!this.closed) {
        const line = await this.readLine();
        if (line.startsWith("EVENT ")) {
          const rest = line.slice(6);
          const sp1 = rest.indexOf(" ");
          const sp2 = rest.indexOf(" ", sp1 + 1);
          if (sp1 !== -1 && sp2 !== -1) {
            yield {
              bucket: rest.slice(0, sp1),
              event: rest.slice(sp1 + 1, sp2),
              data: JSON.parse(rest.slice(sp2 + 1)) as T,
            };
          }
        }
      }
    } finally {
      this.activeSubs.delete(sub);
    }
  }

  async *watch<T = unknown>(bucket: string, key: string): AsyncGenerator<T> {
    const sub: WatchSub = { kind: "watch", bucket, key };
    this.activeSubs.add(sub);
    try {
      const sock = await this.ensureConnected();
      sock.write(`WATCH ${bucket} ${key}\n`);

      while (!this.closed) {
        const line = await this.readLine();
        if (line.startsWith("VALUE ")) {
          yield JSON.parse(line.slice(6)) as T;
        }
      }
    } finally {
      this.activeSubs.delete(sub);
    }
  }

  close(): void {
    this.closed = true;
    this.stopKeepalive();
    this.activeSubs.clear();
    this.sock?.end();
    this.sock = null;
    this.connected = false;
    // Release any parked readers so awaiting generators can settle.
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w("");
  }

  // ---------------------------------------------------------------------------
  // Test hooks (deterministic, no daemon required)
  // ---------------------------------------------------------------------------

  /** @internal Feed a synthetic chunk into the line parser. */
  _feed(chunk: string): void {
    this.ingest(chunk);
  }

  /** @internal Read the next line via the single-consumer path. */
  _readLine(): Promise<string> {
    return this.readLine();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Convenience: one-shot client for scripts
export async function emit(
  bucket: string,
  event: string,
  data?: unknown
): Promise<void> {
  const bus = new NBus();
  await bus.emit(bucket, event, data);
  bus.close();
}

export async function set(
  bucket: string,
  key: string,
  value: unknown
): Promise<void> {
  const bus = new NBus();
  await bus.set(bucket, key, value);
  bus.close();
}

export async function get<T = unknown>(
  bucket: string,
  key: string
): Promise<T | null> {
  const bus = new NBus();
  const val = await bus.get<T>(bucket, key);
  bus.close();
  return val;
}
