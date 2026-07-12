"""Wire conformance + API tests against a live Bun nbus daemon.

Ports tests/conformance.test.ts: boots the REAL daemon as a subprocess on a
private Unix socket, then replays every vector in tests/vectors.json using a
single-consumer FIFO line reader per connection (so a SET's OK is never
misassigned to a later GET). Also exercises the ergonomic NBus class.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Iterator, Optional

import pytest

# Repo root = .../nbus (three levels up: tests/ -> python/ -> sdk/ -> nbus)
REPO_ROOT = Path(__file__).resolve().parents[3]
VECTORS_PATH = REPO_ROOT / "tests" / "vectors.json"
DAEMON_ENTRY = REPO_ROOT / "src" / "daemon.ts"

SOCKET_PATH = f"/tmp/nbus-py-{os.getpid()}.sock"
HTTP_PORT = 17600 + (os.getpid() % 1000)
READ_TIMEOUT_S = 1.5
DRAIN_S = 0.2


# --------------------------------------------------------------------------- #
# Single-consumer FIFO connection (mirrors the reference runner's Conn)
# --------------------------------------------------------------------------- #


class Conn:
    """A raw socket connection with a single-consumer FIFO line reader."""

    def __init__(self, reader: asyncio.StreamReader,
                 writer: asyncio.StreamWriter) -> None:
        self._reader = reader
        self._writer = writer
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._waiters: list[asyncio.Future[Optional[str]]] = []
        self._task = asyncio.create_task(self._drain())

    @classmethod
    async def open(cls, socket_path: str) -> "Conn":
        reader, writer = await asyncio.open_unix_connection(socket_path)
        return cls(reader, writer)

    async def _drain(self) -> None:
        try:
            while True:
                raw = await self._reader.readline()
                if not raw:
                    break
                line = raw.decode("utf-8").rstrip("\n")
                if self._waiters:
                    fut = self._waiters.pop(0)
                    if not fut.done():
                        fut.set_result(line)
                        continue
                self._queue.put_nowait(line)
        except (ConnectionError, OSError):
            pass

    def send(self, line: str) -> None:
        self._writer.write((line + "\n").encode("utf-8"))

    async def read_line(self, timeout: float) -> Optional[str]:
        try:
            return self._queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        fut: asyncio.Future[Optional[str]] = asyncio.get_running_loop().create_future()
        self._waiters.append(fut)
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            if fut in self._waiters:
                self._waiters.remove(fut)
            return None

    def close(self) -> None:
        self._task.cancel()
        try:
            self._writer.close()
        except (ConnectionError, OSError):
            pass


# --------------------------------------------------------------------------- #
# Daemon lifecycle (module-scoped)
# --------------------------------------------------------------------------- #


def _boot_daemon() -> subprocess.Popen[bytes]:
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    env = {
        **os.environ,
        "NBUS_SOCKET": SOCKET_PATH,
        "NBUS_HTTP_PORT": str(HTTP_PORT),
        "NBUS_TCP_PORT": "0",
    }
    proc = subprocess.Popen(
        ["bun", "run", str(DAEMON_ENTRY)],
        env=env,
        cwd=str(REPO_ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 3.0
    while not os.path.exists(SOCKET_PATH):
        if proc.poll() is not None:
            raise RuntimeError("daemon exited before creating socket")
        if time.time() > deadline:
            proc.kill()
            raise RuntimeError("daemon did not create socket in time")
        time.sleep(0.025)
    time.sleep(0.05)  # grace: listener actually accepting
    return proc


@pytest.fixture(scope="module")
def daemon() -> Iterator[subprocess.Popen[bytes]]:
    proc = _boot_daemon()
    yield proc
    proc.kill()
    proc.wait(timeout=5)
    if os.path.exists(SOCKET_PATH):
        try:
            os.unlink(SOCKET_PATH)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Vector execution (raw socket replay — validates the wire exactly)
# --------------------------------------------------------------------------- #


def _load_vectors() -> list[dict[str, Any]]:
    data = json.loads(VECTORS_PATH.read_text())
    return [v for v in data if not v["name"].startswith("_")]


def _build_line(step: dict[str, Any]) -> Optional[str]:
    if "send" in step:
        return step["send"]
    if "send_repeat" in step:
        r = step["send_repeat"]
        return r["prefix"] + r["fill"] * r["count"] + r["suffix"]
    return None


VECTORS = _load_vectors()


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
async def test_vector(daemon: Any, vector: dict[str, Any]) -> None:
    conns: dict[int, Conn] = {}

    async def get_conn(idx: int) -> Conn:
        c = conns.get(idx)
        if c is None:
            c = await Conn.open(SOCKET_PATH)
            conns[idx] = c
        return c

    try:
        for step in vector["steps"]:
            conn = await get_conn(step.get("conn", 0))
            line = _build_line(step)
            if line is not None:
                conn.send(line)

            matcher = step.get("expect")
            if matcher is None:
                continue

            if matcher.get("silent"):
                got = await conn.read_line(DRAIN_S)
                assert got is None, f"expected silence, got: {got!r}"
            else:
                got = await conn.read_line(READ_TIMEOUT_S)
                assert got is not None, "expected a response line, got none"
                if "equals" in matcher:
                    assert got == matcher["equals"]
                else:
                    assert re.search(matcher["matches"], got), (
                        f"{got!r} !~ {matcher['matches']!r}"
                    )
    finally:
        for c in conns.values():
            c.close()


# --------------------------------------------------------------------------- #
# Ergonomic NBus class tests
# --------------------------------------------------------------------------- #


@pytest.fixture()
async def bus_factory(daemon: Any) -> AsyncIterator[Callable[[], Any]]:
    from nbus import NBus

    created: list[NBus] = []

    def make() -> NBus:
        b = NBus(SOCKET_PATH)
        created.append(b)
        return b

    # Async fixture → teardown runs inside the still-open event loop.
    yield make
    for b in created:
        b.close()
    await asyncio.sleep(0)  # let cancellations settle before the loop closes


async def test_set_get_roundtrip(bus_factory: Any) -> None:
    bus = bus_factory()
    await bus.set("apiset", "cfg", {"x": 1, "y": [True, None]})
    assert await bus.get("apiset", "cfg") == {"x": 1, "y": [True, None]}
    assert await bus.get("apiset", "missing") is None


async def test_set_get_string_and_number(bus_factory: Any) -> None:
    bus = bus_factory()
    await bus.set("apitypes", "s", "1.2.3")
    await bus.set("apitypes", "n", 42)
    assert await bus.get("apitypes", "s") == "1.2.3"
    assert await bus.get("apitypes", "n") == 42


async def test_emit_listen_roundtrip_across_instances(bus_factory: Any) -> None:
    sub_bus = bus_factory()
    pub_bus = bus_factory()

    gen = sub_bus.listen("apiemit", "done")
    # Prime the SUB before emitting so the live stream is registered.
    task = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0.1)

    await pub_bus.emit("apiemit", "done", {"version": "9.9.9"})

    event = await asyncio.wait_for(task, timeout=2.0)
    assert event == {
        "bucket": "apiemit",
        "event": "done",
        "data": {"version": "9.9.9"},
    }
    await gen.aclose()


async def test_watch_fires_on_set(bus_factory: Any) -> None:
    watch_bus = bus_factory()
    set_bus = bus_factory()

    await set_bus.set("apiwatch", "k", "initial")

    gen = watch_bus.watch("apiwatch", "k")
    first = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
    assert first == "initial"

    await set_bus.set("apiwatch", "k", "updated")
    second = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
    assert second == "updated"
    await gen.aclose()


async def test_ping_stats_buckets(bus_factory: Any) -> None:
    bus = bus_factory()
    assert await bus.ping() == "PONG"

    await bus.set("apimeta", "k", "v")
    stats = await bus.stats()
    for field in ("buckets", "subscriptions", "keys", "uptime_seconds"):
        assert isinstance(stats[field], int)

    names = await bus.buckets()
    assert isinstance(names, list)
    assert "apimeta" in names


async def test_context_manager(daemon: Any) -> None:
    from nbus import NBus

    async with NBus(SOCKET_PATH) as bus:
        await bus.set("apictx", "k", [1, 2, 3])
        assert await bus.get("apictx", "k") == [1, 2, 3]
