import { Bus, BusError } from "./bus";
import { handleCommand } from "./protocol";
import type { ClientState } from "./protocol";
import { loadConfig } from "./config";
import type { Socket } from "bun";
import { existsSync, unlinkSync, chmodSync } from "fs";

const config = loadConfig();
const SOCKET_PATH = config.server.socket_path;
const HTTP_PORT = config.server.http_port;
const TCP_PORT = config.server.tcp_port;
const TCP_BIND = config.server.tcp_bind;

const bus = new Bus(config);
const clients = new Map<Socket, ClientState>();

const handleOpts = { maxSubscriptions: config.limits.max_subscriptions_per_client };

// ── Shared line-protocol socket handlers (Unix + TCP) ────────────────
// Both transports speak the identical wire protocol (PROTOCOL.md §2.3), so
// they share one ClientState map and one set of handlers.

const socketHandlers = {
  data(socket: Socket, data: Buffer) {
    const client = clients.get(socket);
    if (!client) return;
    client.buf += data.toString();

    // Process complete lines.
    while (true) {
      const idx = client.buf.indexOf("\n");
      if (idx === -1) break;
      const line = client.buf.slice(0, idx);
      client.buf = client.buf.slice(idx + 1);
      if (!line.trim()) continue;

      const resp = handleCommand(line, bus, client, handleOpts);
      if (resp) socket.write(resp);
    }
  },
  open(socket: Socket) {
    clients.set(socket, { subs: new Map(), watches: new Map(), socket, buf: "" });
  },
  close(socket: Socket) {
    teardownClient(socket);
  },
  error(socket: Socket, err: Error) {
    console.error("socket error:", err.message);
    teardownClient(socket);
  },
};

function teardownClient(socket: Socket): void {
  const client = clients.get(socket);
  if (!client) return;
  for (const unsub of client.subs.values()) unsub();
  for (const unsub of client.watches.values()) unsub();
  clients.delete(socket);
}

// ── Unix Socket Server ──────────────────────────────────────────────

if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

const unixServer = Bun.listen({
  unix: SOCKET_PATH,
  socket: socketHandlers,
});

chmodSync(SOCKET_PATH, 0o600);
console.log(`nbusd listening on ${SOCKET_PATH}`);

// ── TCP Server (optional, §2.3) ──────────────────────────────────────

let tcpServer: { stop(): void } | null = null;

if (TCP_PORT > 0) {
  tcpServer = Bun.listen({
    hostname: TCP_BIND,
    port: TCP_PORT,
    socket: socketHandlers,
  });
  console.log(`nbusd TCP on ${TCP_BIND}:${TCP_PORT}`);
}

// ── HTTP Server ──────────────────────────────────────────────────────

/** Map a BusError to the appropriate HTTP status. */
function busErrorResponse(err: BusError): Response {
  const status = err.code === "max_payload_bytes" ? 413 : 429;
  return new Response(err.message, { status });
}

const httpServer = Bun.serve({
  port: HTTP_PORT,
  hostname: "127.0.0.1",

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const body = await req.text().catch(() => "");

    try {
      // POST /emit/:bucket/:event
      if (method === "POST" && path.startsWith("/emit/")) {
        const [, , bucket, event] = path.split("/");
        if (!bucket) return new Response("missing bucket", { status: 400 });
        bus.emit(bucket, event ?? "default", body || "null");
        return new Response(null, { status: 204 });
      }

      // POST /state/:bucket/:key
      if (method === "POST" && path.startsWith("/state/")) {
        const [, , bucket, key] = path.split("/");
        if (!bucket || !key) return new Response("missing bucket/key", { status: 400 });
        // Store the value as a raw JSON token so GET round-trips it (BUG #2).
        // Body may be either {"value": X} (spec §4.3) or a bare JSON value.
        const value = extractStateValue(body);
        bus.set(bucket, key, value);
        return new Response("OK", { status: 200 });
      }

      // GET /state/:bucket/:key
      if (method === "GET" && path.startsWith("/state/")) {
        const [, , bucket, key] = path.split("/");
        if (!bucket || !key) return new Response("missing bucket/key", { status: 400 });
        const val = bus.get(bucket, key);
        if (val === undefined) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ value: tryParseJson(val) });
      }

      // GET /listen/:bucket/:event  (SSE)
      if (method === "GET" && path.startsWith("/listen/")) {
        const [, , bucket, event] = path.split("/");
        if (!bucket) return new Response("missing bucket", { status: 400 });
        const filter = event ?? "*";
        const b = bus.getBucket(bucket);

        // Captured in start(), invoked in cancel() to stop the listener leak (BUG #4).
        let unsub: (() => void) | null = null;

        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const buffered = filter === "*"
              ? b.bufferedEvents
              : b.bufferedEventsFor(filter);
            for (const ev of buffered) {
              controller.enqueue(enc.encode(`event: ${ev.bucket}:${ev.event}\ndata: ${ev.data}\n\n`));
            }
            unsub = b.subscribe((ev) => {
              try {
                controller.enqueue(enc.encode(`event: ${ev.bucket}:${ev.event}\ndata: ${ev.data}\n\n`));
              } catch {}
            }, filter);
          },
          cancel() {
            if (unsub) unsub();
          },
        });

        return sseResponse(stream);
      }

      // GET /watch/:bucket/:key  (SSE)
      if (method === "GET" && path.startsWith("/watch/")) {
        const [, , bucket, key] = path.split("/");
        if (!bucket || !key) return new Response("missing bucket/key", { status: 400 });
        const b = bus.getBucket(bucket);

        let unsub: (() => void) | null = null;

        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const current = b.get(key);
            if (current !== undefined) {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(tryParseJson(current))}\n\n`));
            }
            unsub = b.watch(key, (change) => {
              try {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(tryParseJson(change.value))}\n\n`));
              } catch {}
            });
          },
          cancel() {
            if (unsub) unsub();
          },
        });

        return sseResponse(stream);
      }

      // GET /stats
      if (method === "GET" && path === "/stats") {
        return Response.json(bus.stats());
      }

      // GET /buckets
      if (method === "GET" && path === "/buckets") {
        return Response.json(bus.bucketNames());
      }

      return Response.json({ error: "not found" }, { status: 404 });
    } catch (err) {
      if (err instanceof BusError) return busErrorResponse(err);
      throw err;
    }
  },
});

console.log(`nbusd HTTP on http://127.0.0.1:${HTTP_PORT}`);

// ── Graceful shutdown ────────────────────────────────────────────────

function shutdown(): void {
  console.log("\nnbusd shutting down...");
  for (const socket of [...clients.keys()]) teardownClient(socket);
  clients.clear();
  bus.stop();
  unixServer.stop();
  httpServer.stop();
  if (tcpServer) tcpServer.stop();
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Helpers ──────────────────────────────────────────────────────────

function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/**
 * Normalize an HTTP /state body into the raw JSON token stored by the bus.
 * Accepts `{"value": X}` (spec §4.3) → JSON(X), or a bare JSON value → verbatim.
 * Falls back to the raw body string when it isn't JSON.
 */
function extractStateValue(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "null";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "value" in parsed
    ) {
      return JSON.stringify((parsed as { value: unknown }).value);
    }
    // Bare JSON value: store verbatim so GET round-trips it.
    return trimmed;
  } catch {
    return trimmed;
  }
}

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
