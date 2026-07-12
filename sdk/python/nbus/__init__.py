"""nbus-client — async Python SDK for the nbus local IPC bus.

Core transport + primitives plus the optional end-to-end crypto envelope layer
(CRYPTO.md v0.1): signed (``s1``) and encrypted (``e1``) messages, RFC 8785
canonical JSON, and TOFU key discovery. Crypto is opt-in per call — the plain
paths remain byte-for-byte backward compatible.
"""

from __future__ import annotations

from .client import KEYS_BUCKET, NBus
from .crypto import (
    Ed25519Keypair,
    Keypair,
    X25519Keypair,
    envelope_kind,
    is_envelope,
)

__all__ = [
    "NBus",
    "emit",
    "set",
    "get",
    "KEYS_BUCKET",
    "Keypair",
    "Ed25519Keypair",
    "X25519Keypair",
    "is_envelope",
    "envelope_kind",
]
__version__ = "0.1.0"


async def emit(bucket: str, event: str, data: object = None,
               socket_path: str = "/tmp/nbus.sock") -> None:
    """One-shot: open a connection, emit one event, close."""
    bus = NBus(socket_path)
    try:
        await bus.emit(bucket, event, data)
    finally:
        bus.close()


async def set(bucket: str, key: str, value: object,
              socket_path: str = "/tmp/nbus.sock") -> None:
    """One-shot: open a connection, SET one key, close."""
    bus = NBus(socket_path)
    try:
        await bus.set(bucket, key, value)
    finally:
        bus.close()


async def get(bucket: str, key: str,
              socket_path: str = "/tmp/nbus.sock") -> object:
    """One-shot: open a connection, GET one key, close."""
    bus = NBus(socket_path)
    try:
        return await bus.get(bucket, key)
    finally:
        bus.close()
