# nbus — Crypto Envelope Specification (v0.1-draft)

> **Status: DRAFT for review — not yet implemented.** This document defines an
> OPTIONAL, protocol-level envelope for signed and/or encrypted nbus payloads.
> It is a design surface: annotate inline, then it drives the SDK implementation.

---

## 1. Design principles (non-negotiable)

1. **The daemon stays dumb.** nbus is a broadcast relay. It does NOT hold keys,
   verify signatures, or decrypt anything. Crypto is **end-to-end between
   clients**. The daemon relays the envelope as an opaque JSON payload, exactly
   like any other payload. **Zero daemon changes.**
2. **Optional and interoperable.** A plain payload and an enveloped payload MUST
   coexist on the same bucket/key. Enveloping is a client choice, per message.
3. **Zero new dependencies.** All primitives come from Bun's WebCrypto
   (`crypto.subtle`) / `node:crypto`. No libsodium, no npm crypto libs.
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

- **Signing input** is the deterministic UTF-8 serialization of the object
  `{ "$nbus":"s1", "alg":"ed25519", "pub":..., "ts":..., "payload":... }` with
  keys in **exactly that order** and `payload` serialized canonically (§3.4).
  `sig` is then added. Verifiers reconstruct the same bytes and check `sig`
  against `pub`.
- **`ts`** is unix seconds at signing. Verifiers MAY reject envelopes whose `ts`
  is outside an acceptable clock-skew window (default suggestion: ±300s) to
  bound replay. `ts` is inside the signed bytes, so it cannot be altered.
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
  per message (random 12 bytes is fine given ephemeral keys).
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

### 3.4 Canonical JSON

To make signatures reproducible across languages, the signed/encrypted bytes use
a canonical serialization:

- UTF-8, no insignificant whitespace (compact, matching the single-line
  [framing rule](PROTOCOL.md)).
- Object keys sorted lexicographically by UTF-16 code unit **except** the
  fixed-order envelope frame keys in §3.1 (which are emitted in the stated
  order). The **`payload`** value and any nested objects use sorted keys.
- Numbers: no leading `+`, no trailing zeros beyond what round-trips; integers
  where possible. (SDKs SHOULD avoid non-integer floats in signed payloads to
  dodge cross-language float formatting drift — document this caveat.)

> Canonicalization is the fiddliest cross-language part. The conformance vectors
> (§7) pin exact bytes so every SDK agrees.

---

## 4. SDK API (reference shape)

The TypeScript SDK (`src/client.ts`) gains an optional crypto layer. Illustrative:

```typescript
import { NBus, Keypair } from "./client";

// Generate / load identities
const signer = await Keypair.ed25519();          // { publicKey, privateKey, ... }
const recipient = await Keypair.x25519();

const bus = new NBus();

// Emit signed
await bus.emit("audit", "login", { user: "alice" }, { sign: signer });

// Emit encrypted to a recipient
await bus.emit("secrets", "token", { t: "..." }, { encryptTo: recipient.publicKey });

// Emit signed + encrypted
await bus.emit("secrets", "token", { t: "..." },
  { sign: signer, encryptTo: recipient.publicKey });

// Listen with verification/decryption. Fails closed: an envelope that does not
// verify/decrypt is delivered as an error, never as trusted data.
for await (const ev of bus.listen("audit", "login", {
  verify: (pub) => trustedPubs.has(pub),   // trust predicate; return false → reject
  decryptWith: recipient,                   // for e1 envelopes
})) {
  // ev.data = verified/decrypted payload; ev.signedBy = pub (if s1); ev.encrypted = bool
}
```

Same option shapes apply to `set` / `get` / `watch` for state values.

**Rules:**
- Sending options absent → plain payload (backward compatible).
- Receiving without verify/decrypt options → enveloped messages are surfaced
  RAW (the envelope object) so the caller can handle them, but the SDK MUST NOT
  silently strip/trust them. Provide a helper to detect `isEnvelope(data)`.
- `verify` predicate absent but an `s1` arrives → deliver with `signedBy` set and
  `verified:false`? No — **fail closed**: require an explicit
  `verify: () => true` to accept any signer. No accidental trust.

---

## 5. Key discovery (optional convention)

A lightweight, **non-normative** convention for clients to publish their public
keys so peers can find them — still just ordinary bus state, no daemon logic:

- Reserved bucket: **`_keys`**.
- `SET _keys <name> <pubkey-record>` where the record is:
  ```json
  { "sign": "<base64url ed25519 pub>", "box": "<base64url x25519 pub>", "ts": 1720000000 }
  ```
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

Extend `tests/vectors.json` philosophy with a `tests/crypto-vectors.json`: fixed
keypairs (seeded), fixed plaintexts, and the exact expected canonical bytes,
signatures, and ciphertext-decrypts. Because AES-GCM/X25519 use randomness (iv,
epk), encryption vectors pin the **decrypt** direction (given epk+iv+ct+recip
priv → plaintext) rather than encrypt output. Signature vectors pin exact `sig`
bytes for given key+message (ed25519 is deterministic). These let any language
SDK prove interop without a live peer.

---

## 8. Open questions (for annotation)

1. Clock-skew default for `ts` rejection — ±300s? Configurable per-listen?
2. Should `verify` receive the whole envelope (incl `ts`) or just `pub`?
3. Canonical JSON: adopt an existing standard (JCS / RFC 8785) instead of a
   bespoke rule? JCS is well-specified and has cross-language libs — but pulling
   one in touches the zero-dep rule (could implement the JCS subset ourselves).
4. Do we need `set`/`get` state signing to also carry `ts` for freshness, or is
   last-writer-wins enough there?
5. Key discovery `_keys` bucket — reserve it in the daemon (reject plain writes?)
   or keep it pure convention? (Reserving = daemon logic, violates §1 principle 1.)
