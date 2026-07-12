import { connect, type Socket } from "bun";
import {
  sign,
  verifySigned,
  encryptTo,
  decrypt,
  sealSignedEncrypted,
  isEnvelope,
  envelopeKind,
  Keypair,
  type JsonValue,
  type SignedEnvelope,
  type EncryptedEnvelope,
  type Ed25519Keypair,
  type X25519Keypair,
} from "./crypto";

// Re-export the crypto surface so SDK users get everything from one import.
export {
  Keypair,
  isEnvelope,
  envelopeKind,
  type JsonValue,
  type SignedEnvelope,
  type EncryptedEnvelope,
  type Ed25519Keypair,
  type X25519Keypair,
};

export interface NBusOptions {
  socket?: string;
}

/**
 * A published public-key record living in the `_keys` bucket (CRYPTO.md §5).
 * At least one of `sign` (ed25519) / `box` (x25519) is present, both base64url
 * raw public keys; `ts` is the unix-seconds publish time (for rotation).
 *
 * TOFU convention. A record here asserts NOTHING about who owns the keys —
 * verify fingerprints out-of-band. The daemon does not protect `_keys`.
 */
export interface KeyRecord {
  /** base64url ed25519 signing public key. */
  sign?: string;
  /** base64url x25519 encryption ("box") public key. */
  box?: string;
  /** unix seconds at publish time. */
  ts: number;
}

/**
 * Crypto options for outbound messages (emit/set). Absent → plain payload,
 * byte-for-byte identical to the pre-crypto behavior. Presence of any field
 * wraps the payload in the corresponding envelope BEFORE it hits the wire.
 *
 * - `sign` only        → `s1` signed envelope
 * - `encryptTo` only   → `e1` encrypted envelope
 * - both               → sign-then-encrypt (`e1` wrapping an inner `s1`)
 */
export interface SendCryptoOptions {
  /** ed25519 signer → produce an `s1` envelope. */
  sign?: Ed25519Keypair;
  /** recipient x25519 public key (base64url) → produce an `e1` envelope. */
  encryptTo?: string;
}

/**
 * Crypto options for inbound messages (listen/get/watch). Absent → the SDK does
 * NOT interpret envelopes; a payload is delivered verbatim as `data` (opt-out,
 * fully backward compatible). Presence enables fail-closed handling: envelopes
 * are verified/decrypted and, on any failure or missing capability, the item is
 * surfaced as a reject (`error` set, `data` undefined) rather than trusted data.
 */
export interface RecvCryptoOptions {
  /**
   * Trust predicate for signed (`s1`) payloads. REQUIRED to accept a signed
   * envelope: an `s1` arriving with no predicate is a trust decision the caller
   * never made and is rejected. Receives the verified signer `pub` and the full
   * envelope; return `true` to accept.
   */
  verify?: (pub: string, env: SignedEnvelope) => boolean;
  /** x25519 keypair used to open `e1` envelopes. */
  decryptWith?: X25519Keypair;
  /** Signature freshness window in seconds (default 300). */
  maxSkewSeconds?: number;
}

/**
 * A delivered listen/watch item. Backward compatible: with no `RecvCryptoOptions`
 * the shape is exactly `{ bucket, event, data }` as before. Crypto metadata is
 * optional and only populated when recv options are supplied:
 * - `signedBy`  — verified ed25519 signer pub (base64url) for accepted `s1`.
 * - `encrypted` — true when the item arrived inside an `e1` envelope.
 * - `error`     — set on a fail-closed reject; `data` is then `undefined`.
 * - `raw`       — the offending envelope on a reject, for inspection.
 */
export interface ListenItem<T = unknown> {
  bucket: string;
  event: string;
  data?: T;
  signedBy?: string;
  encrypted?: boolean;
  error?: string;
  raw?: SignedEnvelope | EncryptedEnvelope;
}

/** A delivered watch item (same crypto metadata as {@link ListenItem}). */
export interface WatchItem<T = unknown> {
  data?: T;
  signedBy?: string;
  encrypted?: boolean;
  error?: string;
  raw?: SignedEnvelope | EncryptedEnvelope;
}

/** A resolved get result carrying crypto metadata (only when recv opts given). */
export interface GetResult<T = unknown> {
  data: T | null;
  signedBy?: string;
  encrypted?: boolean;
  error?: string;
  raw?: SignedEnvelope | EncryptedEnvelope;
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

/** Reserved bucket for the (pure-convention) key-discovery layer, CRYPTO.md §5. */
const KEYS_BUCKET = "_keys";

// ---------------------------------------------------------------------------
// Key-discovery convention helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Extract a base64url public key from either a Keypair or a raw string.
 * `undefined` passes through (an absent half of a record).
 */
function pubOf(
  k: Ed25519Keypair | X25519Keypair | string | undefined,
): string | undefined {
  if (k === undefined) return undefined;
  if (typeof k === "string") return k;
  return k.publicKeyB64;
}

/**
 * Validate an unknown GET/WATCH value as a {@link KeyRecord}. Returns the typed
 * record on success or `null` if the shape is not a valid key record. This is a
 * shape check, NOT a trust check — a valid record asserts nothing about owner.
 */
function parseKeyRecord(v: unknown): KeyRecord | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as { sign?: unknown; box?: unknown; ts?: unknown };
  if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return null;
  const hasSign = typeof o.sign === "string";
  const hasBox = typeof o.box === "string";
  if (o.sign !== undefined && !hasSign) return null;
  if (o.box !== undefined && !hasBox) return null;
  if (!hasSign && !hasBox) return null;
  const rec: KeyRecord = { ts: o.ts };
  if (hasSign) rec.sign = o.sign as string;
  if (hasBox) rec.box = o.box as string;
  return rec;
}

// ---------------------------------------------------------------------------
// Crypto helpers (pure, shared by instance + one-shot APIs)
// ---------------------------------------------------------------------------

/**
 * Apply outbound crypto options to a payload, returning the wire value to send.
 * With no options the input is returned unchanged (plain path, byte-for-byte).
 */
function applySendCrypto(data: unknown, opts?: SendCryptoOptions): unknown {
  if (!opts || (!opts.sign && !opts.encryptTo)) return data;
  const payload = data as JsonValue;
  if (opts.sign && opts.encryptTo) {
    return sealSignedEncrypted(payload, opts.sign, opts.encryptTo);
  }
  if (opts.sign) return sign(payload, opts.sign);
  // encryptTo only (guaranteed by the guard above).
  return encryptTo(payload, opts.encryptTo as string);
}

/**
 * Resolve an inbound wire value under recv crypto options into cleartext data
 * plus metadata, fail-closed. Returns an object with either `data` (accepted) or
 * `error` (rejected). With no options the value passes through as `data`.
 */
function resolveRecvCrypto<T>(
  value: unknown,
  opts?: RecvCryptoOptions,
): {
  data?: T;
  signedBy?: string;
  encrypted?: boolean;
  error?: string;
  raw?: SignedEnvelope | EncryptedEnvelope;
} {
  // Opt-out: no recv crypto → deliver verbatim (back-compat).
  if (!opts) return { data: value as T };

  const kind = envelopeKind(value);
  if (kind === null) {
    // Plain payload, even under recv opts → deliver as-is.
    return { data: value as T };
  }

  const skew = opts.maxSkewSeconds;

  if (kind === "s1") {
    const env = value as SignedEnvelope;
    if (!opts.verify) {
      return { error: "signed payload but no verify predicate", raw: env };
    }
    const ver = verifySigned(env, skew === undefined ? undefined : { maxSkewSeconds: skew });
    if (!ver.ok) return { error: `verify: ${ver.reason}`, raw: env };
    if (!opts.verify(ver.pub, env)) {
      return { error: "verify predicate rejected signer", raw: env };
    }
    return { data: ver.payload as T, signedBy: ver.pub };
  }

  // kind === "e1"
  const env = value as EncryptedEnvelope;
  if (!opts.decryptWith) {
    return { error: "encrypted payload but no decryptWith key", raw: env };
  }
  const dec = decrypt(env, opts.decryptWith);
  if (!dec.ok) return { error: `decrypt: ${dec.reason}`, raw: env };

  // If the decrypted content is itself an s1 envelope, this was sign-then-encrypt:
  // verify the inner signature too (still fail-closed).
  if (envelopeKind(dec.payload) === "s1") {
    const inner = dec.payload as unknown as SignedEnvelope;
    if (!opts.verify) {
      return { error: "sealed signed payload but no verify predicate", encrypted: true, raw: env };
    }
    const ver = verifySigned(inner, skew === undefined ? undefined : { maxSkewSeconds: skew });
    if (!ver.ok) return { error: `verify: ${ver.reason}`, encrypted: true, raw: env };
    if (!opts.verify(ver.pub, inner)) {
      return { error: "verify predicate rejected signer", encrypted: true, raw: env };
    }
    return { data: ver.payload as T, signedBy: ver.pub, encrypted: true };
  }

  return { data: dec.payload as T, encrypted: true };
}

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

  async emit(
    bucket: string,
    event: string,
    data?: unknown,
    opts?: SendCryptoOptions,
  ): Promise<void> {
    const sock = await this.ensureConnected();
    const wire = applySendCrypto(data, opts);
    const payload = wire !== undefined ? JSON.stringify(wire) : "null";
    sock.write(`EMIT ${bucket} ${event} ${payload}\n`);
  }

  async set(
    bucket: string,
    key: string,
    value: unknown,
    opts?: SendCryptoOptions,
  ): Promise<void> {
    const sock = await this.ensureConnected();
    const wire = applySendCrypto(value, opts);
    sock.write(`SET ${bucket} ${key} ${JSON.stringify(wire)}\n`);
    const resp = await this.readLine();
    if (resp.trim() !== "OK") throw new Error(`SET failed: ${resp}`);
  }

  async get<T = unknown>(
    bucket: string,
    key: string,
  ): Promise<T | null>;
  async get<T = unknown>(
    bucket: string,
    key: string,
    opts: RecvCryptoOptions,
  ): Promise<GetResult<T>>;
  async get<T = unknown>(
    bucket: string,
    key: string,
    opts?: RecvCryptoOptions,
  ): Promise<T | null | GetResult<T>> {
    const sock = await this.ensureConnected();
    sock.write(`GET ${bucket} ${key}\n`);
    const resp = await this.readLine();

    let raw: T | null;
    if (resp === "NIL") raw = null;
    else if (resp.startsWith("VALUE ")) raw = JSON.parse(resp.slice(6)) as T;
    else throw new Error(`GET failed: ${resp}`);

    // Back-compat: no recv opts → return the bare value exactly as before.
    if (!opts) return raw;

    if (raw === null) return { data: null };
    const r = resolveRecvCrypto<T>(raw, opts);
    const out: GetResult<T> = { data: r.data ?? null };
    if (r.signedBy !== undefined) out.signedBy = r.signedBy;
    if (r.encrypted !== undefined) out.encrypted = r.encrypted;
    if (r.error !== undefined) out.error = r.error;
    if (r.raw !== undefined) out.raw = r.raw;
    return out;
  }

  async *listen<T = unknown>(
    bucket: string,
    event = "*",
    opts?: RecvCryptoOptions,
  ): AsyncGenerator<ListenItem<T>> {
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
            const evBucket = rest.slice(0, sp1);
            const evEvent = rest.slice(sp1 + 1, sp2);
            const value = JSON.parse(rest.slice(sp2 + 1)) as unknown;

            // Back-compat: no recv opts → yield the raw value as `data`.
            if (!opts) {
              yield { bucket: evBucket, event: evEvent, data: value as T };
              continue;
            }

            const r = resolveRecvCrypto<T>(value, opts);
            const item: ListenItem<T> = { bucket: evBucket, event: evEvent };
            if (r.data !== undefined) item.data = r.data;
            if (r.signedBy !== undefined) item.signedBy = r.signedBy;
            if (r.encrypted !== undefined) item.encrypted = r.encrypted;
            if (r.error !== undefined) item.error = r.error;
            if (r.raw !== undefined) item.raw = r.raw;
            yield item;
          }
        }
      }
    } finally {
      this.activeSubs.delete(sub);
    }
  }

  watch<T = unknown>(bucket: string, key: string): AsyncGenerator<T>;
  watch<T = unknown>(
    bucket: string,
    key: string,
    opts: RecvCryptoOptions,
  ): AsyncGenerator<WatchItem<T>>;
  async *watch<T = unknown>(
    bucket: string,
    key: string,
    opts?: RecvCryptoOptions,
  ): AsyncGenerator<T | WatchItem<T>> {
    const sub: WatchSub = { kind: "watch", bucket, key };
    this.activeSubs.add(sub);
    try {
      const sock = await this.ensureConnected();
      sock.write(`WATCH ${bucket} ${key}\n`);

      while (!this.closed) {
        const line = await this.readLine();
        if (line.startsWith("VALUE ")) {
          const value = JSON.parse(line.slice(6)) as unknown;

          // Back-compat: no recv opts → yield the raw value directly.
          if (!opts) {
            yield value as T;
            continue;
          }

          const r = resolveRecvCrypto<T>(value, opts);
          const item: WatchItem<T> = {};
          if (r.data !== undefined) item.data = r.data;
          if (r.signedBy !== undefined) item.signedBy = r.signedBy;
          if (r.encrypted !== undefined) item.encrypted = r.encrypted;
          if (r.error !== undefined) item.error = r.error;
          if (r.raw !== undefined) item.raw = r.raw;
          yield item;
        }
      }
    } finally {
      this.activeSubs.delete(sub);
    }
  }

  // ---------------------------------------------------------------------------
  // Key discovery (CRYPTO.md §5 — PURE CONVENTION over ordinary bus state)
  //
  // These helpers do nothing the daemon knows about: they are plain
  // SET/GET/WATCH against the `_keys` bucket. The daemon does NOT reserve or
  // special-case `_keys` — anyone can overwrite any name.
  //
  // ⚠ TOFU (trust on first use). Publishing a key here asserts NOTHING about
  // identity or ownership. Verify fingerprints OUT-OF-BAND. This is a discovery
  // convenience, not a PKI and not a trust boundary.
  // ---------------------------------------------------------------------------

  /**
   * Publish this identity's public keys under `name` in the `_keys` bucket
   * (`SET _keys <name> <record>`). Accepts Keypair objects (public key is
   * extracted) or raw base64url public-key strings. Stamps `ts = now`. At least
   * one of `sign` / `box` must be supplied.
   *
   * ⚠ TOFU convention. Publishing here asserts NOTHING — anyone can overwrite
   * `_keys/<name>`; the daemon does not protect it. Verify fingerprints
   * out-of-band before trusting a discovered key.
   */
  async publishKeys(
    name: string,
    keys: { sign?: Ed25519Keypair | string; box?: X25519Keypair | string },
  ): Promise<void> {
    const signPub = pubOf(keys.sign);
    const boxPub = pubOf(keys.box);
    if (signPub === undefined && boxPub === undefined) {
      throw new Error("publishKeys: at least one of sign/box is required");
    }
    const record: KeyRecord = { ts: Math.floor(Date.now() / 1000) };
    if (signPub !== undefined) record.sign = signPub;
    if (boxPub !== undefined) record.box = boxPub;
    await this.set(KEYS_BUCKET, name, record);
  }

  /**
   * Fetch a published key record for `name` (`GET _keys <name>`). Returns `null`
   * if the name is unset. Throws on a structurally malformed record — that is
   * data corruption (or a hostile overwrite), not a miss, and must be visible.
   *
   * ⚠ TOFU convention. A returned record asserts NOTHING about who owns the
   * keys. Verify fingerprints out-of-band; the daemon does not protect `_keys`.
   */
  async fetchKeys(name: string): Promise<KeyRecord | null> {
    const raw = await this.get<unknown>(KEYS_BUCKET, name);
    if (raw === null) return null;
    const rec = parseKeyRecord(raw);
    if (rec === null) {
      throw new Error(`fetchKeys: malformed key record for "${name}"`);
    }
    return rec;
  }

  /**
   * Watch a key record for `name` (`WATCH _keys <name>`), yielding each valid
   * record on change — the mechanism for observing key rotation. Malformed
   * records are SKIPPED silently (no yield): surfacing corruption as a thrown
   * error inside a long-lived generator would tear down the watch, so invalid
   * updates are simply ignored until a valid record is written.
   *
   * ⚠ TOFU convention. A yielded record asserts NOTHING about ownership. Verify
   * fingerprints out-of-band; the daemon does not protect `_keys`.
   */
  async *watchKeys(name: string): AsyncGenerator<KeyRecord> {
    for await (const value of this.watch<unknown>(KEYS_BUCKET, name)) {
      const rec = parseKeyRecord(value);
      if (rec !== null) yield rec;
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
  data?: unknown,
  opts?: SendCryptoOptions,
): Promise<void> {
  const bus = new NBus();
  await bus.emit(bucket, event, data, opts);
  bus.close();
}

export async function set(
  bucket: string,
  key: string,
  value: unknown,
  opts?: SendCryptoOptions,
): Promise<void> {
  const bus = new NBus();
  await bus.set(bucket, key, value, opts);
  bus.close();
}

export async function get<T = unknown>(
  bucket: string,
  key: string,
): Promise<T | null>;
export async function get<T = unknown>(
  bucket: string,
  key: string,
  opts: RecvCryptoOptions,
): Promise<GetResult<T>>;
export async function get<T = unknown>(
  bucket: string,
  key: string,
  opts?: RecvCryptoOptions,
): Promise<T | null | GetResult<T>> {
  const bus = new NBus();
  const val = opts
    ? await bus.get<T>(bucket, key, opts)
    : await bus.get<T>(bucket, key);
  bus.close();
  return val;
}
