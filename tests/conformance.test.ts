// Language-agnostic conformance runner (reference implementation).
//
// Boots the REAL daemon on a private Unix socket, then replays every vector in
// tests/vectors.json against it, emitting one bun:test `test()` per vector.
// The vectors themselves are the spec (see tests/vectors.schema.md); this file
// is just the TypeScript executor other-language runners can mirror.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { connect, type Socket } from "bun";
import { existsSync, unlinkSync } from "node:fs";

// ── Vector schema (mirrors tests/vectors.json) ───────────────────────────────

interface SendRepeat {
  prefix: string;
  fill: string;
  count: number;
  suffix: string;
}

type Matcher =
  | { equals: string }
  | { matches: string }
  | { silent: true };

interface Step {
  conn?: number;
  send?: string;
  send_repeat?: SendRepeat;
  expect?: Matcher;
}

interface Vector {
  name: string;
  description: string;
  steps: Step[];
}

// ── Single-consumer line buffer per connection (mirrors src/client.ts) ───────

class Conn {
  private sock: Socket | null = null;
  private buf = "";
  private lineQueue: string[] = [];
  private waiters: ((line: string) => void)[] = [];
  /** Pending outbound bytes not yet accepted by the kernel (backpressure). */
  private pending: Uint8Array | null = null;

  static async open(socketPath: string): Promise<Conn> {
    const c = new Conn();
    c.sock = await connect({
      unix: socketPath,
      socket: {
        data: (_s, data: Buffer) => c.ingest(data.toString()),
        drain: () => c.flush(),
        error: () => {},
        close: () => {},
      },
    });
    return c;
  }

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

  // Bun's Socket.write may accept only part of a large buffer when the send
  // buffer fills; the remainder is flushed on the `drain` event. Large payloads
  // (the oversized-payload vector) exceed one buffer, so we handle backpressure.
  send(line: string): void {
    this.pending = new TextEncoder().encode(line + "\n");
    this.flush();
  }

  private flush(): void {
    const sock = this.sock;
    if (!sock || !this.pending) return;
    const n = sock.write(this.pending);
    if (n >= this.pending.length) this.pending = null;
    else this.pending = this.pending.subarray(n);
  }

  /** Next line, or null if none arrives within `timeoutMs`. */
  readLine(timeoutMs: number): Promise<string | null> {
    const queued = this.lineQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string | null>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      const waiter = (line: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(line);
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.sock?.end();
    this.sock = null;
  }
}

// ── Daemon lifecycle ─────────────────────────────────────────────────────────

const SOCKET_PATH = `/tmp/nbus-conf-${process.pid}.sock`;
const HTTP_PORT = 17600 + (process.pid % 1000);
const READ_TIMEOUT_MS = 1500;
const DRAIN_MS = 200;

let daemon: ReturnType<typeof Bun.spawn> | null = null;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeAll(async () => {
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

  daemon = Bun.spawn(["bun", "run", "src/daemon.ts"], {
    env: {
      ...process.env,
      NBUS_SOCKET: SOCKET_PATH,
      NBUS_HTTP_PORT: String(HTTP_PORT),
      NBUS_TCP_PORT: "0",
    },
    stdout: "ignore",
    stderr: "ignore",
    cwd: import.meta.dir + "/..",
  });

  // Wait for the socket file to appear (daemon has booted and is listening).
  const deadline = Date.now() + 3000;
  while (!existsSync(SOCKET_PATH)) {
    if (Date.now() > deadline) throw new Error("daemon did not create socket in time");
    await sleep(25);
  }
  // Small grace so the listener is actually accepting.
  await sleep(50);
});

afterAll(() => {
  daemon?.kill();
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch {}
  }
});

// ── Vector execution ─────────────────────────────────────────────────────────

const vectorsUrl = new URL("./vectors.json", import.meta.url);
const vectors = (await Bun.file(vectorsUrl).json()) as Vector[];

function buildLine(step: Step): string | null {
  if (step.send !== undefined) return step.send;
  if (step.send_repeat) {
    const r = step.send_repeat;
    return r.prefix + r.fill.repeat(r.count) + r.suffix;
  }
  return null; // pure-assertion step (no send)
}

async function runVector(vec: Vector): Promise<void> {
  const conns = new Map<number, Conn>();
  const getConn = async (idx: number): Promise<Conn> => {
    let c = conns.get(idx);
    if (!c) {
      c = await Conn.open(SOCKET_PATH);
      conns.set(idx, c);
    }
    return c;
  };

  try {
    for (const step of vec.steps) {
      const conn = await getConn(step.conn ?? 0);
      const line = buildLine(step);
      if (line !== null) conn.send(line);

      if (!step.expect) continue; // fire-and-forget

      const m = step.expect;
      if ("silent" in m) {
        const got = await conn.readLine(DRAIN_MS);
        expect(got).toBeNull();
      } else {
        const got = await conn.readLine(READ_TIMEOUT_MS);
        expect(got).not.toBeNull();
        if ("equals" in m) {
          expect(got).toBe(m.equals);
        } else {
          expect(got).toMatch(new RegExp(m.matches));
        }
      }
    }
  } finally {
    for (const c of conns.values()) c.close();
  }
}

for (const vec of vectors) {
  if (vec.name.startsWith("_")) continue; // doc-only entries
  test(vec.name, async () => {
    await runVector(vec);
  });
}
