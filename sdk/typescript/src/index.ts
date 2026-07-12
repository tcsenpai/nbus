// Public API surface of the @nbus/client SDK.
//
// Single source of truth for the TypeScript client + optional crypto layer.
// The nbus server (Bus/Bucket/daemon) lives in the repo root and re-exports
// this package for the back-compatible `import ... from "nbus"` entrypoint.

export {
  NBus,
  emit,
  set,
  get,
  Keypair,
  isEnvelope,
  envelopeKind,
  type NBusOptions,
  type KeyRecord,
  type SendCryptoOptions,
  type RecvCryptoOptions,
  type ListenItem,
  type WatchItem,
  type GetResult,
  type JsonValue,
  type SignedEnvelope,
  type EncryptedEnvelope,
  type Ed25519Keypair,
  type X25519Keypair,
} from "./client";
