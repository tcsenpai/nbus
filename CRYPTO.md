# nbus — Crypto Envelope Specification (v0.1)

> **Status: v0.1 — implemented.** This document defines an OPTIONAL,
> protocol-level envelope for signed and/or encrypted nbus payloads. Enveloping
> is always a client choice, per message; a daemon and a plain client that never
> opt in are completely unaffected. The open questions in §8 are resolved (see §8
> for the decisions).
>
> **Implementation:** core primitives in [`src/crypto.ts`](src/crypto.ts)
> (JCS, `s1`/`e1`, sign-then-encrypt, keypairs; zero deps beyond `node:crypto`);
> SDK options + `_keys` helpers in [`src/client.ts`](src/client.ts); conformance
> vectors in [`tests/crypto-vectors.json`](tests/crypto-vectors.json) (schema:
> [`tests/crypto-vectors.schema.md`](tests/crypto-vectors.schema.md)).

---

## 1. Design principles (non-negotiable)

1. **The daemon stays dumb.** nbus is a broadcast relay. It does NOT hold keys,
   verify signatures, or decrypt anything. Crypto is **end-to-end between
   clients**. The daemon relays the envelope as an opaque JSON payload, exactly
   like any other payload. **Zero daemon changes.**
2. **Optional and interoperable.** A plain payload and an enveloped payload MUST
   coexist on the same bucket/key. Enveloping is a client choice, per message.
3. **Zero new dependencies.** All primitives come from Bun's WebCrypto
   (`crypto.subtle`) / `node:crypto`. No libsodium, no npm crypto libs. The
   shipped implementation uses `node:crypto` only.
4. **One obvious way.** ed25519 for signatures, X25519→AES-256-GCM for
   encryption. No cipher menu, no RSA, no negotiation. Fewer choices = fewer
   footguns.
5. **Fail closed.** An SDK that receives an envelope it cannot verify/decrypt
   MUST surface an error and MUST NOT deliver the payload as if trusted.

---

## 2. Threat model

- **What crypto buys here:** integrity + authenticity (signing) and
  confidentiality (encryption) **between mutually-distrusting clients**,
  especially over the optional **TCP** transport where multiple hosts/users
  share a bus. Also tamper-evidence for state values.
- **What it does NOT buy:** hiding data from the local daemon operator when you
  only use the Unix socket on a single trusted host (there, the OS `0600`
  permission is the boundary). Crypto is for the multi-party / networked case,
  or when you want signed provenance regardless of transport.
- **Not in scope:** the daemon enforcing anything. If an attacker can write to a
  bucket, they can publish garbage; subscribers simply reject envelopes that
  fail verification. Availability (a flooder) is out of scope — see the bus
  fan-out drop policy.

---

## 3. Envelope format

An envelope is a JSON object carried **as the payload** (the `EMIT` json_data or
the `SET` value). It is distinguished from ordinary payloads by a reserved
discriminator key **`$nbus`**. Ordinary payloads never contain a top-level
`$nbus` key (SDKs MUST reject sending a plain payload that has one).

All binary fields are **base64url without padding** (RFC 4648 §5).

### 3.1 Signed envelope (`$nbus: "s1"`)

```json
{
  "$nbus": "s1",
  "alg": "ed25519",
  "pub": "<base64url 32-byte ed25519 public key>",
  "ts":  1720000000,
  "payload": <any JSON value — the real message>,
  "sig": "<base64url 64-byte signature>"
}
```

- **Signing input** is the JCS (§3.4) canonicalization of the object
  `{ "$nbus":"s1", "alg":"ed25519", "pub":..., "ts":..., "payload":... }`.
  Because JCS sorts keys by UTF-16 code unit, the signing input frame is emitted
  in the order **`$nbus, alg, payload, pub, ts`** (see §3.4 — JCS ordering is
  authoritative and reorders the frame keys). `sig` is then added. Verifiers
  reconstruct the same bytes and check `sig` against `pub`.
- **`ts`** is unix seconds at signing. Verifiers MAY reject envelopes whose `ts`
  is outside an acceptable clock-skew window (default ±300s) to bound replay.
  `ts` is inside the signed bytes, so it cannot be altered.
- Identity = the `pub` key. Trust is the verifier's business (see §5).

### 3.2 Encrypted envelope (`$nbus: "e1"`)

Encryption is **to a single recipient static X25519 public key**, using an
ephemeral sender key (forward secrecy for the sender), ECDH, HKDF-SHA-256 to
derive a 256-bit key, then AES-256-GCM.

```json
{
  "$nbus": "e1",
  "alg": "x25519-hkdf-sha256-aes256gcm",
  "epk": "<base64url 32-byte ephemeral X25519 public key>",
  "iv":  "<base64url 12-byte GCM nonce>",
  "ct":  "<base64url ciphertext || 16-byte GCM tag>",
  "aad": "<optional base64url additional authenticated data>"
}
```

- **Key agreement:** `shared = X25519(eph_priv, recipient_pub)`.
- **KDF:** `key = HKDF-SHA-256(ikm=shared, salt=epk, info="nbus-e1", len=32)`.
- **AEAD:** `ct = AES-256-GCM(key, iv, plaintext, aad?)`. `iv` MUST be unique
  per message (random 12 bytes is fine given ephemeral keys). The 16-byte GCM
  tag is appended to the ciphertext inside `ct`.
- **Plaintext** is the canonical (§3.4) UTF-8 JSON of the real payload.
- Recipient derives the same `key` with `X25519(recipient_priv, epk)` and
  decrypts. A failed tag = reject (fail closed).

> **Multi-recipient (deferred):** v0.1 encrypts to ONE recipient. Fan-out to N
> recipients = publish N envelopes, or a future `"e2"` scheme with per-recipient
> wrapped keys. Marked here so the discriminator leaves room.

### 3.3 Signed **and** encrypted (sign-then-encrypt)

To get both authenticity and confidentiality: build the **`s1`** signed
envelope over the plaintext, then use the whole `s1` object as the **plaintext**
of an **`e1`** envelope. Recipients decrypt `e1`, then verify the inner `s1`.
Rationale for sign-then-encrypt: the signature is not exposed to non-recipients,
and the verified identity is bound to the confidential content.

Shipped as `sealSignedEncrypted()` / `openSignedEncrypted()` in `src/crypto.ts`;
the SDK triggers it automatically when both `sign` and `encryptTo` are supplied
(§4).

### 3.4 Canonical JSON — RFC 8785 (JCS)

To make signatures reproducible across languages, hashed/encrypted JSON uses
**RFC 8785 JSON Canonicalization Scheme (JCS)**:

- UTF-8, no insignificant whitespace (compact, matching the single-line
  [framing rule](PROTOCOL.md)).
- Object keys sorted by UTF-16 code unit.
- Numbers serialized per JCS (ECMAScript `Number` canonical form).

JCS ordering is **authoritative and applies to the whole envelope frame**: the
`s1` frame keys are canonicalized alongside `payload`, so the signed bytes carry
the keys in JCS order (`$nbus, alg, payload, pub, ts`), not the source order.
The `payload` value and any nested objects are likewise JCS-serialized. Integers
are strongly preferred in signed payloads for readability, but JCS pins float
formatting so non-integers also interoperate.

> Canonicalization is the fiddliest cross-language part. The conformance vectors
> (§7) pin exact bytes so every SDK agrees — each `sign` vector includes the
> exact `signingInput` string, which is gold for debugging a foreign impl before
> blaming the signature. Using standard JCS means any language's off-the-shelf
> JCS library produces identical bytes to our zero-dependency implementation.

---

## 4. SDK API

The TypeScript SDK (`src/client.ts`) exposes the crypto layer via two option
bags — `SendCryptoOptions` (outbound) and `RecvCryptoOptions` (inbound) — plus
re-exported `Keypair`, `isEnvelope`, and `envelopeKind` from `src/crypto.ts`.

```typescript
import { NBus, Keypair, isEnvelope } from "./src/client";

// Generate / load identities. Keypair factories return objects whose
// `publicKeyB64` is the base64url raw 32-byte public key (the wire identity).
const signer = await Keypair.ed25519();     // Ed25519Keypair
const recipient = await Keypair.x25519();   // X25519Keypair

const bus = new NBus();

// Emit signed  → s1 envelope
await bus.emit("audit", "login", { user: "alice" }, { sign: signer });

// Emit encrypted to a recipient → e1 envelope.
// encryptTo takes the recipient's base64url X25519 public key (a string),
// NOT the keypair object.
await bus.emit("secrets", "token", { t: "..." },
  { encryptTo: recipient.publicKeyB64 });

// Emit signed + encrypted → sign-then-encrypt (e1 wrapping an inner s1)
await bus.emit("secrets", "token", { t: "..." },
  { sign: signer, encryptTo: recipient.publicKeyB64 });

// Listen with verification/decryption. Fails closed: an envelope that does not
// verify/decrypt is delivered as an error item (error set, data undefined),
// never as trusted data.
for await (const item of bus.listen("audit", "login", {
  verify: (pub, env) => trustedPubs.has(pub), // trust predicate; false → reject
  decryptWith: recipient,                     // X25519Keypair, for e1 envelopes
  maxSkewSeconds: 300,                        // optional freshness window
})) {
  if (item.error) { handleReject(item.error, item.raw); continue; }
  // item.data     = verified/decrypted payload
  // item.signedBy = signer pub (base64url) when an accepted s1 was present
  // item.encrypted = true when the item arrived inside an e1 envelope
}
```

### Delivery-item shape

`listen` yields `ListenItem`, `watch` (with recv opts) yields `WatchItem`, and
`get` (with recv opts) resolves a `GetResult`. All carry the same crypto
metadata:

| Field | Meaning |
|-------|---------|
| `data` | cleartext payload (present on accept; `undefined`/`null` on reject) |
| `signedBy` | verified ed25519 signer pub (base64url), only for accepted `s1` |
| `encrypted` | `true` when the item arrived inside an `e1` envelope |
| `error` | set on a fail-closed reject; `data` is then absent |
| `raw` | the offending envelope on a reject, for inspection |

(`ListenItem` also carries `bucket`/`event`; `GetResult.data` is `T | null`.)

### `get` / `watch` are overloaded

Both are backward compatible via overloads keyed on whether recv options are
passed:

- **No opts** → the bare pre-crypto shape: `get` resolves `T | null`, `watch`
  yields `T`. Envelopes are NOT interpreted; the value is delivered verbatim.
- **With `RecvCryptoOptions`** → `get` resolves `GetResult<T>`, `watch` yields
  `WatchItem<T>`, with the crypto metadata above and fail-closed handling.

`set` takes `SendCryptoOptions` as its 4th arg, exactly like `emit`.

**Rules:**
- Sending options absent → plain payload (byte-for-byte identical to the
  pre-crypto path, backward compatible).
- Receiving without recv options → enveloped messages are delivered verbatim as
  `data` (opt-out); the SDK does NOT interpret or strip them. Use
  `isEnvelope(data)` / `envelopeKind(data)` to detect one yourself.
- A **`verify` predicate is REQUIRED to accept an `s1`**. An `s1` arriving under
  recv options with no `verify` predicate is **rejected** (`error` set), never
  trusted — pass `verify: () => true` to accept any signer explicitly. No
  accidental trust. This also applies to the inner `s1` of a sign-then-encrypt
  envelope.
- `verify` receives `(pub, env)` — the verified signer pub plus the full parsed
  `SignedEnvelope` (inspect `ts`, `alg`, etc.). A falsy return rejects.

---

## 5. Key discovery (optional convention)

A lightweight, **non-normative** convention for clients to publish their public
keys so peers can find them — still just ordinary bus state, no daemon logic.
Shipped as `publishKeys` / `fetchKeys` / `watchKeys` on `NBus`:

- Reserved bucket: **`_keys`**.
- `SET _keys <name> <pubkey-record>` where the record is:
  ```json
  { "sign": "<base64url ed25519 pub>", "box": "<base64url x25519 pub>", "ts": 1720000000 }
  ```
  At least one of `sign` / `box` is present; `ts` is the publish time (for
  rotation).
- `GET _keys <name>` to fetch; `WATCH _keys <name>` for rotation.
- This is **TOFU** (trust on first use) at best — publishing a key here asserts
  nothing. Out-of-band verification (fingerprint comparison) is the user's
  responsibility. Documented as convenience, not a PKI.

---

## 6. What the daemon does

**Nothing new.** The envelope is a normal JSON payload. It counts against
`max_payload_bytes` (encryption + base64 inflate size ~1.4×, note this in
limits docs). The ring buffer, fan-out, and state store treat it as opaque.
No new wire commands. No config. This section exists to make the "zero daemon
change" guarantee explicit and testable.

---

## 7. Conformance vectors (crypto)

`tests/crypto-vectors.json` holds fixed keypairs (seeded), fixed plaintexts, and
the exact expected canonical bytes, signatures, and ciphertext-decrypts. Because
AES-GCM/X25519 use randomness (iv, epk), encryption vectors pin the **decrypt**
direction (given epk+iv+ct+recipient priv → plaintext) rather than encrypt
output. Signature vectors pin exact `sig` bytes for given key+message (ed25519 is
deterministic) and include the exact `signingInput`. These let any language SDK
prove interop without a live peer. The reference (Bun) runner is
`tests/crypto-conformance.test.ts`; the file is regenerated by
`tests/gen-crypto-vectors.ts`. Vector kinds and steps: see
`tests/crypto-vectors.schema.md`.

---

## 8. Resolved decisions

1. **Clock skew:** verifiers reject `s1` envelopes whose `ts` is outside **±300s**
   by default. Configurable per-listen/-verify call (`maxSkewSeconds`, `0` or
   `Infinity` = disable the check). Signing always stamps `ts`.
2. **`verify` predicate signature:** receives **`(pub, envelope)`** — the pubkey
   plus the full parsed envelope (so a caller can inspect `ts`, `alg`, etc.).
   Returning a falsy value rejects the message (fail closed).
3. **Canonical JSON = RFC 8785 (JCS).** We implement the JCS subset ourselves
   (zero new dependency) but conform to the standard so any language's JCS lib
   interoperates: UTF-8, no insignificant whitespace, object keys sorted by
   UTF-16 code unit, JSON-number canonical form per ECMAScript `Number.prototype.toString`.
   JCS applies to the **whole** envelope frame: the `s1` frame keys are
   canonicalized (yielding order `$nbus, alg, payload, pub, ts`) along with the
   `payload` and any nested objects. Integers strongly preferred in signed
   payloads; JCS pins float formatting so non-integers are also interoperable,
   just discouraged for readability.
4. **State signing carries `ts`.** `set`/`get`/`watch` use the same `s1`/`e1`
   envelopes as events, `ts` included, so state values get the same freshness /
   tamper-evidence guarantees. Last-writer-wins still governs storage; `ts` is
   advisory to the reader.
5. **`_keys` is pure convention.** The daemon does NOT reserve or special-case
   it (principle §1.1 — dumb daemon wins). Anyone can write `_keys`; it is TOFU,
   nothing more. SDK helpers use it but assert no trust.
