# @nbus/client

TypeScript client SDK for [nbus](https://github.com/tcsenpai/nbus) — a local IPC
bus offering pub/sub and shared key/value state over a Unix socket, with an
**optional** end-to-end crypto layer (ed25519 signing + X25519/AES-GCM
encryption). Zero runtime dependencies (`node:crypto` only).

> **v0.1 — honest status.** Local-only, in-memory daemon, no auth at the bus
> layer. The crypto layer is opt-in and fail-closed. The `_keys` discovery
> convention is TOFU (trust on first use): verify fingerprints out-of-band.

## Install

```bash
bun add @nbus/client
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

One-shot helpers for scripts (`emit`, `set`, `get`) open, act, and close a
transient client:

```ts
import { emit, set, get } from "@nbus/client";

await emit("metrics", "tick", { n: 1 });
await set("cache", "k", "v");
const v = await get<string>("cache", "k");
```

## Crypto (optional)

Send options wrap the payload before it hits the wire; recv options verify /
decrypt and are **fail-closed** (a bad or unexpected envelope surfaces as an
`error`, never as trusted `data`).

```ts
import { NBus, Keypair } from "@nbus/client";

const signer = await Keypair.ed25519();
const box = await Keypair.x25519();
const bus = new NBus();

// sign
await bus.emit("b", "e", { hi: "there" }, { sign: signer });

// encrypt
await bus.emit("b", "e", { secret: 1 }, { encryptTo: box.publicKeyB64 });

// sign-then-encrypt
await bus.emit("b", "e", { v: 42 }, { sign: signer, encryptTo: box.publicKeyB64 });

// receive: verify predicate REQUIRED to accept a signed payload
for await (const item of bus.listen("b", "e", {
  verify: (pub) => pub === signer.publicKeyB64,
  decryptWith: box,
})) {
  if (item.error) console.warn("rejected:", item.error);
  else console.log(item.data, "signedBy", item.signedBy, "enc", item.encrypted);
  break;
}
```

### Key discovery (`_keys`, TOFU)

`publishKeys` / `fetchKeys` / `watchKeys` are pure conventions over ordinary bus
state in the `_keys` bucket. The daemon does not protect `_keys` — a record
asserts nothing about ownership. **Verify fingerprints out-of-band.**

```ts
await bus.publishKeys("alice", { sign: signer, box });
const rec = await bus.fetchKeys("alice"); // { sign?, box?, ts } | null
```

## Links

- Docs & protocol: <https://github.com/tcsenpai/nbus/wiki>
- Source & issues: <https://github.com/tcsenpai/nbus>

## License

MIT
