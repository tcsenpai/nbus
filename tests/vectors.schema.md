# nbus conformance vectors — schema

`tests/vectors.json` is a **language-agnostic** conformance spec for the nbus
line protocol (see `Wire-Protocol.md`). It is pure data so a runner in any
language (TypeScript, Python, Go, Rust, ...) can execute it against a real
daemon. `tests/conformance.test.ts` is the reference (Bun) runner.

The file is a JSON **array of vector objects**. The first element is a doc-only
object named `_README` (skip any vector whose `name` starts with `_`).

## Vector

```jsonc
{
  "name": "set-get-object-roundtrip",   // unique id; becomes the test() name
  "description": "human-readable intent",
  "steps": [ /* Step[] */ ]
}
```

Vectors are grouped by `name` prefix: `emit-*`, `sub`/`unsub-*`, `set-*`/`get-*`,
`watch-*`/`unwatch-*`, `ping-*`, `stats-*`, `buckets-*`, `error-*`, `framing-*`.

Each vector uses **bucket names unique to that vector**. Daemon state (buckets,
keys, subscriptions) is process-global, so unique buckets keep vectors from
cross-contaminating. Assertions over global state (STATS, BUCKETS) therefore use
regex `matches`, never exact counts.

## Step

A step sends one line on a connection and (usually) asserts the next response
line from that same connection.

```jsonc
{
  "conn": 0,                 // OPTIONAL, default 0. Routes the step to a numbered
                             // connection. Multiple conns model streaming: e.g.
                             // conn 1 SUBs, conn 0 EMITs, conn 1 receives EVENT.
  "send": "GET app cfg",     // the command line WITHOUT trailing "\n"
                             //   (the runner appends "\n").
  "expect": { /* Matcher */ } // OPTIONAL. Omit for fire-and-forget (the runner
                             //   sends the line and does not read a reply).
}
```

### `send` vs `send_repeat`

Exactly one of `send` or `send_repeat` is present per step (unless the step is a
pure assertion — see the streaming note below).

- `send`: the literal command line (no trailing newline).
- `send_repeat`: builds a huge line without embedding it literally in JSON:

  ```jsonc
  "send_repeat": {
    "prefix": "SET oversized k \"",
    "fill": "a",       // single char repeated `count` times
    "count": 300000,
    "suffix": "\""
  }
  ```

  The runner constructs `prefix + fill.repeat(count) + suffix`. Used by the
  oversized-payload vector so the file stays small and no special daemon config
  is needed (300000 > default max_payload_bytes 262144).

### Pure-assertion steps (streaming)

A step MAY have `expect` but **no `send`** — it asserts the next line that
arrives on `conn` from a stream opened by an earlier step (e.g. after a peer
EMIT/SET). This models `SUB`/`WATCH` delivery across connections.

## Matcher

A step's `expect` is exactly one of:

| Matcher                         | Meaning                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `{ "equals": "<line>" }`        | Next response line equals this string exactly (no trailing `\n`).       |
| `{ "matches": "<regex>" }`      | Next response line matches this JavaScript/PCRE-style regex.            |
| `{ "silent": true }`            | NO line arrives on `conn` within the drain window (~200ms). Proves that UNSUB/UNWATCH stopped delivery, or that WATCH on an unset key emits nothing immediately. |

Runners in other languages map `matches` to their native regex engine. The
regexes used here are portable (anchors, `\d`, `.*`, escaped `{ } [ ]`).

## Runner responsibilities (contract)

A conforming runner MUST:

1. Boot the real daemon on a private Unix socket + unused HTTP port.
2. Open connections lazily per `conn` index; send `send`/`send_repeat` lines
   with a trailing `\n`.
3. Read responses with a **single-consumer FIFO line buffer** (split on `\n`),
   matching the reference client's delivery model, so a `SET`'s `OK` is never
   misassigned to a later `GET`.
4. For `equals`/`matches`: read the next line on `conn` (bounded wait) and
   assert. For `silent`: wait the drain window and assert no line arrived.
5. Run against the **default** daemon config (no special limits needed).

## Framing note (not a vector)

The `framing-escaped-newline-roundtrips` vector sends a JSON string containing
the two characters `\` `n` (an *escaped* newline). That round-trips fine. A
**literal** newline inside a payload is NOT representable — it would split the
line and break framing — so it is intentionally not a vector: the transport
cannot carry it. SDK authors MUST emit compact single-line JSON.
