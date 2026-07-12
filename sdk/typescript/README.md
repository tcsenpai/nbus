# @nbus/client

TypeScript client SDK for [nbus](https://github.com/tcsenpai/nbus) — a local IPC
bus offering pub/sub and shared key/value state over a Unix socket, with an
**optional** end-to-end crypto layer (ed25519 signing + X25519/AES-256-GCM
encryption). Zero runtime dependencies (`node:crypto` only).

> **v0.1 — honest status.** Local-only, in-memory daemon, no auth at the bus
> layer. The crypto layer is opt-in and fail-closed. The `_keys` discovery
> convention is TOFU (trust on first use): verify fingerprints out-of-band.

This is one of two reference SDKs (the other is
[nbus-client for Python](../python/README.md)). Both pass the same shared
conformance vectors, so they interoperate on the wire and in crypto.

## Install

```bash
bun add @nbus/client
# or: npm install @nbus/client
```

The package ships its TypeScript sources directly — Bun and TS consumers import
`.ts` with no build step. A running `nbusd` daemon is required (see the repo
root for the server).

## Quickstart

```ts
import { NBus } from "@nbus/client";

const bus = new NBus({ socket: "/tmp/nbus.sock" });

// pub/sub
await bus.emit("deploy", "done", { version: "1.2.3" });
for await (const ev of bus.listen("deploy", "done")) {
  console.log(ev.bucket, ev.event, ev.data);
  break;
}

// shared state
await bus.set("config", "flag", true);
const flag = await bus.get<boolean>("config", "flag"); // true | null

// watch a key for changes
for await (const value of bus.watch<boolean>("config", "flag")) {
  console.log("flag ->", value);
  break;
}

bus.close();
```

`listen()` (event `"*"` by default) and `watch()` are async generators; iterate
them with `for await`. The client reconnects automatically (exponential backoff
100ms → 1s → 10s), re-subscribes active streams after a reconnect, and PINGs
every 30s.

One-shot helpers for scripts (`emit`, `set`, `get`) open, act, and close a
transient client:

```ts
import { emit, set, get } from "@nbus/client";

await emit("metrics", "tick", { n: 1 });
await set("cache", "k", "v");
const v = await get<string>("cache", "k");
```

## Crypto (optional)

Keys come from the `Keypair` factory — `Keypair.ed25519()` (signing) and
`Keypair.x25519()` (encryption); both return a promise. Send options wrap the
payload before it hits the wire; recv options verify / decrypt and are
**fail-closed** (a bad or unexpected envelope surfaces as an `error`, never as
trusted `data`).

```ts
import { NBus, Keypair } from "@nbus/client";

const signer = await Keypair.ed25519(); // Ed25519Keypair
const box = await Keypair.x25519();     // X25519Keypair
const bus = new NBus();

// sign only → s1 envelope
await bus.emit("b", "e", { hi: "there" }, { sign: signer });

// encrypt only → e1 envelope
await bus.emit("b", "e", { secret: 1 }, { encryptTo: box.publicKeyB64 });

// sign-then-encrypt → e1 wrapping an inner s1
await bus.emit("b", "e", { v: 42 }, { sign: signer, encryptTo: box.publicKeyB64 });

// receive: `verify` predicate is REQUIRED to accept a signed payload;
// `decryptWith` is the X25519 keypair used to open e1 envelopes.
for await (const item of bus.listen("b", "e", {
  verify: (pub) => pub === signer.publicKeyB64,
  decryptWith: box,
})) {
  if (item.error) console.warn("rejected:", item.error);
  else console.log(item.data, "signedBy", item.signedBy, "encrypted", item.encrypted);
  break;
}
```

`set` / `get` take the same options: `set(bucket, key, value, { sign, encryptTo })`
and `get(bucket, key, { verify, decryptWith })` (the crypto form of `get`
returns a `GetResult` — `{ data, signedBy?, encrypted?, error?, raw? }`).

**Fail-closed contract.** Under recv options, a signed (`s1`) payload with no
`verify` predicate is rejected — accepting it would be a trust decision the
caller never made. An encrypted (`e1`) payload with no `decryptWith` is
rejected. Any structural error, bad signature, stale `ts` (default skew 300s,
tune with `maxSkewSeconds`), or failed decrypt yields `{ error, raw }` with
`data` undefined, never trusted data. Plain payloads pass through as `data`.

### Key discovery (`_keys`, TOFU)

`publishKeys` / `fetchKeys` / `watchKeys` are pure conventions over ordinary bus
state in the `_keys` bucket. The daemon does not protect `_keys` — a record
asserts nothing about ownership. **Verify fingerprints out-of-band.**

```ts
await bus.publishKeys("alice", { sign: signer, box }); // at least one of sign/box
const rec = await bus.fetchKeys("alice");              // { sign?, box?, ts } | null
for await (const rotated of bus.watchKeys("alice")) {  // observe rotation
  console.log("alice keys rotated:", rotated);
  break;
}
```

## Conformance

Passes the shared, language-agnostic vectors in the repo:
[`tests/vectors.json`](https://github.com/tcsenpai/nbus/blob/main/tests/vectors.json)
(wire protocol) and
[`tests/crypto-vectors.json`](https://github.com/tcsenpai/nbus/blob/main/tests/crypto-vectors.json)
(signing byte-pinned, decrypt direction pinned). The Python SDK passes the same
vectors, which is what makes the two cross-language interoperable.

## Publishing (maintainer note)

Metadata lives in `package.json` (`publishConfig.access` is `public` for the
scoped name). To release: bump `version`, then `cd sdk/typescript && npm publish`.

## Links

- SDK Guide (build a client in any language): <https://github.com/tcsenpai/nbus/wiki/SDK-Guide>
- Crypto Envelope spec: <https://github.com/tcsenpai/nbus/wiki/Crypto-Envelope>
- Crypto spec (in-repo): [CRYPTO.md](https://github.com/tcsenpai/nbus/blob/main/CRYPTO.md)
- Docs & protocol: <https://github.com/tcsenpai/nbus/wiki>
- Source & issues: <https://github.com/tcsenpai/nbus>

## License

MIT
