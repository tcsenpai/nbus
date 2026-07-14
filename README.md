# nbus

**Local IPC bus — pub/sub + shared state, zero config.**

Any app, any language. One HTTP call to emit, one connection to subscribe.
Local-only, in-memory, no auth — v0.1.

## Install

`nbusd` (daemon) + `nbus` (client) ship as standalone compiled binaries for
macOS and Linux (arm64/x64). The binaries have no runtime dependency — Bun is
only needed to build from source, not to run them. In order of convenience:

**curl | sh** — downloads the release binaries, verifies SHA256, installs to
`/usr/local/bin` (or `~/.local/bin` if that's not writable):

```bash
curl -fsSL https://raw.githubusercontent.com/tcsenpai/nbus/main/install.sh | sh
```

Env knobs: `NBUS_VERSION=vX.Y.Z` to pin a tag, `PREFIX=/custom/bin` to choose the install dir.

**Homebrew**:

```bash
brew tap tcsenpai/nbus && brew install nbus
```

**Prebuilt binaries** — grab them from [GitHub Releases](https://github.com/tcsenpai/nbus/releases),
verify against `SHA256SUMS`, then install:

```bash
# after downloading nbusd-<os>-<arch>, nbus-<os>-<arch>, SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing   # sha256sum -c on Linux
chmod +x nbusd-* nbus-*
mv nbusd-<os>-<arch> /usr/local/bin/nbusd
mv nbus-<os>-<arch>  /usr/local/bin/nbus
```

**From source (Bun)** — see [Quick Start](#quick-start) below to run with `bun run`,
or compile a local binary with `scripts/build.sh host`.

**Run as a service** — install `nbusd` as a per-user background service
(systemd `--user` on Linux, launchd on macOS, no sudo):

```bash
nbus-service install    # then: start | stop | restart | status | uninstall
```

Full detail: [Installation wiki](https://github.com/tcsenpai/nbus/wiki/Installation).

## Quick Start

Run straight from source with Bun (dev / from-source path):

```bash
# Install deps (first run only)
bun install

# Start daemon
bun run src/daemon.ts

# In another terminal
bun run src/cli.ts emit deploy done --data '{"version":"1.2.3"}'
bun run src/cli.ts listen deploy done
```

With the installed binaries the same is `nbusd` and `nbus emit ...` / `nbus listen ...`.

## Primitives

| Command | Description |
|---------|-------------|
| `nbus emit <bucket> <event> [--data <json>]` | Fire-and-forget event |
| `nbus listen <bucket> [event]` | Stream events (Ctrl+C to stop) |
| `nbus set <bucket> <key> <value>` | Write shared state |
| `nbus get <bucket> <key>` | Read shared state |
| `nbus watch <bucket> <key>` | Stream state changes |
| `nbus stats` | Server stats |
| `nbus buckets` | List active buckets |

## HTTP API (localhost:7600)

```bash
# Emit  → 204 No Content
curl -X POST http://127.0.0.1:7600/emit/deploy/done -d '{"version":"1.2.3"}'

# State
curl http://127.0.0.1:7600/state/app/version           # GET → {"value":...} | 404
curl -X POST http://127.0.0.1:7600/state/app/version \  # SET → 200 OK
  -d '{"value":"1.2.3"}'

# Streams (SSE)
curl http://127.0.0.1:7600/listen/deploy/done
curl http://127.0.0.1:7600/watch/app/version

# Introspection
curl http://127.0.0.1:7600/stats
curl http://127.0.0.1:7600/buckets
```

## SDKs

nbus ships two official client SDKs. Both wrap the wire protocol (auto-reconnect,
re-subscribe, keepalive) and expose the optional end-to-end crypto layer. They
pass the same shared conformance vectors (`tests/vectors.json` for the wire,
`tests/crypto-vectors.json` for crypto), so they interoperate across languages.

| SDK | Package | Path | Notes |
|-----|---------|------|-------|
| **TypeScript** | `@nbus/client` | [`sdk/typescript/`](sdk/typescript/README.md) | zero runtime deps (`node:crypto`) |
| **Python** | `nbus-client` | [`sdk/python/`](sdk/python/README.md) | `asyncio` + `cryptography`, py3.11+ |

Building for another language? The protocol is text-based and language-agnostic —
see the [SDK Guide](https://github.com/tcsenpai/nbus/wiki/SDK-Guide); the two SDKs
above are its reference implementations.

## SDK Usage

The TypeScript SDK (see [`sdk/typescript/`](sdk/typescript/README.md) for the
published `@nbus/client` package):

```typescript
import { NBus } from "./src/client";

const bus = new NBus();

// Emit
await bus.emit("deploy", "done", { version: "1.2.3" });

// Listen (async generator)
for await (const ev of bus.listen("deploy", "done")) {
  console.log("Deployed:", ev.data);
}

// Shared state
await bus.set("app", "version", "1.2.3");
const v = await bus.get("app", "version");

// Watch state changes
for await (const val of bus.watch("app", "version")) {
  console.log("Version changed:", val);
}

bus.close();
```

The client reconnects automatically (exponential backoff, 100ms → 1s → 10s),
re-subscribes active streams after a reconnect, and PINGs every 30s.

### One-shot helpers (for scripts)

```typescript
import { emit, set, get } from "./src/client";

await emit("deploy", "done", { version: "1.2.3" });
await set("app", "version", "1.2.3");
const v = await get("app", "version");
```

## Wire Protocol

Text-based, line-delimited over a Unix socket (or TCP, when enabled). See
[PROTOCOL.md](PROTOCOL.md) for the full spec.

```
EMIT <bucket> <event> [json]\n   → OK\n
SUB <bucket> <event>\n           → EVENT <bucket> <event> <data>\n (stream)
UNSUB <bucket> [<event>]\n       → OK\n
SET <bucket> <key> <value>\n     → OK\n
GET <bucket> <key>\n             → VALUE <json>\n | NIL\n
WATCH <bucket> <key>\n           → VALUE <json>\n (stream)
UNWATCH <bucket> <key>\n         → OK\n
PING\n                           → PONG\n
STATS\n                          → OK {"buckets":..,"subscriptions":..,"keys":..,"uptime_seconds":..}\n
BUCKETS\n                        → OK ["bucket-a","bucket-b"]\n
```

Building a client in any language = open a socket, send text commands, read lines.

## Configuration

Zero config by default. Optionally drop `~/.config/nbus/config.toml` to tune
socket path, ports, limits, and behavior — or use the `NBUS_SOCKET`,
`NBUS_HTTP_PORT`, `NBUS_TCP_PORT` env overrides. TCP is disabled by default
(`tcp_port = 0`). See [PROTOCOL.md §8](PROTOCOL.md#8-configuration).

## Testing

```bash
bun test
```

Suites: `bus.test.ts`, `src/protocol.test.ts`, `client.test.ts`.

## Architecture

```
┌──────────┐  Unix Socket   ┌─────────┐
│  App A   │── EMIT ───────►│         │
└──────────┘                │         │
┌──────────┐  Unix Socket   │  nbusd  │
│  App B   │── SUB ────────►│ (Bun)   │  in-memory
└──────────┘  ◄─ EVENT ─────│         │  ring buffer
┌──────────┐  HTTP/SSE      │         │
│  curl    │── POST /emit ─►│         │
└──────────┘                └─────────┘
```

- Single Bun process, zero external deps
- In-memory ring buffer (last 64 events per event name, per bucket)
- Unix socket (0600) + HTTP on 127.0.0.1; optional TCP, off by default
- No persistence — everything is lost on restart
- Idle buckets (no subscribers, no keys) auto-expire after 300s
- Local-only, no authentication (v0.1)
