import { test, expect } from "bun:test";
import { Bus, Bucket, BusError, type Config } from "./src/bus";

function makeConfig(overrides: {
  max_buckets?: number;
  max_payload_bytes?: number;
  buffer_size?: number;
  bucket_ttl_seconds?: number;
  watch_on_equal?: boolean;
}): Config {
  return {
    server: { socket_path: "/tmp/x.sock", http_port: 0, tcp_port: 0, tcp_bind: "127.0.0.1" },
    limits: {
      max_buckets: overrides.max_buckets ?? 1024,
      max_subscriptions_per_client: 64,
      max_payload_bytes: overrides.max_payload_bytes ?? 262144,
      buffer_size: overrides.buffer_size ?? 64,
      bucket_ttl_seconds: overrides.bucket_ttl_seconds ?? 300,
    },
    behavior: {
      watch_on_equal: overrides.watch_on_equal ?? true,
    },
  };
}

test("per-event ring buffer isolation", () => {
  const bus = new Bus(makeConfig({ buffer_size: 64 }));
  for (let i = 0; i < 100; i++) bus.emit("b", "A", `${i}`);
  bus.emit("b", "B", "solo");
  const bucket = bus.getBucket("b");

  // A is capped at buffer_size, B keeps its single event.
  expect(bucket.bufferedEventsFor("A").length).toBe(64);
  expect(bucket.bufferedEventsFor("B").length).toBe(1);
  expect(bucket.bufferedEventsFor("B")[0]?.data).toBe("solo");

  // A capped to the MOST RECENT 64 (ring drops oldest).
  const aData = bucket.bufferedEventsFor("A").map((e) => e.data);
  expect(aData[0]).toBe("36");
  expect(aData[aData.length - 1]).toBe("99");

  // Flattened view (wildcard) includes both event names.
  expect(bucket.bufferedEvents.length).toBe(65);
  bus.stop();
});

test("max_payload_bytes rejects oversized emit and set", () => {
  const bus = new Bus(makeConfig({ max_payload_bytes: 10 }));
  expect(() => bus.emit("b", "e", "x".repeat(11))).toThrow(BusError);
  expect(() => bus.set("b", "k", "x".repeat(11))).toThrow(BusError);
  // Multibyte: 4 chars of "€" = 12 bytes > 10.
  expect(() => bus.emit("b", "e", "€€€€")).toThrow(BusError);
  // Within limit is fine.
  expect(() => bus.emit("b", "e", "ok")).not.toThrow();
  bus.stop();
});

test("watch_on_equal=false suppresses duplicate value", () => {
  const bus = new Bus(makeConfig({ watch_on_equal: false }));
  const bucket = bus.getBucket("b");
  const fired: string[] = [];
  bucket.watch("k", (c) => fired.push(c.value));

  bus.set("b", "k", "1"); // change
  bus.set("b", "k", "1"); // equal -> suppressed
  bus.set("b", "k", "2"); // change
  expect(fired).toEqual(["1", "2"]);
  bus.stop();
});

test("watch_on_equal=true fires on duplicate value", () => {
  const bus = new Bus(makeConfig({ watch_on_equal: true }));
  const bucket = bus.getBucket("b");
  const fired: string[] = [];
  bucket.watch("k", (c) => fired.push(c.value));

  bus.set("b", "k", "1");
  bus.set("b", "k", "1"); // equal -> still fires
  expect(fired).toEqual(["1", "1"]);
  bus.stop();
});

test("max_buckets throws BusError on new bucket beyond limit", () => {
  const bus = new Bus(makeConfig({ max_buckets: 2 }));
  bus.getBucket("a");
  bus.getBucket("b");
  expect(() => bus.getBucket("c")).toThrow(BusError);
  // Existing buckets still retrievable.
  expect(() => bus.getBucket("a")).not.toThrow();
  try {
    bus.getBucket("c");
  } catch (e) {
    expect(e).toBeInstanceOf(BusError);
    expect((e as BusError).code).toBe("max_buckets");
  }
  bus.stop();
});

test("TTL eligibility predicate (deterministic, no real wait)", () => {
  const bus = new Bus(makeConfig({ bucket_ttl_seconds: 300 }));
  const idle = bus.getBucket("idle");
  // Force lastActivity into the past beyond TTL.
  idle.lastActivity = Date.now() - 301_000;
  expect(bus.isBucketExpirable(idle)).toBe(true);

  // Not idle: has a key.
  const withKey = bus.getBucket("withKey");
  withKey.set("k", "v", true);
  withKey.lastActivity = Date.now() - 301_000;
  expect(bus.isBucketExpirable(withKey)).toBe(false);

  // Not idle: has a subscriber.
  const withSub = bus.getBucket("withSub");
  withSub.subscribe(() => {});
  withSub.lastActivity = Date.now() - 301_000;
  expect(bus.isBucketExpirable(withSub)).toBe(false);

  // Recent idle bucket is not expirable yet.
  const fresh = bus.getBucket("fresh");
  expect(bus.isBucketExpirable(fresh)).toBe(false);

  // Sweep removes only the eligible one.
  bus.sweepIdleBuckets();
  expect(bus.buckets.has("idle")).toBe(false);
  expect(bus.buckets.has("withKey")).toBe(true);
  expect(bus.buckets.has("withSub")).toBe(true);
  expect(bus.buckets.has("fresh")).toBe(true);
  bus.stop();
});

test("stats reports subscriptions and keys", () => {
  const bus = new Bus(makeConfig({}));
  const b = bus.getBucket("b");
  b.subscribe(() => {});
  b.watch("k", () => {});
  bus.set("b", "k", "v");
  const s = bus.stats();
  expect(s.buckets).toBe(1);
  expect(s.subscriptions).toBe(2); // 1 event listener + 1 watch listener
  expect(s.keys).toBe(1);
  expect(typeof s.uptime_seconds).toBe("number");
  bus.stop();
});

test("default constructor still works (new Bus())", () => {
  const bus = new Bus();
  expect(bus).toBeInstanceOf(Bus);
  bus.stop();
});

test("Bucket export is usable directly", () => {
  const b = new Bucket("x", 4);
  for (let i = 0; i < 10; i++) b.emit("e", `${i}`);
  expect(b.bufferedEventsFor("e").length).toBe(4);
});
