"""Async NBus client over a Unix domain socket.

Line delivery is *single-consumer*: one asyncio reader task drains complete
lines (split on ``\\n``) from the socket into an internal FIFO. Response-awaiting
calls (``set``/``get``/``ping``/``stats``/``buckets``) and streaming generators
(``listen``/``watch``) all pull from that same FIFO in order via
:meth:`NBus._read_line`. This guarantees exactly-once, in-order delivery so a
``SET``'s ``OK`` can never be misassigned to a later ``GET`` — mirroring the
reference TypeScript client (``src/client.ts``).
"""

from __future__ import annotations

import asyncio
import json
from types import TracebackType
from typing import Any, AsyncGenerator, Optional

__all__ = ["NBus"]

BACKOFF_START_MS = 100
BACKOFF_MAX_MS = 10_000
PING_INTERVAL_S = 30.0

# Reserved bucket for the (pure-convention) key-discovery layer. Kept here so the
# crypto layer (task #16) can build on it without touching transport code.
KEYS_BUCKET = "_keys"


def _dumps(value: Any) -> str:
    """Serialize to compact single-line JSON (framing = one line per message)."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


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

    async def emit(self, bucket: str, event: str, data: Any = None) -> None:
        """Fire-and-forget an event into ``bucket`` under ``event``."""
        payload = _dumps(data)
        await self._write(f"EMIT {bucket} {event} {payload}\n")

    async def set(self, bucket: str, key: str, value: Any) -> None:
        """Store ``value`` (as a raw JSON token) at ``bucket``/``key``."""
        await self._write(f"SET {bucket} {key} {_dumps(value)}\n")
        resp = await self._read_line()
        if resp.strip() != "OK":
            raise RuntimeError(f"SET failed: {resp}")

    async def get(self, bucket: str, key: str) -> Any:
        """Read ``bucket``/``key``. Returns the parsed value, or ``None`` if unset."""
        await self._write(f"GET {bucket} {key}\n")
        resp = await self._read_line()
        if resp == "NIL":
            return None
        if resp.startswith("VALUE "):
            return json.loads(resp[6:])
        raise RuntimeError(f"GET failed: {resp}")

    async def listen(
        self, bucket: str, event: str = "*"
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Async-iterate events. Yields ``{"bucket", "event", "data"}`` dicts."""
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
                yield {
                    "bucket": rest[:sp1],
                    "event": rest[sp1 + 1 : sp2],
                    "data": json.loads(rest[sp2 + 1 :]),
                }
        finally:
            self._active_subs.discard(sub)

    async def watch(
        self, bucket: str, key: str
    ) -> AsyncGenerator[Any, None]:
        """Async-iterate value changes for ``bucket``/``key``. Yields parsed values."""
        sub = _WatchSub(bucket, key)
        writer = await self._ensure_connected()
        self._active_subs.add(sub)
        try:
            writer.write(sub.wire().encode("utf-8"))
            await writer.drain()
            while not self._closed:
                line = await self._read_line()
                if line.startswith("VALUE "):
                    yield json.loads(line[6:])
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
