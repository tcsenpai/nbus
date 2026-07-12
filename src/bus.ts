// nbus in-memory pub/sub + shared-state core.
//
// See PROTOCOL.md §7 (Server Behavior) and §6 (Data Format). This module owns:
//   - per-bucket, per-event ring buffers (§7.1)
//   - fan-out to subscribers (§7.2)
//   - per-bucket key/value state + WATCH (§7.3)
//   - idle-bucket TTL sweep (§7.4)
//   - payload / bucket-count limit enforcement (§6, §8)
//
// Callers (protocol.ts, daemon.ts) drive per-client subscription objects and
// per-client subscription limits; those are NOT tracked here.

import { loadConfig, type Config } from "./config";
export type { Config } from "./config";

export interface Event {
  bucket: string;
  event: string;
  data: string; // JSON string
}

export interface ValueChange {
  bucket: string;
  key: string;
  value: string; // JSON string
}

type Listener<T> = (msg: T) => void;

/** Reason codes for BusError, so callers can map to protocol / HTTP errors. */
export type BusErrorCode =
  | "max_buckets"
  | "max_payload_bytes";

/** Typed error thrown on limit violations. Callers translate to "ERROR ..." / 4xx. */
export class BusError extends Error {
  readonly code: BusErrorCode;
  constructor(code: BusErrorCode, message: string) {
    super(message);
    this.name = "BusError";
    this.code = code;
  }
}

function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export class Bucket {
  readonly name: string;
  eventListeners = new Set<Listener<Event>>();
  watchListeners = new Map<string, Set<Listener<ValueChange>>>();
  state = new Map<string, string>();

  /** Per-event ring buffers (§7.1: buffer is per-bucket, per-event). */
  private eventBuffers = new Map<string, Event[]>();
  readonly bufferSize: number;

  /** Last emit/set/subscribe/watch time (epoch ms); drives TTL sweep (§7.4). */
  lastActivity = Date.now();

  constructor(name: string, bufferSize: number) {
    this.name = name;
    this.bufferSize = bufferSize;
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  emit(event: string, data: string): void {
    const ev: Event = { bucket: this.name, event, data };
    // Ring buffer, isolated per event name.
    let buf = this.eventBuffers.get(event);
    if (buf === undefined) {
      buf = [];
      this.eventBuffers.set(event, buf);
    }
    if (buf.length >= this.bufferSize) buf.shift();
    buf.push(ev);
    this.touch();
    // Fan-out to every listener (wildcard + exact filtered by the wrapper).
    for (const fn of this.eventListeners) fn(ev);
  }

  subscribe(fn: Listener<Event>, filter?: string): () => void {
    const wrapped = filter && filter !== "*"
      ? (ev: Event) => { if (ev.event === filter) fn(ev); }
      : fn;
    this.eventListeners.add(wrapped);
    this.touch();
    return () => this.eventListeners.delete(wrapped);
  }

  /**
   * Store a value and fire WATCH listeners.
   * When watchOnEqual is false, an unchanged value does NOT fire (§7.3).
   */
  set(key: string, value: string, watchOnEqual = true): void {
    const previous = this.state.get(key);
    this.state.set(key, value);
    this.touch();
    if (!watchOnEqual && previous === value) return;
    const change: ValueChange = { bucket: this.name, key, value };
    const listeners = this.watchListeners.get(key);
    if (listeners) for (const fn of listeners) fn(change);
  }

  get(key: string): string | undefined {
    return this.state.get(key);
  }

  watch(key: string, fn: Listener<ValueChange>): () => void {
    let set = this.watchListeners.get(key);
    if (set === undefined) {
      set = new Set();
      this.watchListeners.set(key, set);
    }
    set.add(fn);
    this.touch();
    return () => {
      const s = this.watchListeners.get(key);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.watchListeners.delete(key);
    };
  }

  /** All buffered events (flattened) — for wildcard subscribers (§7.1). */
  get bufferedEvents(): Event[] {
    const out: Event[] = [];
    for (const buf of this.eventBuffers.values()) out.push(...buf);
    return out;
  }

  /** Buffered events for ONE event name — for filtered SUB (no mixed-array scan). */
  bufferedEventsFor(event: string): Event[] {
    const buf = this.eventBuffers.get(event);
    return buf ? [...buf] : [];
  }

  /** Total active listeners (event + watch) — feeds Bus.stats().subscriptions. */
  get subscriptionCount(): number {
    let n = this.eventListeners.size;
    for (const s of this.watchListeners.values()) n += s.size;
    return n;
  }

  /** TTL eligibility (§7.4): no subscribers AND no keys. */
  get isIdle(): boolean {
    return this.eventListeners.size === 0
      && this.watchListeners.size === 0
      && this.state.size === 0;
  }
}

export interface BusStats {
  buckets: number;
  subscriptions: number;
  keys: number;
  uptime_seconds: number;
}

const SWEEP_INTERVAL_MS = 30_000;

export class Bus {
  buckets = new Map<string, Bucket>();
  readonly createdAt = Date.now();

  private readonly bufferSize: number;
  private readonly maxBuckets: number;
  private readonly maxPayloadBytes: number;
  private readonly bucketTtlMs: number;
  private readonly watchOnEqual: boolean;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Config = loadConfig()) {
    this.bufferSize = config.limits.buffer_size;
    this.maxBuckets = config.limits.max_buckets;
    this.maxPayloadBytes = config.limits.max_payload_bytes;
    this.bucketTtlMs = config.limits.bucket_ttl_seconds * 1000;
    this.watchOnEqual = config.behavior.watch_on_equal;
    this.startSweep();
  }

  private startSweep(): void {
    const timer = setInterval(() => this.sweepIdleBuckets(), SWEEP_INTERVAL_MS);
    // Don't keep the process alive just for the sweep.
    if (typeof timer.unref === "function") timer.unref();
    this.sweepTimer = timer;
  }

  /** Remove idle buckets whose lastActivity is older than the TTL (§7.4). */
  sweepIdleBuckets(now = Date.now()): void {
    for (const [name, b] of this.buckets) {
      if (b.isIdle && now - b.lastActivity >= this.bucketTtlMs) {
        this.buckets.delete(name);
      }
    }
  }

  /** Predicate exposed for deterministic testing of TTL eligibility. */
  isBucketExpirable(bucket: Bucket, now = Date.now()): boolean {
    return bucket.isIdle && now - bucket.lastActivity >= this.bucketTtlMs;
  }

  /** Stop the TTL sweep timer (daemon shutdown calls this). */
  stop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Get an existing bucket, or create one. Creating a NEW bucket beyond
   * max_buckets throws BusError("max_buckets").
   */
  getBucket(name: string): Bucket {
    const existing = this.buckets.get(name);
    if (existing) return existing;
    if (this.buckets.size >= this.maxBuckets) {
      throw new BusError("max_buckets", `bucket limit reached (max ${this.maxBuckets})`);
    }
    const bucket = new Bucket(name, this.bufferSize);
    this.buckets.set(name, bucket);
    return bucket;
  }

  private assertPayloadSize(payload: string): void {
    const bytes = utf8ByteLength(payload);
    if (bytes > this.maxPayloadBytes) {
      throw new BusError(
        "max_payload_bytes",
        `payload too large (${bytes} > ${this.maxPayloadBytes} bytes)`,
      );
    }
  }

  emit(bucket: string, event: string, data: string): void {
    this.assertPayloadSize(data);
    this.getBucket(bucket).emit(event, data);
  }

  set(bucket: string, key: string, value: string): void {
    this.assertPayloadSize(value);
    this.getBucket(bucket).set(key, value, this.watchOnEqual);
  }

  get(bucket: string, key: string): string | undefined {
    // Read-only lookup: never create a bucket just to miss.
    return this.buckets.get(bucket)?.get(key);
  }

  // note: max_subscriptions_per_client is per-CLIENT and enforced by the
  // protocol/daemon layer, not here.

  stats(): BusStats {
    let keys = 0;
    let subscriptions = 0;
    for (const b of this.buckets.values()) {
      keys += b.state.size;
      subscriptions += b.subscriptionCount;
    }
    return {
      buckets: this.buckets.size,
      subscriptions,
      keys,
      uptime_seconds: Math.floor((Date.now() - this.createdAt) / 1000),
    };
  }

  bucketNames(): string[] {
    return [...this.buckets.keys()];
  }
}
