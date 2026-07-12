// Language-agnostic CRYPTO conformance runner (reference implementation).
//
// Loads tests/crypto-vectors.json (the frozen KAT vectors, CRYPTO.md §7) and
// replays each against src/crypto.ts, one bun:test `test()` per vector. This
// proves OUR impl matches the frozen vectors; a foreign-language runner mirrors
// this file. The vectors themselves are the spec (see crypto-vectors.schema.md);
// this file is just the TypeScript executor.
//
// Generate/regenerate the vectors with: bun run tests/gen-crypto-vectors.ts

import { test, expect } from "bun:test";
import {
  b64uDecode,
  canonicalize,
  Keypair,
  sign,
  verifySigned,
  decrypt,
  openSignedEncrypted,
  type JsonValue,
  type SignedEnvelope,
  type EncryptedEnvelope,
} from "../sdk/typescript/src/crypto.ts";

// ── Vector schema (mirrors tests/crypto-vectors.json) ────────────────────────

interface Readme {
  kind: "_README";
}

interface JcsVector {
  kind: "jcs";
  name: string;
  input: JsonValue;
  output: string;
}

interface SignVector {
  kind: "sign";
  name: string;
  seed: string;
  ts: number;
  payload: JsonValue;
  expect: { pub: string; sig: string; signingInput: string };
}

interface VerifyVector {
  kind: "verify";
  name: string;
  envelope: SignedEnvelope;
  maxSkewSeconds: number | null;
  now: number;
  expect: { ok: boolean; pub?: string; reason_contains?: string };
}

interface DecryptVector {
  kind: "decrypt";
  name: string;
  recipientPriv: string;
  envelope: EncryptedEnvelope;
  expect:
    | { ok: true; payload: JsonValue }
    | { ok: false; reason_contains?: string };
}

interface OpenVector {
  kind: "open";
  name: string;
  recipientPriv: string;
  envelope: EncryptedEnvelope;
  maxSkewSeconds: number | null;
  now: number;
  expect:
    | { ok: true; pub: string; payload: JsonValue }
    | { ok: false; reason_contains?: string };
}

type Vector =
  | Readme
  | JcsVector
  | SignVector
  | VerifyVector
  | DecryptVector
  | OpenVector;

// ── Load vectors ──────────────────────────────────────────────────────────────

const vectorsUrl = new URL("./crypto-vectors.json", import.meta.url);
const vectors = (await Bun.file(vectorsUrl).json()) as Vector[];

// `null` maxSkewSeconds means "disable the freshness check". src/crypto.ts uses
// Infinity for that; JSON has no Infinity literal, so vectors carry null.
function skewOpts(
  maxSkewSeconds: number | null,
  now: number,
): { maxSkewSeconds?: number; now: number } {
  if (maxSkewSeconds === null) return { maxSkewSeconds: Infinity, now };
  return { maxSkewSeconds, now };
}

// ── Per-kind executors ────────────────────────────────────────────────────────

function runJcs(v: JcsVector): void {
  expect(canonicalize(v.input)).toBe(v.output);
}

function runSign(v: SignVector): void {
  const kp = Keypair.ed25519FromSeed(b64uDecode(v.seed));
  // Pin the pre-sign bytes: the JCS of the s1 frame must match exactly.
  const frame: JsonValue = {
    $nbus: "s1",
    alg: "ed25519",
    pub: kp.publicKeyB64,
    ts: v.ts,
    payload: v.payload,
  };
  expect(canonicalize(frame)).toBe(v.expect.signingInput);
  // Deterministic ed25519: re-sign and pin pub + exact sig bytes.
  const signed = sign(v.payload, kp, v.ts);
  expect(signed.pub).toBe(v.expect.pub);
  expect(signed.sig).toBe(v.expect.sig);
}

function runVerify(v: VerifyVector): void {
  const r = verifySigned(v.envelope, skewOpts(v.maxSkewSeconds, v.now));
  expect(r.ok).toBe(v.expect.ok);
  if (r.ok && v.expect.ok) {
    if (v.expect.pub !== undefined) expect(r.pub).toBe(v.expect.pub);
  } else if (!r.ok && !v.expect.ok) {
    if (v.expect.reason_contains !== undefined) {
      expect(r.reason).toContain(v.expect.reason_contains);
    }
  }
}

function runDecrypt(v: DecryptVector): void {
  const recip = Keypair.x25519FromRawB64(v.recipientPriv);
  const r = decrypt(v.envelope, recip);
  expect(r.ok).toBe(v.expect.ok);
  if (r.ok && v.expect.ok) {
    expect(r.payload).toEqual(v.expect.payload);
  } else if (!r.ok && !v.expect.ok) {
    if (v.expect.reason_contains !== undefined) {
      expect(r.reason).toContain(v.expect.reason_contains);
    }
  }
}

function runOpen(v: OpenVector): void {
  const recip = Keypair.x25519FromRawB64(v.recipientPriv);
  const r = openSignedEncrypted(v.envelope, recip, skewOpts(v.maxSkewSeconds, v.now));
  expect(r.ok).toBe(v.expect.ok);
  if (r.ok && v.expect.ok) {
    expect(r.pub).toBe(v.expect.pub);
    expect(r.payload).toEqual(v.expect.payload);
  } else if (!r.ok && !v.expect.ok) {
    if (v.expect.reason_contains !== undefined) {
      expect(r.reason).toContain(v.expect.reason_contains);
    }
  }
}

// ── Register one test() per vector ────────────────────────────────────────────

for (const v of vectors) {
  if (v.kind === "_README") continue;
  test(`${v.kind}: ${v.name}`, () => {
    switch (v.kind) {
      case "jcs":
        return runJcs(v);
      case "sign":
        return runSign(v);
      case "verify":
        return runVerify(v);
      case "decrypt":
        return runDecrypt(v);
      case "open":
        return runOpen(v);
    }
  });
}
