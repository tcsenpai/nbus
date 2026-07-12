import { test, expect } from "bun:test";
import type { Socket } from "bun";
import { Bus } from "./bus";
import { handleCommand, type ClientState, type HandleOptions } from "./protocol";

/** Mock ClientState: socket.write appends decoded text into `written`. */
function makeClient(): { client: ClientState; written: string[] } {
  const written: string[] = [];
  const socket = {
    write(data: string | ArrayBufferView | ArrayBuffer): number {
      const text = typeof data === "string"
        ? data
        : new TextDecoder().decode(data as Uint8Array);
      written.push(text);
      return text.length;
    },
  } as unknown as Socket;
  return {
    client: { subs: new Map(), watches: new Map(), socket, buf: "" },
    written,
  };
}

const OPTS: HandleOptions = { maxSubscriptions: 64 };

function run(bus: Bus, client: ClientState, line: string, opts: HandleOptions = OPTS): string | null {
  return handleCommand(line, bus, client, opts);
}

test("SET→GET round-trips a string via SDK JSON.parse", () => {
  const bus = new Bus();
  const { client } = makeClient();
  // SDK sends SET <b> <k> <JSON.stringify(value)>
  const wire = JSON.stringify("1.2.3"); // "\"1.2.3\""
  expect(run(bus, client, `SET app version ${wire}`)).toBe("OK\n");
  const resp = run(bus, client, "GET app version");
  expect(resp).not.toBeNull();
  const token = resp!.slice("VALUE ".length, -1); // strip "VALUE " and "\n"
  expect(JSON.parse(token)).toBe("1.2.3");
});

test("SET→GET round-trips a number", () => {
  const bus = new Bus();
  const { client } = makeClient();
  expect(run(bus, client, `SET app count ${JSON.stringify(123)}`)).toBe("OK\n");
  const resp = run(bus, client, "GET app count")!;
  expect(JSON.parse(resp.slice(6, -1))).toBe(123);
});

test("SET→GET round-trips an object (with spaces)", () => {
  const bus = new Bus();
  const { client } = makeClient();
  const obj = { x: 1, name: "hello world" };
  expect(run(bus, client, `SET app obj ${JSON.stringify(obj)}`)).toBe("OK\n");
  const resp = run(bus, client, "GET app obj")!;
  expect(JSON.parse(resp.slice(6, -1))).toEqual(obj);
});

test("GET on missing key returns NIL and does not create the bucket", () => {
  const bus = new Bus();
  const { client } = makeClient();
  expect(run(bus, client, "GET nope key")).toBe("NIL\n");
  expect(bus.bucketNames()).not.toContain("nope");
});

test("UNSUB removes a live sub (no delivery after)", () => {
  const bus = new Bus();
  const { client, written } = makeClient();
  expect(run(bus, client, "SUB deploy done")).toBeNull();
  bus.emit("deploy", "done", '{"n":1}');
  expect(written.length).toBe(1);
  expect(written[0]).toBe('EVENT deploy done {"n":1}\n');

  expect(run(bus, client, "UNSUB deploy done")).toBe("OK\n");
  bus.emit("deploy", "done", '{"n":2}');
  expect(written.length).toBe(1); // nothing new after UNSUB
});

test("UNSUB without event drops all subs in the bucket", () => {
  const bus = new Bus();
  const { client, written } = makeClient();
  run(bus, client, "SUB deploy done");
  run(bus, client, "SUB deploy failed");
  expect(client.subs.size).toBe(2);
  expect(run(bus, client, "UNSUB deploy")).toBe("OK\n");
  expect(client.subs.size).toBe(0);
  bus.emit("deploy", "done", "1");
  bus.emit("deploy", "failed", "1");
  expect(written.length).toBe(0);
});

test("UNWATCH stops value updates", () => {
  const bus = new Bus();
  const { client, written } = makeClient();
  run(bus, client, `SET app v ${JSON.stringify("a")}`);
  // WATCH returns current value inline
  expect(run(bus, client, "WATCH app v")).toBe('VALUE "a"\n');
  run(bus, client, `SET app v ${JSON.stringify("b")}`);
  expect(written).toEqual(['VALUE "b"\n']);

  expect(run(bus, client, "UNWATCH app v")).toBe("OK\n");
  run(bus, client, `SET app v ${JSON.stringify("c")}`);
  expect(written).toEqual(['VALUE "b"\n']); // no new push after UNWATCH
});

test("max_subscriptions_per_client returns ERROR and does not subscribe", () => {
  const bus = new Bus();
  const { client } = makeClient();
  const opts: HandleOptions = { maxSubscriptions: 2 };
  expect(run(bus, client, "SUB a e1", opts)).toBeNull();
  expect(run(bus, client, "SUB a e2", opts)).toBeNull();
  expect(run(bus, client, "SUB a e3", opts)).toBe("ERROR max subscriptions reached\n");
  expect(client.subs.size).toBe(2);

  // WATCH also counts against the same cap.
  expect(run(bus, client, "WATCH a k", opts)).toBe("ERROR max subscriptions reached\n");
  expect(client.watches.size).toBe(0);
});

test("oversized payload → ERROR (BusError translated)", () => {
  const bus = new Bus({
    server: { socket_path: "/tmp/x.sock", http_port: 0, tcp_port: 0, tcp_bind: "127.0.0.1" },
    limits: {
      max_buckets: 1024,
      max_subscriptions_per_client: 64,
      max_payload_bytes: 8,
      buffer_size: 64,
      bucket_ttl_seconds: 300,
    },
    behavior: { watch_on_equal: true },
  });
  const { client } = makeClient();
  const big = JSON.stringify("way too long to fit in eight bytes");
  const resp = run(bus, client, `SET app k ${big}`);
  expect(resp).not.toBeNull();
  expect(resp!.startsWith("ERROR ")).toBe(true);
  expect(resp).toContain("payload too large");
});

test("unknown command → ERROR", () => {
  const bus = new Bus();
  const { client } = makeClient();
  expect(run(bus, client, "FLOOF a b")).toBe("ERROR unknown command\n");
});

test("PING → PONG, STATS/BUCKETS → OK json", () => {
  const bus = new Bus();
  const { client } = makeClient();
  expect(run(bus, client, "PING")).toBe("PONG\n");
  run(bus, client, `SET app k ${JSON.stringify(1)}`);
  const stats = run(bus, client, "STATS")!;
  expect(stats.startsWith("OK ")).toBe(true);
  expect(JSON.parse(stats.slice(3)).keys).toBe(1);
  const buckets = run(bus, client, "BUCKETS")!;
  expect(JSON.parse(buckets.slice(3))).toContain("app");
});
