/**
 * nbus optional end-to-end crypto layer (CRYPTO.md v0.1, FROZEN spec).
 *
 * Self-contained, zero-dependency (`node:crypto` only) implementation of the
 * signed (`s1`) and encrypted (`e1`) envelope formats plus RFC 8785 (JCS)
 * canonical JSON. Pure functions + Keypair types; wiring into the SDK lives
 * elsewhere. Everything here fails closed: wire-supplied input never throws,
 * it returns a `{ ok: false, reason }` result.
 */

import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign as edSign,
  verify as edVerify,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type KeyObject,
} from "node:crypto";

// ---------------------------------------------------------------------------
// JSON value model (strict, no `any`)
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

export interface SignedEnvelope {
  $nbus: "s1";
  alg: "ed25519";
  pub: string;
  ts: number;
  payload: JsonValue;
  sig: string;
}

export interface EncryptedEnvelope {
  $nbus: "e1";
  alg: "x25519-hkdf-sha256-aes256gcm";
  epk: string;
  iv: string;
  ct: string;
  aad?: string;
}

export type Envelope = SignedEnvelope | EncryptedEnvelope;

// ---------------------------------------------------------------------------
// Result unions
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { ok: true; pub: string; payload: JsonValue }
  | { ok: false; reason: string };

export type DecryptResult =
  | { ok: true; payload: JsonValue }
  | { ok: false; reason: string };

export type OpenResult =
  | { ok: true; pub: string; payload: JsonValue }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// base64url (RFC 4648 §5, no padding)
// ---------------------------------------------------------------------------

/** Encode bytes to base64url without padding. */
export function b64uEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64url",
  );
}

/**
 * Decode base64url (padding optional) to bytes. Buffer.from with "base64url"
 * accepts and ignores padding; it does not throw on malformed input, so
 * callers that need strict validation compare a round-trip.
 */
export function b64uDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

// ---------------------------------------------------------------------------
// RFC 8785 (JCS) canonical JSON
// ---------------------------------------------------------------------------

/**
 * Serialize a JsonValue to RFC 8785 canonical form: compact UTF-8, object keys
 * sorted by UTF-16 code unit, arrays in order, ECMAScript number form. Throws
 * on non-finite numbers (NaN/Infinity have no JCS representation).
 */
export function canonicalize(value: JsonValue): string {
  if (value === null) return "null";

  const t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new Error("canonicalize: non-finite number is not valid JSON");
    }
    // ECMAScript Number->String is the JCS number form for finite numbers.
    // Normalizes -0 to "0" (String(-0) === "0").
    return String(n);
  }

  if (t === "string") return canonicalizeString(value as string);

  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ",";
      out += canonicalize(value[i] as JsonValue);
    }
    return out + "]";
  }

  // object
  const obj = value as { [k: string]: JsonValue };
  const keys = Object.keys(obj).sort(compareUtf16);
  let out = "{";
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i] as string;
    if (i > 0) out += ",";
    out += canonicalizeString(k) + ":" + canonicalize(obj[k] as JsonValue);
  }
  return out + "}";
}

/** Sort comparator by UTF-16 code unit (JCS key ordering). */
function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * JSON string escaping per RFC 8785 §3.2.2.2: shortest form. Control chars
 * < 0x20 use the two-char shortcut where defined (\b \t \n \f \r), else \u00xx.
 * Only " and \ are additionally escaped. All other code points emit literally
 * (JCS is UTF-8; JS strings hold UTF-16 which serialize to valid UTF-8).
 */
function canonicalizeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      default:
        if (c < 0x20) {
          out += "\\u" + c.toString(16).padStart(4, "0");
        } else {
          out += s[i];
        }
    }
  }
  return out + '"';
}

// ---------------------------------------------------------------------------
// Raw <-> KeyObject helpers (DER-wrapped so no library needed)
// ---------------------------------------------------------------------------

// RFC 8410 ASN.1 prefixes for 32-byte raw Curve25519 keys.
const ED_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const X_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function edPrivFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  return createPrivateKey({
    key: Buffer.concat([ED_PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
}

function edPubFromRaw(pub: Uint8Array): KeyObject {
  if (pub.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return createPublicKey({
    key: Buffer.concat([ED_SPKI_PREFIX, Buffer.from(pub)]),
    format: "der",
    type: "spki",
  });
}

function xPrivFromRaw(priv: Uint8Array): KeyObject {
  if (priv.length !== 32) throw new Error("x25519 private key must be 32 bytes");
  return createPrivateKey({
    key: Buffer.concat([X_PKCS8_PREFIX, Buffer.from(priv)]),
    format: "der",
    type: "pkcs8",
  });
}

function xPubFromRaw(pub: Uint8Array): KeyObject {
  if (pub.length !== 32) throw new Error("x25519 public key must be 32 bytes");
  return createPublicKey({
    key: Buffer.concat([X_SPKI_PREFIX, Buffer.from(pub)]),
    format: "der",
    type: "spki",
  });
}

/** Extract the raw 32-byte key material (the JWK `x`/`d` component). */
function rawFromKey(key: KeyObject, component: "x" | "d"): Uint8Array {
  const jwk = key.export({ format: "jwk" }) as { x?: string; d?: string };
  const v = jwk[component];
  if (typeof v !== "string") throw new Error("key missing JWK component");
  return new Uint8Array(Buffer.from(v, "base64url"));
}

// ---------------------------------------------------------------------------
// Keypair types
// ---------------------------------------------------------------------------

/**
 * ed25519 signing keypair. `publicKeyB64` is the base64url raw 32-byte public
 * key (the wire identity). Private material is held as a node KeyObject.
 */
export class Ed25519Keypair {
  readonly publicKeyB64: string;
  /** @internal */
  readonly privateKey: KeyObject;
  /** @internal */
  readonly publicKey: KeyObject;

  private constructor(priv: KeyObject, pub: KeyObject) {
    this.privateKey = priv;
    this.publicKey = pub;
    this.publicKeyB64 = b64uEncode(rawFromKey(pub, "x"));
  }

  /** @internal Build from a private KeyObject (derives the public key). */
  static _fromPrivate(priv: KeyObject): Ed25519Keypair {
    return new Ed25519Keypair(priv, edPubFromRaw(rawFromKey(priv, "x")));
  }

  /** Raw 32-byte public key. */
  publicKeyBytes(): Uint8Array {
    return rawFromKey(this.publicKey, "x");
  }

  /** Raw 32-byte private seed as base64url (for storage; guard it). */
  exportPrivateB64(): string {
    return b64uEncode(rawFromKey(this.privateKey, "d"));
  }
}

/**
 * X25519 encryption keypair (the "box" key). `publicKeyB64` is base64url raw
 * 32-byte public key, published to `_keys` as `box`.
 */
export class X25519Keypair {
  readonly publicKeyB64: string;
  /** @internal */
  readonly privateKey: KeyObject;
  /** @internal */
  readonly publicKey: KeyObject;

  private constructor(priv: KeyObject, pub: KeyObject) {
    this.privateKey = priv;
    this.publicKey = pub;
    this.publicKeyB64 = b64uEncode(rawFromKey(pub, "x"));
  }

  /** @internal Build from a private KeyObject (derives the public key). */
  static _fromPrivate(priv: KeyObject): X25519Keypair {
    return new X25519Keypair(priv, xPubFromRaw(rawFromKey(priv, "x")));
  }

  /** Raw 32-byte public key. */
  publicKeyBytes(): Uint8Array {
    return rawFromKey(this.publicKey, "x");
  }

  /** Raw 32-byte private key as base64url (for storage; guard it). */
  exportPrivateB64(): string {
    return b64uEncode(rawFromKey(this.privateKey, "d"));
  }
}

/** Factory namespace mirroring the CRYPTO.md `Keypair.ed25519()` shape. */
export const Keypair = {
  /** Generate a fresh ed25519 signing keypair. */
  ed25519(): Promise<Ed25519Keypair> {
    const { privateKey } = generateKeyPairSync("ed25519");
    return Promise.resolve(Ed25519Keypair._fromPrivate(privateKey));
  },

  /** Generate a fresh X25519 encryption keypair. */
  x25519(): Promise<X25519Keypair> {
    const { privateKey } = generateKeyPairSync("x25519");
    return Promise.resolve(X25519Keypair._fromPrivate(privateKey));
  },

  /** Deterministic ed25519 keypair from a fixed 32-byte seed (test vectors). */
  ed25519FromSeed(seed: Uint8Array): Ed25519Keypair {
    return Ed25519Keypair._fromPrivate(edPrivFromSeed(seed));
  },

  /** Deterministic X25519 keypair from a fixed 32-byte private key. */
  x25519FromRaw(priv: Uint8Array): X25519Keypair {
    return X25519Keypair._fromPrivate(xPrivFromRaw(priv));
  },

  /** Import an ed25519 keypair from a base64url private seed. */
  ed25519FromSeedB64(seedB64: string): Ed25519Keypair {
    return Ed25519Keypair._fromPrivate(edPrivFromSeed(b64uDecode(seedB64)));
  },

  /** Import an X25519 keypair from a base64url private key. */
  x25519FromRawB64(privB64: string): X25519Keypair {
    return X25519Keypair._fromPrivate(xPrivFromRaw(b64uDecode(privB64)));
  },
} as const;

// ---------------------------------------------------------------------------
// Signing (s1)
// ---------------------------------------------------------------------------

/** Fixed-order frame used as the ed25519 signing input (before `sig`). */
function signingBytes(
  pub: string,
  ts: number,
  payload: JsonValue,
): Buffer {
  const frame: JsonValue = {
    $nbus: "s1",
    alg: "ed25519",
    pub,
    ts,
    payload,
  };
  // The frame's own keys are alphabetically ordered by JCS ($nbus, alg, payload,
  // pub, ts). CRYPTO.md §8.3 makes JCS authoritative; canonicalize() yields the
  // reproducible cross-language bytes, so we canonicalize the whole frame.
  return Buffer.from(canonicalize(frame), "utf8");
}

/**
 * Build an `s1` signed envelope over `payload`. `ts` defaults to the current
 * unix time in seconds; injectable for deterministic tests.
 */
export function sign(
  payload: JsonValue,
  signer: Ed25519Keypair,
  ts: number = Math.floor(Date.now() / 1000),
): SignedEnvelope {
  const pub = signer.publicKeyB64;
  const sig = edSign(null, signingBytes(pub, ts, payload), signer.privateKey);
  return {
    $nbus: "s1",
    alg: "ed25519",
    pub,
    ts,
    payload,
    sig: b64uEncode(new Uint8Array(sig)),
  };
}

/**
 * Verify an `s1` envelope. Fail-closed: any structural problem, bad signature,
 * or out-of-skew `ts` yields `{ ok: false, reason }`. `maxSkewSeconds` default
 * 300; pass 0 or Infinity to disable the freshness check.
 */
export function verifySigned(
  env: SignedEnvelope,
  opts?: { maxSkewSeconds?: number; now?: number },
): VerifyResult {
  try {
    if (!env || env.$nbus !== "s1" || env.alg !== "ed25519") {
      return { ok: false, reason: "not an s1 envelope" };
    }
    if (typeof env.pub !== "string" || typeof env.sig !== "string") {
      return { ok: false, reason: "malformed pub/sig" };
    }
    if (typeof env.ts !== "number" || !Number.isFinite(env.ts)) {
      return { ok: false, reason: "malformed ts" };
    }

    const skew = opts?.maxSkewSeconds ?? 300;
    if (skew !== 0 && skew !== Infinity) {
      const now = opts?.now ?? Math.floor(Date.now() / 1000);
      if (Math.abs(now - env.ts) > skew) {
        return { ok: false, reason: "ts outside skew window" };
      }
    }

    const pubRaw = b64uDecode(env.pub);
    if (pubRaw.length !== 32) return { ok: false, reason: "bad public key length" };
    const sigRaw = b64uDecode(env.sig);
    if (sigRaw.length !== 64) return { ok: false, reason: "bad signature length" };

    const pubKey = edPubFromRaw(pubRaw);
    const msg = signingBytes(env.pub, env.ts, env.payload);
    const ok = edVerify(null, msg, pubKey, sigRaw);
    if (!ok) return { ok: false, reason: "signature verification failed" };

    return { ok: true, pub: env.pub, payload: env.payload };
  } catch (e) {
    return { ok: false, reason: reasonOf(e) };
  }
}

// ---------------------------------------------------------------------------
// Encryption (e1)
// ---------------------------------------------------------------------------

const E1_ALG = "x25519-hkdf-sha256-aes256gcm" as const;
const HKDF_INFO = Buffer.from("nbus-e1", "utf8");

/** Derive the AES-256 key from a shared secret and the ephemeral public key. */
function deriveKey(shared: Uint8Array, epk: Uint8Array): Buffer {
  const salt = Buffer.from(epk);
  const key = hkdfSync("sha256", shared, salt, HKDF_INFO, 32);
  return Buffer.from(key);
}

/**
 * Build an `e1` envelope encrypting `payload` to a recipient X25519 public key
 * (base64url raw). Uses a fresh ephemeral keypair, ECDH, HKDF-SHA256, and
 * AES-256-GCM. Optional `aad` is authenticated (not encrypted) and stored
 * base64url in the envelope.
 */
export function encryptTo(
  payload: JsonValue,
  recipientPubB64: string,
  aad?: Uint8Array,
): EncryptedEnvelope {
  const recipRaw = b64uDecode(recipientPubB64);
  if (recipRaw.length !== 32) throw new Error("recipient public key must be 32 bytes");
  const recipientPub = xPubFromRaw(recipRaw);

  const { privateKey: ephPriv, publicKey: ephPub } = generateKeyPairSync("x25519");
  const epk = rawFromKey(ephPub, "x");
  const shared = new Uint8Array(
    diffieHellman({ privateKey: ephPriv, publicKey: recipientPub }),
  );
  const key = deriveKey(shared, epk);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const pt = Buffer.from(canonicalize(payload), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();

  const env: EncryptedEnvelope = {
    $nbus: "e1",
    alg: E1_ALG,
    epk: b64uEncode(epk),
    iv: b64uEncode(new Uint8Array(iv)),
    ct: b64uEncode(new Uint8Array(Buffer.concat([ct, tag]))),
  };
  if (aad) env.aad = b64uEncode(aad);
  return env;
}

/**
 * Decrypt an `e1` envelope with the recipient keypair. Fail-closed: a bad tag,
 * malformed field, or JSON parse error yields `{ ok: false, reason }`.
 */
export function decrypt(
  env: EncryptedEnvelope,
  recipient: X25519Keypair,
): DecryptResult {
  try {
    if (!env || env.$nbus !== "e1" || env.alg !== E1_ALG) {
      return { ok: false, reason: "not an e1 envelope" };
    }
    if (
      typeof env.epk !== "string" ||
      typeof env.iv !== "string" ||
      typeof env.ct !== "string"
    ) {
      return { ok: false, reason: "malformed e1 fields" };
    }

    const epk = b64uDecode(env.epk);
    if (epk.length !== 32) return { ok: false, reason: "bad epk length" };
    const iv = b64uDecode(env.iv);
    if (iv.length !== 12) return { ok: false, reason: "bad iv length" };
    const ctTag = b64uDecode(env.ct);
    if (ctTag.length < 16) return { ok: false, reason: "ciphertext too short" };

    const ephPub = xPubFromRaw(epk);
    const shared = new Uint8Array(
      diffieHellman({ privateKey: recipient.privateKey, publicKey: ephPub }),
    );
    const key = deriveKey(shared, epk);

    const tag = ctTag.subarray(ctTag.length - 16);
    const ct = ctTag.subarray(0, ctTag.length - 16);

    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv));
    if (typeof env.aad === "string") {
      decipher.setAAD(Buffer.from(b64uDecode(env.aad)));
    }
    decipher.setAuthTag(Buffer.from(tag));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ct)),
      decipher.final(),
    ]);

    const payload = JSON.parse(pt.toString("utf8")) as JsonValue;
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, reason: reasonOf(e) };
  }
}

// ---------------------------------------------------------------------------
// Sign-then-encrypt (§3.3)
// ---------------------------------------------------------------------------

/**
 * Build an `s1` over `payload`, then wrap the whole `s1` object as the
 * plaintext of an `e1` to `recipientPubB64`. The signature stays confidential
 * to the recipient and is bound to the encrypted content.
 */
export function sealSignedEncrypted(
  payload: JsonValue,
  signer: Ed25519Keypair,
  recipientPubB64: string,
  ts?: number,
  aad?: Uint8Array,
): EncryptedEnvelope {
  const inner = sign(payload, signer, ts);
  // SignedEnvelope is a concrete JsonValue-shaped object.
  return encryptTo(inner as unknown as JsonValue, recipientPubB64, aad);
}

/**
 * Open a sign-then-encrypt envelope: decrypt the outer `e1`, then verify the
 * inner `s1`. Fail-closed at both stages. On success exposes both the signer
 * `pub` and the verified `payload`.
 */
export function openSignedEncrypted(
  env: EncryptedEnvelope,
  recipient: X25519Keypair,
  verifyOpts?: { maxSkewSeconds?: number; now?: number },
): OpenResult {
  const dec = decrypt(env, recipient);
  if (!dec.ok) return { ok: false, reason: `decrypt: ${dec.reason}` };

  if (envelopeKind(dec.payload) !== "s1") {
    return { ok: false, reason: "decrypted payload is not an s1 envelope" };
  }
  const inner = dec.payload as unknown as SignedEnvelope;
  const ver = verifySigned(inner, verifyOpts);
  if (!ver.ok) return { ok: false, reason: `verify: ${ver.reason}` };

  return { ok: true, pub: ver.pub, payload: ver.payload };
}

// ---------------------------------------------------------------------------
// Discriminator helpers
// ---------------------------------------------------------------------------

/** Return the envelope kind, or null for plain / non-envelope values. */
export function envelopeKind(v: unknown): "s1" | "e1" | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const tag = (v as { $nbus?: unknown }).$nbus;
  return tag === "s1" ? "s1" : tag === "e1" ? "e1" : null;
}

/** Type guard: is `v` a signed or encrypted envelope (by discriminator)? */
export function isEnvelope(v: unknown): v is SignedEnvelope | EncryptedEnvelope {
  return envelopeKind(v) !== null;
}

// ---------------------------------------------------------------------------
// internal
// ---------------------------------------------------------------------------

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
