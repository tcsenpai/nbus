import type { Socket } from "bun";
import { Bus, BusError, type Event } from "./bus";

/**
 * Per-client protocol state. Owned by protocol.ts; daemon.ts constructs it.
 *
 * Subscriptions are keyed so UNSUB/UNWATCH can selectively remove the right
 * teardown fn:
 *   - `subs`   : SUB streams,   key = `${bucket}\0${event}` (event "*" = wildcard)
 *   - `watches`: WATCH streams, key = `${bucket}\0${key}`
 *
 * `subCount()` (subs + watches) feeds the per-client max_subscriptions_per_client
 * limit, which the Bus does NOT enforce by design.
 */
export interface ClientState {
  subs: Map<string, () => void>;
  watches: Map<string, () => void>;
  socket: Socket;
  buf: string;
}

export interface HandleOptions {
  /** Per-client cap; when subs+watches would exceed it, SUB/WATCH is rejected. */
  maxSubscriptions: number;
}

const encoder = new TextEncoder();

function subKey(bucket: string, event: string): string {
  return `${bucket}\0${event}`;
}

function subCount(client: ClientState): number {
  return client.subs.size + client.watches.size;
}

export function parseLine(line: string): { cmd: string; args: string[] } {
  const trimmed = line.trim();
  if (!trimmed) return { cmd: "", args: [] };
  // Split into at most 4 tokens; the last (JSON payload/value) may contain spaces.
  const parts: string[] = [];
  let rest = trimmed;
  for (let i = 0; i < 3; i++) {
    const idx = rest.indexOf(" ");
    if (idx === -1) { parts.push(rest); rest = ""; break; }
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  if (rest) parts.push(rest);
  return { cmd: parts[0]?.toUpperCase() ?? "", args: parts.slice(1) };
}

export function handleCommand(
  line: string,
  bus: Bus,
  client: ClientState,
  opts: HandleOptions,
): string | null {
  const { cmd, args } = parseLine(line);
  try {
    switch (cmd) {
      case "EMIT": {
        const [bucket, event] = args;
        const data = args[2] ?? "null";
        if (!bucket) return "ERROR missing bucket\n";
        bus.emit(bucket, event ?? "default", data);
        return "OK\n";
      }

      case "SUB": {
        const [bucket, event] = args;
        if (!bucket) return "ERROR missing bucket\n";
        const filter = event ?? "*";
        const key = subKey(bucket, filter);

        // Already subscribed to this exact bucket/event: no-op stream.
        if (client.subs.has(key)) return null;
        if (subCount(client) >= opts.maxSubscriptions) {
          return "ERROR max subscriptions reached\n";
        }

        const b = bus.getBucket(bucket);

        // Buffered events first (single-event buffer for filtered SUB).
        const buffered = filter === "*"
          ? b.bufferedEvents
          : b.bufferedEventsFor(filter);
        let initial = "";
        for (const ev of buffered) initial += formatEvent(ev);

        // Live stream (Bucket applies the filter internally).
        const unsub = b.subscribe((ev) => {
          try {
            client.socket.write(encoder.encode(formatEvent(ev)));
          } catch {}
        }, filter);
        client.subs.set(key, unsub);
        return initial || null; // null = stream mode, no immediate response
      }

      case "UNSUB": {
        const [bucket, event] = args;
        if (!bucket) return "ERROR missing bucket\n";
        if (event) {
          const teardown = client.subs.get(subKey(bucket, event));
          if (teardown) {
            teardown();
            client.subs.delete(subKey(bucket, event));
          }
        } else {
          // No event arg: drop every sub in this bucket for this client.
          const prefix = `${bucket}\0`;
          for (const [k, teardown] of client.subs) {
            if (k.startsWith(prefix)) {
              teardown();
              client.subs.delete(k);
            }
          }
        }
        return "OK\n";
      }

      case "SET": {
        const [bucket, key, ...rest] = args;
        if (!bucket || !key) return "ERROR missing bucket or key\n";
        // Store the RAW JSON token verbatim so GET round-trips it back and the
        // SDK's JSON.parse recovers the original value (BUG #2 fix).
        const value = rest.join(" ");
        bus.set(bucket, key, value);
        return "OK\n";
      }

      case "GET": {
        const [bucket, key] = args;
        if (!bucket || !key) return "ERROR missing bucket or key\n";
        const val = bus.get(bucket, key);
        return val !== undefined ? `VALUE ${val}\n` : "NIL\n";
      }

      case "WATCH": {
        const [bucket, key] = args;
        if (!bucket || !key) return "ERROR missing bucket or key\n";
        const wkey = subKey(bucket, key);

        if (client.watches.has(wkey)) {
          // Already watching: just re-send current value if any.
          const current = bus.get(bucket, key);
          return current !== undefined ? `VALUE ${current}\n` : null;
        }
        if (subCount(client) >= opts.maxSubscriptions) {
          return "ERROR max subscriptions reached\n";
        }

        const b = bus.getBucket(bucket);
        const current = bus.get(bucket, key);
        let initial = "";
        if (current !== undefined) initial = `VALUE ${current}\n`;

        const unsub = b.watch(key, (change) => {
          try {
            client.socket.write(encoder.encode(`VALUE ${change.value}\n`));
          } catch {}
        });
        client.watches.set(wkey, unsub);
        return initial || null;
      }

      case "UNWATCH": {
        const [bucket, key] = args;
        if (!bucket || !key) return "ERROR missing bucket or key\n";
        const wkey = subKey(bucket, key);
        const teardown = client.watches.get(wkey);
        if (teardown) {
          teardown();
          client.watches.delete(wkey);
        }
        return "OK\n";
      }

      case "PING":
        return "PONG\n";

      case "STATS":
        return `OK ${JSON.stringify(bus.stats())}\n`;

      case "BUCKETS":
        return `OK ${JSON.stringify(bus.bucketNames())}\n`;

      default:
        return "ERROR unknown command\n";
    }
  } catch (err) {
    if (err instanceof BusError) return `ERROR ${err.message}\n`;
    throw err;
  }
}

function formatEvent(ev: Event): string {
  return `EVENT ${ev.bucket} ${ev.event} ${ev.data}\n`;
}
