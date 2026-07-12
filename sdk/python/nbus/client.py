"""Async NBus client over a Unix domain socket.

Line delivery is *single-consumer*: one asyncio reader task drains complete
lines (split on ``\\n``) from the socket into an internal FIFO. Response-awaiting
calls (``set``/``get``/``ping``/``stats``/``buckets``) and streaming generators
(``listen``/``watch``) all pull from that same FIFO in order via
:meth:`NBus._read_line`. This guarantees exactly-once, in-order delivery so a
``SET``'s ``OK`` can never be misassigned to a later ``GET`` — mirroring the
reference TypeScript client (``src/client.ts``).

Optional end-to-end crypto (CRYPTO.md v0.1) is wired in via per-call options:
``emit``/``set`` take ``sign``/``encrypt_to`` (outbound envelopes), and
``listen``/``get``/``watch`` take ``verify``/``decrypt_with`` (fail-closed
inbound). With no options the paths are byte-for-byte identical to the
pre-crypto behavior (backward compatible).
"""

from __future__ import annotations

import asyncio
import json
import time
from types import TracebackType
from typing import Any, AsyncGenerator, Callable, Optional

from .crypto import (
    Ed25519Keypair,
    X25519Keypair,
    decrypt,
    encrypt_to,
    envelope_kind,
    seal_signed_encrypted,
    sign as _sign,
    verify_signed,
)

__all__ = ["NBus"]

BACKOFF_START_MS = 100
BACKOFF_MAX_MS = 10_000
PING_INTERVAL_S = 30.0

# Reserved bucket for the (pure-convention) key-discovery layer, CRYPTO.md §5.
KEYS_BUCKET = "_keys"

# Verify predicate: (pub, envelope) -> bool. Falsy return rejects the message.
VerifyPredicate = Callable[[str, dict[str, Any]], bool]


def _dumps(value: Any) -> str:
    """Serialize to compact single-line JSON (framing = one line per message)."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _apply_send_crypto(
    data: Any,
    sign: Optional[Ed25519Keypair],
    encrypt_to_pub: Optional[str],
) -> Any:
    """Apply outbound crypto options, returning the wire value to send.

    With no options the input is returned unchanged (plain path, byte-for-byte).
    Both options → sign-then-encrypt; ``sign`` only → ``s1``; ``encrypt_to``
    only → ``e1``.
    """
    if sign is None and encrypt_to_pub is None:
        return data
    if sign is not None and encrypt_to_pub is not None:
        return seal_signed_encrypted(data, sign, encrypt_to_pub)
    if sign is not None:
        return _sign(data, sign)
    return encrypt_to(data, encrypt_to_pub)  # type: ignore[arg-type]


def _resolve_recv_crypto(
    value: Any,
    verify: Optional[VerifyPredicate],
    decrypt_with: Optional[X25519Keypair],
    max_skew_seconds: Optional[float],
    has_opts: bool,
) -> dict[str, Any]:
    """Resolve an inbound wire value into cleartext + metadata, fail-closed.

    Returns a dict with either ``data`` (accepted) or ``error`` (rejected), plus
    optional ``signed_by``/``encrypted``/``raw``. With no recv options the value
    passes through verbatim as ``data`` (opt-out, backward compatible).
    """
    if not has_opts:
        return {"data": value}

    kind = envelope_kind(value)
    if kind is None:
        # Plain payload, even under recv opts → deliver as-is.
        return {"data": value}

    if kind == "s1":
        if verify is None:
            return {"error": "signed payload but no verify predicate", "raw": value}
        ver = verify_signed(value, max_skew_seconds)
        if not ver.ok:
            return {"error": f"verify: {ver.reason}", "raw": value}
        if not verify(ver.pub, value):
            return {"error": "verify predicate rejected signer", "raw": value}
        return {"data": ver.payload, "signed_by": ver.pub}

    # kind == "e1"
    if decrypt_with is None:
        return {"error": "encrypted payload but no decrypt_with key", "raw": value}
    dec = decrypt(value, decrypt_with)
    if not dec.ok:
        return {"error": f"decrypt: {dec.reason}", "raw": value}

    # Sign-then-encrypt: inner s1 must also verify (still fail-closed).
    if envelope_kind(dec.payload) == "s1":
        inner = dec.payload
        if verify is None:
            return {
                "error": "sealed signed payload but no verify predicate",
                "encrypted": True,
                "raw": value,
            }
        ver = verify_signed(inner, max_skew_seconds)
        if not ver.ok:
            return {"error": f"verify: {ver.reason}", "encrypted": True, "raw": value}
        if not verify(ver.pub, inner):
            return {
                "error": "verify predicate rejected signer",
                "encrypted": True,
                "raw": value,
            }
        return {"data": ver.payload, "signed_by": ver.pub, "encrypted": True}

    return {"data": dec.payload, "encrypted": True}


def _parse_key_record(v: Any) -> Optional[dict[str, Any]]:
    """Validate an unknown value as a KeyRecord. Shape check only (not trust)."""
    if not isinstance(v, dict):
        return None
    ts = v.get("ts")
    if not isinstance(ts, (int, float)) or isinstance(ts, bool):
        return None
    sign = v.get("sign")
    box = v.get("box")
    has_sign = isinstance(sign, str)
    has_box = isinstance(box, str)
    if sign is not None and not has_sign:
        return None
    if box is not None and not has_box:
        return None
    if not has_sign and not has_box:
        return None
    rec: dict[str, Any] = {"ts": ts}
    if has_sign:
        rec["sign"] = sign
    if has_box:
        rec["box"] = box
    return rec


def _pub_of(k: Any) -> Optional[str]:
    """Extract a base64url public key from a Keypair or raw string; None passes."""
    if k is None:
        return None
    if isinstance(k, str):
        return k
    return k.public_key_b64


class _ListenSub:
    """A tracked SUB stream, re-sent transparently after a reconnect."""

    __slots__ = ("bucket", "event")

    def __init__(self, bucket: str, event: str) -> None:
        self.bucket = bucket
        self.event = event

    def wire(self) -> str:
        return f"SUB {self.bucket} {self.event}\n"


class _WatchSub:
    """A tracked WATCH stream, re-sent transparently after a reconnect."""

    __slots__ = ("bucket", "key")

    def __init__(self, bucket: str, key: str) -> None:
        self.bucket = bucket
        self.key = key

    def wire(self) -> str:
        return f"WATCH {self.bucket} {self.key}\n"


class NBus:
    """Async client for the local nbus IPC daemon.

    Example::

        async with NBus() as bus:
            await bus.set("app", "version", "1.2.3")
            print(await bus.get("app", "version"))
            async for event in bus.listen("deploy", "done"):
                handle(event)
    """

    def __init__(self, socket_path: str = "/tmp/nbus.sock") -> None:
        self._path = socket_path
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None

        # Complete lines drained from the socket, not yet consumed by a reader.
        self._line_queue: asyncio.Queue[str] = asyncio.Queue()
        # Callers awaiting a line while the queue is empty. FIFO with _line_queue.
        self._waiters: list[asyncio.Future[str]] = []

        # Subscriptions to re-send after a reconnect.
        self._active_subs: set[_ListenSub | _WatchSub] = set()

        self._connected = False
        self._closed = False
        self._connect_lock = asyncio.Lock()
        self._reader_task: Optional[asyncio.Task[None]] = None
        self._ping_task: Optional[asyncio.Task[None]] = None

    # ------------------------------------------------------------------ #
    # Line delivery (single consumer path)
    # ------------------------------------------------------------------ #

    def _deliver(self, line: str) -> None:
        """Hand a complete line to the oldest waiter, or queue it FIFO."""
        while self._waiters:
            fut = self._waiters.pop(0)
            if not fut.done():
                fut.set_result(line)
                return
        self._line_queue.put_nowait(line)

    async def _read_line(self) -> str:
        """Pull the next line from the FIFO, or wait for one to arrive."""
        try:
            return self._line_queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        fut: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._waiters.append(fut)
        return await fut

    async def _reader_loop(self, reader: asyncio.StreamReader) -> None:
        """Drain the socket into complete lines until it closes/errors."""
        try:
            while True:
                raw = await reader.readline()
                if not raw:  # EOF
                    break
                # readline() keeps the trailing \n; strip exactly it.
                self._deliver(raw.decode("utf-8").rstrip("\n"))
        except (ConnectionError, OSError):
            pass
        finally:
            self._handle_disconnect()

    # ------------------------------------------------------------------ #
    # Connection management
    # ------------------------------------------------------------------ #

    async def _ensure_connected(self) -> asyncio.StreamWriter:
        if self._writer is not None and self._connected:
            return self._writer
        async with self._connect_lock:
            if self._writer is not None and self._connected:
                return self._writer
            return await self._connect_with_backoff()

    async def _connect_with_backoff(self) -> asyncio.StreamWriter:
        delay = BACKOFF_START_MS / 1000
        while not self._closed:
            try:
                reader, writer = await asyncio.open_unix_connection(self._path)
            except (ConnectionError, OSError, FileNotFoundError):
                if self._closed:
                    break
                await asyncio.sleep(delay)
                delay = min(delay * 10, BACKOFF_MAX_MS / 1000)
                continue
            self._reader = reader
            self._writer = writer
            self._connected = True
            self._reader_task = asyncio.create_task(self._reader_loop(reader))
            self._start_keepalive()
            self._resubscribe()
            return writer
        raise ConnectionError("nbus client closed")

    def _handle_disconnect(self) -> None:
        if not self._connected and self._writer is None:
            return
        self._connected = False
        self._writer = None
        self._reader = None
        self._stop_keepalive()
        if self._closed:
            return
        # Trigger a background reconnect; parked _read_line waiters are preserved
        # and satisfied once the re-subscribed stream resumes.
        asyncio.ensure_future(self._reconnect_bg())

    async def _reconnect_bg(self) -> None:
        try:
            await self._ensure_connected()
        except ConnectionError:
            pass  # closed during reconnect

    def _start_keepalive(self) -> None:
        self._stop_keepalive()
        self._ping_task = asyncio.create_task(self._keepalive_loop())

    def _stop_keepalive(self) -> None:
        if self._ping_task is not None:
            self._ping_task.cancel()
            self._ping_task = None

    async def _keepalive_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(PING_INTERVAL_S)
                writer = self._writer
                if writer is not None and self._connected:
                    try:
                        writer.write(b"PING\n")
                        await writer.drain()
                    except (ConnectionError, OSError):
                        self._handle_disconnect()
                        return
        except asyncio.CancelledError:
            pass

    def _resubscribe(self) -> None:
        """Re-send every tracked subscription after a (re)connect."""
        writer = self._writer
        if writer is None:
            return
        for sub in self._active_subs:
            writer.write(sub.wire().encode("utf-8"))

    async def _write(self, line: str) -> asyncio.StreamWriter:
        writer = await self._ensure_connected()
        writer.write(line.encode("utf-8"))
        await writer.drain()
        return writer

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    async def emit(
        self,
        bucket: str,
        event: str,
        data: Any = None,
        *,
        sign: Optional[Ed25519Keypair] = None,
        encrypt_to: Optional[str] = None,
    ) -> None:
        """Fire-and-forget an event into ``bucket`` under ``event``.

        With ``sign``/``encrypt_to`` the payload is wrapped in an ``s1``/``e1``
        (or sign-then-encrypt) envelope before hitting the wire; without them the
        plain payload is byte-for-byte identical to the pre-crypto path.
        """
        wire = _apply_send_crypto(data, sign, encrypt_to)
        await self._write(f"EMIT {bucket} {event} {_dumps(wire)}\n")

    async def set(
        self,
        bucket: str,
        key: str,
        value: Any,
        *,
        sign: Optional[Ed25519Keypair] = None,
        encrypt_to: Optional[str] = None,
    ) -> None:
        """Store ``value`` (as a raw JSON token) at ``bucket``/``key``.

        Accepts the same ``sign``/``encrypt_to`` outbound crypto options as
        :meth:`emit`.
        """
        wire = _apply_send_crypto(value, sign, encrypt_to)
        await self._write(f"SET {bucket} {key} {_dumps(wire)}\n")
        resp = await self._read_line()
        if resp.strip() != "OK":
            raise RuntimeError(f"SET failed: {resp}")

    async def get(
        self,
        bucket: str,
        key: str,
        *,
        verify: Optional[VerifyPredicate] = None,
        decrypt_with: Optional[X25519Keypair] = None,
        max_skew_seconds: float = 300,
    ) -> Any:
        """Read ``bucket``/``key``. Returns the parsed value, or ``None`` if unset.

        With no recv crypto options this returns the bare value (back-compat).
        With any recv option it returns a ``GetResult`` dict:
        ``{"data", "signed_by", "encrypted", "error", "raw"}`` (fail-closed).
        """
        has_opts = verify is not None or decrypt_with is not None
        await self._write(f"GET {bucket} {key}\n")
        resp = await self._read_line()
        if resp == "NIL":
            raw: Any = None
        elif resp.startswith("VALUE "):
            raw = json.loads(resp[6:])
        else:
            raise RuntimeError(f"GET failed: {resp}")

        if not has_opts:
            return raw
        if raw is None:
            return {"data": None}
        r = _resolve_recv_crypto(raw, verify, decrypt_with, max_skew_seconds, True)
        out: dict[str, Any] = {"data": r.get("data")}
        for f in ("signed_by", "encrypted", "error", "raw"):
            if f in r:
                out[f] = r[f]
        return out

    async def listen(
        self,
        bucket: str,
        event: str = "*",
        *,
        verify: Optional[VerifyPredicate] = None,
        decrypt_with: Optional[X25519Keypair] = None,
        max_skew_seconds: float = 300,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Async-iterate events. Yields ``{"bucket", "event", "data", ...}`` dicts.

        With no recv crypto options each item is ``{"bucket", "event", "data"}``
        (back-compat). With any recv option, enveloped items are verified/
        decrypted fail-closed and carry ``signed_by``/``encrypted``/``error``/
        ``raw`` metadata mirroring the TS delivery shape.
        """
        has_opts = verify is not None or decrypt_with is not None
        sub = _ListenSub(bucket, event)
        # Connect BEFORE tracking the sub so the connect-time _resubscribe()
        # cannot also emit it (which would double-fire buffered replay).
        writer = await self._ensure_connected()
        self._active_subs.add(sub)
        try:
            writer.write(sub.wire().encode("utf-8"))
            await writer.drain()
            while not self._closed:
                line = await self._read_line()
                if not line.startswith("EVENT "):
                    continue
                rest = line[6:]
                sp1 = rest.find(" ")
                sp2 = rest.find(" ", sp1 + 1)
                if sp1 == -1 or sp2 == -1:
                    continue
                ev_bucket = rest[:sp1]
                ev_event = rest[sp1 + 1 : sp2]
                value = json.loads(rest[sp2 + 1 :])

                if not has_opts:
                    yield {"bucket": ev_bucket, "event": ev_event, "data": value}
                    continue

                r = _resolve_recv_crypto(
                    value, verify, decrypt_with, max_skew_seconds, True
                )
                item: dict[str, Any] = {"bucket": ev_bucket, "event": ev_event}
                for f in ("data", "signed_by", "encrypted", "error", "raw"):
                    if f in r:
                        item[f] = r[f]
                yield item
        finally:
            self._active_subs.discard(sub)

    async def watch(
        self,
        bucket: str,
        key: str,
        *,
        verify: Optional[VerifyPredicate] = None,
        decrypt_with: Optional[X25519Keypair] = None,
        max_skew_seconds: float = 300,
    ) -> AsyncGenerator[Any, None]:
        """Async-iterate value changes for ``bucket``/``key``.

        With no recv crypto options yields the parsed value (back-compat). With
        any recv option yields a ``WatchItem`` dict
        (``{"data", "signed_by", "encrypted", "error", "raw"}``), fail-closed.
        """
        has_opts = verify is not None or decrypt_with is not None
        sub = _WatchSub(bucket, key)
        writer = await self._ensure_connected()
        self._active_subs.add(sub)
        try:
            writer.write(sub.wire().encode("utf-8"))
            await writer.drain()
            while not self._closed:
                line = await self._read_line()
                if not line.startswith("VALUE "):
                    continue
                value = json.loads(line[6:])
                if not has_opts:
                    yield value
                    continue
                r = _resolve_recv_crypto(
                    value, verify, decrypt_with, max_skew_seconds, True
                )
                item: dict[str, Any] = {}
                for f in ("data", "signed_by", "encrypted", "error", "raw"):
                    if f in r:
                        item[f] = r[f]
                yield item
        finally:
            self._active_subs.discard(sub)

    async def unsub(self, bucket: str, event: Optional[str] = None) -> None:
        """Stop a SUB stream. Without ``event``, unsubscribes the whole bucket."""
        line = f"UNSUB {bucket} {event}\n" if event is not None else f"UNSUB {bucket}\n"
        await self._write(line)
        resp = await self._read_line()
        if resp.strip() != "OK":
            raise RuntimeError(f"UNSUB failed: {resp}")

    async def unwatch(self, bucket: str, key: str) -> None:
        """Stop watching ``bucket``/``key``."""
        await self._write(f"UNWATCH {bucket} {key}\n")
        resp = await self._read_line()
        if resp.strip() != "OK":
            raise RuntimeError(f"UNWATCH failed: {resp}")

    async def ping(self) -> str:
        """Keepalive round-trip. Returns ``"PONG"``."""
        await self._write("PING\n")
        return await self._read_line()

    async def stats(self) -> dict[str, Any]:
        """Server stats. Parses the ``OK <json>`` reply into a dict."""
        await self._write("STATS\n")
        resp = await self._read_line()
        if not resp.startswith("OK "):
            raise RuntimeError(f"STATS failed: {resp}")
        return json.loads(resp[3:])

    async def buckets(self) -> list[str]:
        """Active bucket names. Parses the ``OK <json>`` reply into a list."""
        await self._write("BUCKETS\n")
        resp = await self._read_line()
        if not resp.startswith("OK "):
            raise RuntimeError(f"BUCKETS failed: {resp}")
        return json.loads(resp[3:])

    # ------------------------------------------------------------------ #
    # Key-discovery convention (CRYPTO.md §5) — pure bus state, TOFU.
    # ------------------------------------------------------------------ #

    async def publish_keys(
        self,
        name: str,
        sign: Any = None,
        box: Any = None,
    ) -> None:
        """Publish a key record to ``_keys/<name>`` (``SET``). Stamps ``ts=now``.

        ``sign``/``box`` accept a Keypair or a raw base64url public-key string.
        At least one must be supplied. TOFU convention — publishing asserts
        nothing; verify fingerprints out-of-band.
        """
        sign_pub = _pub_of(sign)
        box_pub = _pub_of(box)
        if sign_pub is None and box_pub is None:
            raise ValueError("publish_keys: at least one of sign/box is required")
        record: dict[str, Any] = {"ts": int(time.time())}
        if sign_pub is not None:
            record["sign"] = sign_pub
        if box_pub is not None:
            record["box"] = box_pub
        await self.set(KEYS_BUCKET, name, record)

    async def fetch_keys(self, name: str) -> Optional[dict[str, Any]]:
        """Fetch the published key record for ``name`` (``GET _keys <name>``).

        Returns ``None`` if unset; raises on a structurally malformed record
        (corruption / hostile overwrite, not a miss). TOFU — asserts no trust.
        """
        raw = await self.get(KEYS_BUCKET, name)
        if raw is None:
            return None
        rec = _parse_key_record(raw)
        if rec is None:
            raise RuntimeError(f"fetch_keys: malformed key record for {name!r}")
        return rec

    async def watch_keys(self, name: str) -> AsyncGenerator[dict[str, Any], None]:
        """Watch ``_keys/<name>`` for rotation, yielding each valid record.

        Malformed records are SKIPPED silently (surfacing them as an exception
        would tear down the long-lived watch). TOFU — asserts no trust.
        """
        async for value in self.watch(KEYS_BUCKET, name):
            rec = _parse_key_record(value)
            if rec is not None:
                yield rec

    def close(self) -> None:
        """Close the connection and release any parked readers/generators."""
        self._closed = True
        self._stop_keepalive()
        self._active_subs.clear()
        if self._reader_task is not None:
            self._reader_task.cancel()
            self._reader_task = None
        writer = self._writer
        if writer is not None:
            try:
                writer.close()
            except (ConnectionError, OSError):
                pass
        self._writer = None
        self._reader = None
        self._connected = False
        # Release parked waiters so awaiting generators can settle.
        waiters, self._waiters = self._waiters, []
        for fut in waiters:
            if not fut.done():
                fut.set_result("")

    # ------------------------------------------------------------------ #
    # Async context manager
    # ------------------------------------------------------------------ #

    async def __aenter__(self) -> "NBus":
        return self

    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> None:
        self.close()
