"""nbus-client — async Python SDK for the nbus local IPC bus.

Core transport + primitives (no crypto; that arrives in a later release).
"""

from __future__ import annotations

from .client import KEYS_BUCKET, NBus

__all__ = ["NBus", "emit", "set", "get", "KEYS_BUCKET"]
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
