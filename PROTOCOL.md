# nbus — Wire Protocol Specification (v0.1)

> **Goal:** Any language, any app — one HTTP/Unix call to emit, one connection to subscribe.
> This document is the single source of truth for building clients and servers.
>
> **Status:** v0.1 — local-only, no authentication. The transports, limits, TTL
> sweep, config file, and client reconnect behavior described below are all
> **implemented** (see `src/`). Items still marked *(future)* are not.

---

## 1. Overview

nbus is a local-only pub/sub + shared-state daemon. It provides:

| Primitive  | Description                                        |
|------------|----------------------------------------------------|
| **Emit**   | Fire-and-forget event into a named bucket           |
| **Listen** | Subscribe to events from a bucket (streaming)       |
| **Set**    | Write a key/value into a bucket                     |
| **Get**    | Read a key/value from a bucket                      |
| **Watch**  | Subscribe to changes on a key (streaming)           |

All state is **in-memory**. There is no persistence: every bucket, event
buffer, and key/value pair is lost when the daemon restarts.

---

## 2. Transport

### 2.1 Primary: Unix Domain Socket

- Default path: `/tmp/nbus.sock` (override with `socket_path` / `NBUS_SOCKET`)
- Text-based, line-delimited protocol (like Redis RESP simplified)
- One connection = one client session
- Concurrent connections supported
- Socket file is created with mode `0600` (owner only)

### 2.2 HTTP API (localhost only)

- Default port: `7600` (override with `http_port` / `NBUS_HTTP_PORT`)
- Same semantics, REST-ish endpoints
- Bound to `127.0.0.1` only — never exposed externally

### 2.3 Optional: TCP

- Same wire protocol as the Unix socket
- **Off by default** (`tcp_port = 0`). Set `tcp_port` > 0 (or `NBUS_TCP_PORT`)
  to enable; binds `tcp_bind` (default `127.0.0.1`)
- There is no authentication (see §11), so only enable TCP on a trusted host

---

## 3. Wire Protocol (Unix Socket / TCP)

### 3.1 Request Format

Every request is a single UTF-8 line terminated by `\n`:

```
COMMAND [ARGS...]\n
```

Commands are case-insensitive. Arguments are space-separated; the final
argument (a JSON payload or value) may itself contain spaces and is taken
verbatim to end-of-line.

### 3.2 Commands

The full command set is: `EMIT`, `SUB`, `UNSUB`, `SET`, `GET`, `WATCH`,
`UNWATCH`, `PING`, `STATS`, `BUCKETS`.

#### `EMIT <bucket> <event> [json_data]`

Publish an event. When `event` is omitted it defaults to `default`; when
`json_data` is omitted it defaults to `null`. The server replies `OK`.

```
EMIT deploy done {"version":"1.2.3"}
→ OK
```

#### `SUB <bucket> <event>`

Subscribe to events. The server first replays any buffered events for the
matching event name, then streams live events until the client disconnects or
sends `UNSUB`.

```
SUB deploy done
```

Server streams:
```
EVENT deploy done {"version":"1.2.3"}
EVENT deploy done {"version":"1.3.0"}
```

#### `SUB <bucket> *`

Wildcard subscribe — receives ALL events in a bucket (buffered + live). When
the `<event>` argument is omitted it also defaults to `*`.

```
SUB deploy *
```

#### `UNSUB <bucket> [<event>]`

Stop receiving events. Without the event arg, unsubscribes from every event of
that bucket for this client. Replies `OK`.

```
UNSUB deploy done
UNSUB deploy
```

#### `SET <bucket> <key> <value>`

Store a value. The value is stored as a raw JSON token verbatim, so a
subsequent `GET` round-trips it exactly (a client that sends `JSON.stringify(x)`
recovers `x` via `JSON.parse`). Replies `OK`.

```
SET app current-version "1.2.3"
→ OK
```

#### `GET <bucket> <key>`

Read a value.

```
GET app current-version
→ VALUE "1.2.3"
```

Or if not set:
```
NIL
```

#### `WATCH <bucket> <key>`

Stream changes to a key. Fires immediately with the current value (if any),
then again on every SET.

```
WATCH app current-version
```

Server streams:
```
VALUE "1.2.3"
VALUE "1.3.0"
VALUE "2.0.0"
```

#### `UNWATCH <bucket> <key>`

Stop watching a key. Replies `OK`.

#### `PING`

Keepalive. Server responds:
```
PONG
```

#### `STATS`

Server responds with JSON stats:
```
OK {"buckets":3,"subscriptions":5,"keys":12,"uptime_seconds":3421}
```

`subscriptions` counts every active listener (SUB streams + WATCH streams)
across all buckets.

#### `BUCKETS`

Server responds with a JSON array of active bucket names:
```
OK ["deploy","app"]
```

### 3.3 Error Format

```
ERROR <message>
```

Errors are returned for unknown commands, missing required arguments, and limit
violations (payload too large, bucket limit reached, per-client subscription
limit reached):
```
ERROR unknown command
ERROR missing bucket
ERROR max subscriptions reached
ERROR payload too large (300000 > 262144 bytes)
```

### 3.4 Connection Lifecycle

1. Client opens connection
2. Client sends commands (EMIT/SET reply `OK`; a client may fire them without
   blocking on the reply if it drains lines out-of-band)
3. `SUB`/`WATCH` put the connection in **stream mode** for that bucket/key
4. Client can mix regular commands (GET, SET, EMIT) while subscribed
5. Client closes connection → all subscriptions auto-cleaned

---

## 4. HTTP API

All endpoints on `http://127.0.0.1:7600`.

### 4.1 Emit

```
POST /emit/:bucket/:event
Content-Type: application/json

{"version": "1.2.3"}
```

Response: `204 No Content`. An empty body is stored as `null`.

### 4.2 Listen (SSE)

```
GET /listen/:bucket/:event
Accept: text/event-stream
```

Response: Server-Sent Events stream (buffered events first, then live):
```
event: deploy:done
data: {"version":"1.2.3"}

event: deploy:done
data: {"version":"1.3.0"}
```

### 4.3 Set

```
POST /state/:bucket/:key
Content-Type: application/json

{"value": "1.2.3"}
```

The body may be either `{"value": X}` or a bare JSON value; both store the same
underlying token. Response: `200 OK` (plain text body `OK`).

### 4.4 Get

```
GET /state/:bucket/:key
```

Response:
```json
{"value": "1.2.3"}
```

Or `404 Not Found` (`{"error":"not found"}`) if the key is unset.

### 4.5 Watch (SSE)

```
GET /watch/:bucket/:key
Accept: text/event-stream
```

Response: SSE stream of value changes (`data: <json>`), starting with the
current value if one exists.

### 4.6 Stats

```
GET /stats
```

Response:
```json
{"buckets": 3, "subscriptions": 5, "keys": 12, "uptime_seconds": 3421}
```

### 4.7 Buckets

```
GET /buckets
```

Response: JSON array of active bucket names.
```json
["deploy", "app"]
```

### 4.8 Wildcard Listen

```
GET /listen/:bucket
```

Receives all events in the bucket (equivalent to `SUB <bucket> *`).

### 4.9 HTTP Error Codes

- `400 Bad Request` — missing bucket/key in the path
- `404 Not Found` — unknown route, or `GET /state` on an unset key
- `413 Payload Too Large` — value exceeds `max_payload_bytes`
- `429 Too Many Requests` — `max_buckets` reached

---

## 5. Bucket & Key Naming

- Recommended characters: `a-z`, `A-Z`, `0-9`, `-`, `_`, `/`
- Case-sensitive
- Bucket/event `*` is reserved as the subscribe wildcard

These are conventions, not enforced constraints. The daemon does not currently
validate names or impose a length limit; the only special token is `*` in a
subscribe filter.

---

## 6. Data Format

- All event payloads and state values are **JSON**
- Strings, numbers, booleans, null, objects, arrays — all valid
- Max payload size: 256 KB (`max_payload_bytes`, 262144 bytes) per event/value,
  measured as UTF-8 bytes; exceeding it yields `ERROR` / HTTP `413`
- Empty payload is valid (stored as `null`) — useful for signal-only events

---

## 7. Server Behavior

### 7.1 Buffering

- Each bucket keeps the last **64 events per event name** in a ring buffer
  (`buffer_size`, configurable). The buffer is keyed per event name, not shared
  across the whole bucket
- New subscribers receive buffered events first, then the live stream
- A wildcard `SUB *` replay flattens the per-event buffers of that bucket

### 7.2 Fan-out

- One EMIT fans out to all current subscribers of that bucket/event
- Wildcard `*` subscribers receive all events in the bucket
- No delivery guarantees — a failed socket write is swallowed
  (`slow_client_policy`, default `drop`)

### 7.3 State

- Key/value store is per-bucket
- Keys persist until overwritten or the daemon restarts
- WATCH fires on every SET; when `watch_on_equal = false`, a SET that stores the
  same value as before does not fire

### 7.4 Cleanup

- A bucket is idle when it has no subscribers, no watchers, and no keys. Idle
  buckets are swept once their last activity is older than the TTL
  (`bucket_ttl_seconds`, default 300s). The sweep runs every 30s
- Subscriptions auto-clean on disconnect

---

## 8. Configuration

The daemon reads `~/.config/nbus/config.toml` (the file and every field are
optional; missing values fall back to the defaults shown below):

```toml
[server]
socket_path = "/tmp/nbus.sock"
http_port = 7600
tcp_port = 0          # 0 = disabled
tcp_bind = "127.0.0.1"

[limits]
max_buckets = 1024
max_subscriptions_per_client = 64
max_payload_bytes = 262144    # 256 KB
buffer_size = 64              # events per event name, per bucket
bucket_ttl_seconds = 300

[behavior]
watch_on_equal = true         # fire WATCH even if value unchanged
slow_client_policy = "drop"   # "drop" or "block"
```

> **TOML subset:** the daemon ships a minimal built-in parser that supports only
> the flat `[section] key = value` form used above — the `server`, `limits`, and
> `behavior` sections with scalar string / integer / boolean values and `#` line
> comments. Nested tables, arrays, dotted keys, and multiline strings are **not**
> supported. Malformed input fails loudly at startup.

### 8.1 Environment Overrides

Applied *after* the TOML file, so env wins:

| Variable         | Overrides            |
|------------------|----------------------|
| `NBUS_SOCKET`    | `server.socket_path` |
| `NBUS_HTTP_PORT` | `server.http_port`   |
| `NBUS_TCP_PORT`  | `server.tcp_port`    |

---

## 9. SDK Guide

To implement a client library for any language, you need:

### 9.1 Minimum Viable Client

1. **Connect** to the Unix socket (or use HTTP)
2. **emit(bucket, event, data)** → send `EMIT <bucket> <event> <json>\n`
3. **listen(bucket, event)** → send `SUB <bucket> <event>\n`, read lines, parse `EVENT`
4. **set(bucket, key, value)** → send `SET <bucket> <key> <json>\n`, read `OK`
5. **get(bucket, key)** → send `GET <bucket> <key>\n`, parse `VALUE` or `NIL`
6. **watch(bucket, key)** → send `WATCH <bucket> <key>\n`, read `VALUE` lines as a stream
7. **close()** → close the socket

### 9.2 Connection Handling

The reference TypeScript client (`src/client.ts`) implements this and can be
used as a template:

- Reconnect on connection loss with exponential backoff (100ms → 1s → 10s max)
- Re-subscribe all active SUB/WATCH streams after a reconnect
- PING every 30s for keepalive

### 9.3 Async Pattern

Most languages benefit from an async iterator pattern:

```javascript
for await (const event of bus.listen("deploy", "done")) {
    handle(event);
}
```

### 9.4 Sync Pattern

For simple one-shot scripts, helpers that open a connection, run one command,
and close are convenient (see the `emit` / `set` / `get` helpers in
`src/client.ts`).

---

## 10. CLI Tool

The `nbus` CLI (`src/cli.ts`) mirrors all primitives:

```bash
# Emit an event
nbus emit deploy done --data '{"version":"1.2.3"}'

# Listen to events (streaming, Ctrl+C to stop)
nbus listen deploy done

# Set/get state
nbus set app current-version "1.2.3"
nbus get app current-version

# Watch state changes
nbus watch app current-version

# Stats and bucket list (served over HTTP)
nbus stats
nbus buckets
```

`emit`/`listen`/`set`/`get`/`watch` use the Unix socket; `stats`/`buckets`
query the HTTP endpoints on `NBUS_HTTP_PORT` (default 7600).

---

## 11. Security

- Unix socket permissions: `0600` (owner only)
- HTTP is bound to `127.0.0.1` — never exposed externally
- TCP, when enabled, binds `tcp_bind` (default `127.0.0.1`)
- **No authentication** in v0.1 — this is a local-only tool by design
- *(future)* optional token auth for TCP connections

---

## 12. Versioning

- v0.1: no protocol negotiation, assume latest
- *(future)* protocol version negotiated on connect
- Breaking changes bump the minor version
