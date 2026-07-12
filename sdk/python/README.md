# nbus-client (Python)

Async Python SDK for [nbus](https://github.com/tcsenpai/nbus) — a local IPC bus
offering pub/sub and shared key/value state over a Unix socket, with an
**optional** end-to-end crypto layer (ed25519 signing + X25519/AES-256-GCM
encryption). Built on `asyncio`; the crypto layer uses the
[`cryptography`](https://pypi.org/project/cryptography/) library.

> **v0.1 — honest status.** Local-only, in-memory daemon, no auth at the bus
> layer. The crypto layer is opt-in and fail-closed. The `_keys` discovery
> convention is TOFU (trust on first use): verify fingerprints out-of-band.

This is one of two reference SDKs (the other is
[@nbus/client for TypeScript](../typescript/README.md)). Both pass the same
shared conformance vectors, so they interoperate on the wire and in crypto.

## Install

```bash
uv add nbus-client
# or: pip install nbus-client
```

Requires Python 3.11+. A running `nbusd` daemon is required (see the repo root
for the server).

## Quickstart

`NBus` is an async context manager. `emit`/`set`/`get` are awaited;
`listen`/`watch` are async generators iterated with `async for`.

```python
import asyncio
from nbus import NBus

async def main():
    async with NBus("/tmp/nbus.sock") as bus:
        # pub/sub
        await bus.emit("deploy", "done", {"version": "1.2.3"})
        async for ev in bus.listen("deploy", "done"):
            print(ev["bucket"], ev["event"], ev["data"])
            break

        # shared state
        await bus.set("config", "flag", True)
        flag = await bus.get("config", "flag")  # True | None

        # watch a key for changes
        async for value in bus.watch("config", "flag"):
            print("flag ->", value)
            break

asyncio.run(main())
```

`listen(bucket, event="*")` yields `{"bucket", "event", "data"}` dicts. The
client reconnects automatically (exponential backoff 100ms → 1s → 10s),
re-subscribes active streams after a reconnect, and PINGs every 30s. Module-level
one-shot helpers `emit` / `set` / `get` open, act, and close a transient client.

## Crypto (optional)

Keys come from the `Keypair` factory — `Keypair.ed25519()` (signing) and
`Keypair.x25519()` (encryption). Send options wrap the payload before it hits the
wire; recv options verify / decrypt and are **fail-closed** (a bad or unexpected
envelope surfaces as an `error`, never as trusted `data`). All crypto arguments
are keyword-only.

```python
from nbus import NBus, Keypair

signer = Keypair.ed25519()  # Ed25519Keypair
box = Keypair.x25519()      # X25519Keypair

async with NBus() as bus:
    # sign only → s1 envelope
    await bus.emit("b", "e", {"hi": "there"}, sign=signer)

    # encrypt only → e1 envelope
    await bus.emit("b", "e", {"secret": 1}, encrypt_to=box.public_key_b64)

    # sign-then-encrypt → e1 wrapping an inner s1
    await bus.emit("b", "e", {"v": 42}, sign=signer, encrypt_to=box.public_key_b64)

    # receive: `verify` predicate is REQUIRED to accept a signed payload;
    # `decrypt_with` is the X25519 keypair used to open e1 envelopes.
    async for item in bus.listen(
        "b", "e",
        verify=lambda pub, env: pub == signer.public_key_b64,
        decrypt_with=box,
    ):
        if item.get("error"):
            print("rejected:", item["error"])
        else:
            print(item.get("data"), "signed_by", item.get("signed_by"),
                  "encrypted", item.get("encrypted"))
        break
```

`set` / `get` take the same options: `set(bucket, key, value, sign=, encrypt_to=)`
and `get(bucket, key, verify=, decrypt_with=)` (the crypto form of `get` returns
a dict `{"data", "signed_by", "encrypted", "error", "raw"}`).

**Fail-closed contract.** Under recv options, a signed (`s1`) payload with no
`verify` predicate is rejected — accepting it would be a trust decision the
caller never made. An encrypted (`e1`) payload with no `decrypt_with` is
rejected. Any structural error, bad signature, stale `ts` (default skew 300s,
tune with `max_skew_seconds`), or failed decrypt returns `{"error", "raw"}` with
no `data`, never trusted data. Plain payloads pass through as `data`.

### Key discovery (`_keys`, TOFU)

`publish_keys` / `fetch_keys` / `watch_keys` are pure conventions over ordinary
bus state in the `_keys` bucket. The daemon does not protect `_keys` — a record
asserts nothing about ownership. **Verify fingerprints out-of-band.**

```python
await bus.publish_keys("alice", sign=signer, box=box)  # at least one of sign/box
rec = await bus.fetch_keys("alice")                    # {"sign"?, "box"?, "ts"} | None
async for rotated in bus.watch_keys("alice"):          # observe rotation
    print("alice keys rotated:", rotated)
    break
```

## Conformance & interop

Passes the shared, language-agnostic vectors in the repo:
[`tests/vectors.json`](https://github.com/tcsenpai/nbus/blob/main/tests/vectors.json)
(wire protocol) and
[`tests/crypto-vectors.json`](https://github.com/tcsenpai/nbus/blob/main/tests/crypto-vectors.json)
(signing byte-pinned, decrypt direction pinned) — the **same** vectors the
TypeScript SDK passes. Canonical JSON (RFC 8785 / JCS) and the envelope formats
are byte-identical across both, so a message signed/encrypted by one SDK verifies
and decrypts in the other.

## Publishing (maintainer note)

Metadata lives in `pyproject.toml` (hatchling build backend). To release: bump
`version`, then `cd sdk/python && uv build && uv publish`.

## Links

- SDK Guide (build a client in any language): <https://github.com/tcsenpai/nbus/wiki/SDK-Guide>
- Crypto Envelope spec: <https://github.com/tcsenpai/nbus/wiki/Crypto-Envelope>
- Crypto spec (in-repo): [CRYPTO.md](https://github.com/tcsenpai/nbus/blob/main/CRYPTO.md)
- Docs & protocol: <https://github.com/tcsenpai/nbus/wiki>
- Source & issues: <https://github.com/tcsenpai/nbus>

## Develop

```sh
uv sync
uv run pytest -q   # boots the real Bun daemon and replays wire + crypto vectors
```

## License

MIT
