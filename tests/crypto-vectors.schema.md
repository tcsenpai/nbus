# nbus crypto conformance vectors — schema

`tests/crypto-vectors.json` is a **language-agnostic** known-answer test (KAT)
spec for the nbus crypto envelope (see `CRYPTO.md` v0.1, §7). It is pure data so
a runner in any language (TypeScript, Python, Go, Rust, ...) can execute it
against its own crypto implementation to prove interop. `tests/crypto-conformance.test.ts`
is the reference (Bun) runner; `tests/gen-crypto-vectors.ts` generates the file.

The file is a JSON **array of vector objects**. The first element is a doc-only
object with `kind: "_README"` (skip any vector whose `kind` starts with `_`).

## General conventions

- All binary fields are **base64url without padding** (RFC 4648 §5).
- ed25519 signing is **deterministic**, so `sign` vectors pin the exact `sig`.
- AES-GCM / X25519 encryption uses a random `iv`/`epk`, so encryption vectors
  pin the **decrypt** direction: the recorded envelope + recipient private key
  must decrypt to the expected plaintext. Foreign SDKs replay, they do not
  re-encrypt.
- `maxSkewSeconds: null` means **disable the freshness check** (the reference
  impl maps it to `Infinity`; JSON has no `Infinity` literal).
- Fixed keys are derived from **deterministic 32-byte seeds** (a repeated byte
  or an incrementing pattern), never random.

Each vector has a `kind` discriminator and a unique `name` (used as the test id).

---

## kind: `jcs`

RFC 8785 (JSON Canonicalization Scheme). Feed `input` to your canonicalizer;
the UTF-8 output string MUST equal `output` byte-for-byte.

```jsonc
{
  "kind": "jcs",
  "name": "jcs-key-sort",
  "input": { "b": 1, "a": 2, "c": 3 },   // any JSON value
  "output": "{\"a\":2,\"b\":1,\"c\":3}"  // exact canonical string
}
```

Covers: object key sorting (incl. case & numeric-string keys), nested recursion,
array order preservation, number forms (int, float, `-0`→`"0"`, negative, large
int), string escaping (`"` `\` `\b \t \n \f \r`, control chars → `\u00xx`),
non-ASCII emitted literally as UTF-8, and empty object/array.

---

## kind: `sign`

ed25519 `s1` signing. Load a keypair from the 32-byte `seed`, sign `payload`
with timestamp `ts`, and compare.

```jsonc
{
  "kind": "sign",
  "name": "sign-basic",
  "seed": "<b64u 32-byte ed25519 seed>",
  "ts": 1720000000,
  "payload": { "user": "alice", "n": 42 },
  "expect": {
    "pub": "<b64u 32-byte ed25519 public key>",
    "sig": "<b64u 64-byte signature>",          // EXACT — deterministic
    "signingInput": "{\"$nbus\":\"s1\",\"alg\":\"ed25519\",\"payload\":{\"n\":42,\"user\":\"alice\"},\"pub\":\"...\",\"ts\":1720000000}"
  }
}
```

`signingInput` is the exact JCS bytes fed to ed25519 (the s1 frame with keys in
JCS order: `$nbus, alg, payload, pub, ts`). This is GOLD for debugging a foreign
impl: compare your pre-sign bytes before blaming the signature.

Runner steps:
1. `kp = keypairFromSeed(seed)`; assert `kp.pub == expect.pub`.
2. Build the frame `{$nbus:"s1", alg:"ed25519", pub, ts, payload}`, canonicalize
   it (JCS), assert it equals `expect.signingInput`.
3. Sign, assert `sig == expect.sig`.

---

## kind: `verify`

`s1` verification. Pass the full `envelope` with the given `maxSkewSeconds`/`now`
and compare `ok` (and `pub`/`reason` when present).

```jsonc
{
  "kind": "verify",
  "name": "verify-valid",
  "envelope": { "$nbus": "s1", "alg": "ed25519", "pub": "...", "ts": 1720000000, "payload": {...}, "sig": "..." },
  "maxSkewSeconds": 300,        // null = disable freshness check
  "now": 1720000010,
  "expect": { "ok": true, "pub": "..." }
  // on failure: { "ok": false, "reason_contains": "verification failed" }
}
```

`reason_contains` is a substring match (reason wording is impl-specific; only the
substring is normative). Covers: valid, tampered payload, tampered `ts`, expired
`ts`, skew-disabled (`null`), and wrong signer pub.

---

## kind: `decrypt`

`e1` decryption. Load the recipient from `recipientPriv` (raw x25519), decrypt
the recorded `envelope`, and compare.

```jsonc
{
  "kind": "decrypt",
  "name": "decrypt-object",
  "recipientPriv": "<b64u 32-byte x25519 private key>",
  "envelope": { "$nbus": "e1", "alg": "x25519-hkdf-sha256-aes256gcm", "epk": "...", "iv": "...", "ct": "..." },
  "expect": { "ok": true, "payload": { "msg": "hello", "n": [1,2,3] } }
  // tampered ct: { "ok": false, "reason_contains"?: "..." }
}
```

The `envelope` is a real output of the reference `encryptTo` (its random `iv`/
`epk` are frozen into the vector). Because decrypt is deterministic given the
envelope, every SDK gets the same plaintext. Includes a tampered-`ct` case that
MUST fail closed (`ok:false`) on the GCM tag. Note: plaintext is the JCS UTF-8
JSON of the payload, so `expect.payload` compares structurally after re-parsing.

---

## kind: `open`

Sign-then-encrypt (`s1` inside `e1`, CRYPTO.md §3.3). Decrypt the outer `e1`,
then verify the inner `s1`.

```jsonc
{
  "kind": "open",
  "name": "open-valid",
  "recipientPriv": "<b64u 32-byte x25519 private key>",
  "envelope": { "$nbus": "e1", "alg": "x25519-hkdf-sha256-aes256gcm", "epk": "...", "iv": "...", "ct": "..." },
  "maxSkewSeconds": 300,
  "now": 1720000000,
  "expect": { "ok": true, "pub": "<signer ed25519 pub>", "payload": {...} }
  // failures: { "ok": false, "reason_contains": "verify" | "decrypt" }
}
```

Covers: valid open (exposes signer `pub` + verified `payload`), expired inner
`ts` (fails at the verify stage), and wrong recipient (fails at the decrypt
stage).
