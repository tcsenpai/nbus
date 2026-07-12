"""End-to-end crypto via the NBus client against a live Bun nbus daemon.

Boots the REAL daemon (same pattern as conformance_test.py), then exercises the
crypto option surface end to end over the wire:

- emit signed → Python listen with a verify predicate → payload + signed_by
- emit encrypted → Python listen decrypt_with → payload, encrypted=True
- emit sign-then-encrypt → both verified/decrypted
- fail-closed rejects (no verify predicate; rejecting predicate; wrong key)
- set/get signed round-trip + _keys publish/fetch convention

Cross-language: the KAT vectors (crypto_conformance_test.py) already prove the
TS→Python direction (TS-generated envelopes decrypt/verify in Python). Here the
loop is Python→Python over the live bus; a Python→TS proof would require running
the TS verifier, which is out of scope for this Python-only test module.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import time
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Iterator

import pytest

from nbus import Keypair, NBus, is_envelope

REPO_ROOT = Path(__file__).resolve().parents[3]
DAEMON_ENTRY = REPO_ROOT / "src" / "daemon.ts"

SOCKET_PATH = f"/tmp/nbus-pycrypto-{os.getpid()}.sock"
HTTP_PORT = 18600 + (os.getpid() % 1000)


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
    time.sleep(0.05)
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


@pytest.fixture()
async def bus_factory(daemon: Any) -> AsyncIterator[Callable[[], NBus]]:
    created: list[NBus] = []

    def make() -> NBus:
        b = NBus(SOCKET_PATH)
        created.append(b)
        return b

    yield make
    for b in created:
        b.close()
    await asyncio.sleep(0)


# --------------------------------------------------------------------------- #
# Signed (s1)
# --------------------------------------------------------------------------- #


async def test_emit_signed_verify(bus_factory: Any) -> None:
    signer = Keypair.ed25519()
    sub = bus_factory()
    pub = bus_factory()

    gen = sub.listen("audit", "login", verify=lambda p, e: p == signer.public_key_b64)
    task = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0.1)

    await pub.emit("audit", "login", {"user": "alice"}, sign=signer)

    item = await asyncio.wait_for(task, timeout=2.0)
    assert item["data"] == {"user": "alice"}
    assert item["signed_by"] == signer.public_key_b64
    assert "error" not in item
    await gen.aclose()


async def test_signed_rejected_without_verify(bus_factory: Any) -> None:
    signer = Keypair.ed25519()
    sub = bus_factory()
    pub = bus_factory()

    # decrypt_with set (so has_opts is True) but no verify predicate → reject s1.
    box = Keypair.x25519()
    gen = sub.listen("audit", "login2", decrypt_with=box)
    task = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0.1)

    await pub.emit("audit", "login2", {"user": "bob"}, sign=signer)

    item = await asyncio.wait_for(task, timeout=2.0)
    assert "error" in item
    assert "data" not in item
    assert is_envelope(item["raw"])
    await gen.aclose()


async def test_signed_rejected_by_predicate(bus_factory: Any) -> None:
    signer = Keypair.ed25519()
    sub = bus_factory()
    pub = bus_factory()

    gen = sub.listen("audit", "login3", verify=lambda p, e: False)
    task = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0.1)

    await pub.emit("audit", "login3", {"user": "eve"}, sign=signer)

    item = await asyncio.wait_for(task, timeout=2.0)
    assert "rejected" in item["error"]
    await gen.aclose()


# --------------------------------------------------------------------------- #
# Encrypted (e1)
# --------------------------------------------------------------------------- #


async def test_emit_encrypted_decrypt(bus_factory: Any) -> None:
    recipient = Keypair.x25519()
    sub = bus_factory()
    pub = bus_factory()

    gen = sub.listen("secrets", "token", decrypt_with=recipient)
    task = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0.1)

    await pub.emit(
        "secrets", "token", {"t": "s3cr3t"}, encrypt_to=recipient.public_key_b64
    )

    item = await asyncio.wait_for(task, timeout=2.0)
    assert item["data"] == {"t": "s3cr3t"}
    assert item["encrypted"] is True
    assert "signed_by" not in item
    await gen.aclose()


async def test_encrypted_wrong_key_rejected(bus_factory: Any) -> None:
    recipient = Keypair.x25519()
    wrong = Keypair.x25519()
    sub = bus_factory()
    pub = bus_factory()

    gen = sub.listen("secrets", "token2", decrypt_with=wrong)
    task = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0.1)

    await pub.emit(
        "secrets", "token2", {"t": "nope"}, encrypt_to=recipient.public_key_b64
    )

    item = await asyncio.wait_for(task, timeout=2.0)
    assert "decrypt" in item["error"]
    await gen.aclose()


# --------------------------------------------------------------------------- #
# Sign-then-encrypt
# --------------------------------------------------------------------------- #


async def test_emit_sign_then_encrypt(bus_factory: Any) -> None:
    signer = Keypair.ed25519()
    recipient = Keypair.x25519()
    sub = bus_factory()
    pub = bus_factory()

    gen = sub.listen(
        "secrets",
        "sealed",
        verify=lambda p, e: p == signer.public_key_b64,
        decrypt_with=recipient,
    )
    task = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0.1)

    await pub.emit(
        "secrets",
        "sealed",
        {"order": 7},
        sign=signer,
        encrypt_to=recipient.public_key_b64,
    )

    item = await asyncio.wait_for(task, timeout=2.0)
    assert item["data"] == {"order": 7}
    assert item["signed_by"] == signer.public_key_b64
    assert item["encrypted"] is True
    await gen.aclose()


# --------------------------------------------------------------------------- #
# State (set/get) + plain passthrough + _keys
# --------------------------------------------------------------------------- #


async def test_set_get_signed_state(bus_factory: Any) -> None:
    signer = Keypair.ed25519()
    bus = bus_factory()

    await bus.set("cfg", "k", {"v": 1}, sign=signer)
    res = await bus.get(
        "cfg", "k", verify=lambda p, e: p == signer.public_key_b64
    )
    assert res["data"] == {"v": 1}
    assert res["signed_by"] == signer.public_key_b64


async def test_plain_passthrough_under_recv_opts(bus_factory: Any) -> None:
    recipient = Keypair.x25519()
    sub = bus_factory()
    pub = bus_factory()

    gen = sub.listen("mixed", "e", decrypt_with=recipient)
    task = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0.1)

    # Plain (no crypto) emit — must pass through as data even under recv opts.
    await pub.emit("mixed", "e", {"plain": True})

    item = await asyncio.wait_for(task, timeout=2.0)
    assert item["data"] == {"plain": True}
    assert "error" not in item
    await gen.aclose()


async def test_keys_publish_fetch(bus_factory: Any) -> None:
    signer = Keypair.ed25519()
    box = Keypair.x25519()
    bus = bus_factory()

    await bus.publish_keys("alice", sign=signer, box=box)
    rec = await bus.fetch_keys("alice")
    assert rec is not None
    assert rec["sign"] == signer.public_key_b64
    assert rec["box"] == box.public_key_b64
    assert isinstance(rec["ts"], int)

    assert await bus.fetch_keys("nobody") is None


async def test_backward_compat_plain_emit_listen(bus_factory: Any) -> None:
    # No crypto opts anywhere → exact pre-crypto shape.
    sub = bus_factory()
    pub = bus_factory()

    gen = sub.listen("plainb", "done")
    task = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0.1)

    await pub.emit("plainb", "done", {"version": "9.9.9"})

    item = await asyncio.wait_for(task, timeout=2.0)
    assert item == {"bucket": "plainb", "event": "done", "data": {"version": "9.9.9"}}
    await gen.aclose()
