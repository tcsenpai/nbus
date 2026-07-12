"""nbus optional end-to-end crypto layer (CRYPTO.md v0.1, FROZEN spec).

Python port of ``sdk/typescript/src/crypto.ts``. Self-contained implementation
of the signed (``s1``) and encrypted (``e1``) envelope formats plus RFC 8785
(JCS) canonical JSON, built on the ``cryptography`` library. Pure functions +
Keypair classes; SDK wiring lives in ``client.py``. Everything here fails
closed: wire-supplied input never raises, it returns an ``ok=False`` result.

Cross-language interop is proven byte-for-byte against
``tests/crypto-vectors.json`` — the same vectors the TypeScript SDK passes.
"""

from __future__ import annotations

import base64
import json
import math
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional, Union

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

# JSON value model — Python side is duck-typed; this alias documents intent.
JsonValue = Any

__all__ = [
    "b64u_encode",
    "b64u_decode",
    "canonicalize",
    "Ed25519Keypair",
    "X25519Keypair",
    "Keypair",
    "sign",
    "verify_signed",
    "encrypt_to",
    "decrypt",
    "seal_signed_encrypted",
    "open_signed_encrypted",
    "envelope_kind",
    "is_envelope",
    "VerifyResult",
    "DecryptResult",
    "OpenResult",
]


# ---------------------------------------------------------------------------
# Result dataclasses (fail-closed unions, mirroring the TS discriminated types)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VerifyResult:
    """Result of :func:`verify_signed`. ``ok`` gates ``pub``/``payload``."""

    ok: bool
    pub: Optional[str] = None
    payload: JsonValue = None
    reason: Optional[str] = None


@dataclass(frozen=True)
class DecryptResult:
    """Result of :func:`decrypt`. ``ok`` gates ``payload``."""

    ok: bool
    payload: JsonValue = None
    reason: Optional[str] = None


@dataclass(frozen=True)
class OpenResult:
    """Result of :func:`open_signed_encrypted`. ``ok`` gates ``pub``/``payload``."""

    ok: bool
    pub: Optional[str] = None
    payload: JsonValue = None
    reason: Optional[str] = None


# ---------------------------------------------------------------------------
# base64url (RFC 4648 §5, no padding)
# ---------------------------------------------------------------------------


def b64u_encode(data: bytes) -> str:
    """Encode bytes to base64url without padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_decode(s: str) -> bytes:
    """Decode base64url (padding optional) to bytes."""
    pad = (-len(s)) % 4
    return base64.urlsafe_b64decode(s + ("=" * pad))


# ---------------------------------------------------------------------------
# RFC 8785 (JCS) canonical JSON
# ---------------------------------------------------------------------------


def _ecmascript_number(n: Union[int, float]) -> str:
    """Serialize a number to the ECMAScript ``Number.prototype.toString`` form.

    This is the JCS number form. Integers render without a decimal point;
    floats use the shortest round-tripping representation Python produces via
    ``repr`` (identical to V8 for the finite decimals used on the bus).
    Normalizes ``-0`` to ``"0"``. Rejects NaN/Infinity (no JSON form).
    """
    if isinstance(n, bool):  # bool is an int subclass — must never reach here.
        raise TypeError("canonicalize: bool is not a number")
    if isinstance(n, int):
        return str(n)
    if not math.isfinite(n):
        raise ValueError("canonicalize: non-finite number is not valid JSON")
    if n == 0:  # covers -0.0 → "0"
        return "0"
    if n.is_integer():
        # ECMAScript prints integral doubles without a trailing ".0".
        return str(int(n))
    return repr(n)


# JSON string two-char escape shortcuts (RFC 8785 §3.2.2.2 shortest form).
_ESCAPES = {
    0x22: '\\"',
    0x5C: "\\\\",
    0x08: "\\b",
    0x09: "\\t",
    0x0A: "\\n",
    0x0C: "\\f",
    0x0D: "\\r",
}


def _canonicalize_string(s: str) -> str:
    out = ['"']
    for ch in s:
        c = ord(ch)
        esc = _ESCAPES.get(c)
        if esc is not None:
            out.append(esc)
        elif c < 0x20:
            out.append("\\u%04x" % c)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_key(k: str) -> list[int]:
    """UTF-16 code-unit sequence of ``k`` for JCS key ordering.

    RFC 8785 sorts object keys by UTF-16 code unit, matching the TS reference
    (``a < b`` on JS strings). Python's native ``str`` comparison uses Unicode
    code POINTS, which diverges for astral (>U+FFFF) characters: those encode as
    a surrogate pair whose lead unit (0xD800-0xDBFF) sorts BELOW the BMP
    characters in 0xE000-0xFFFF. Encoding to UTF-16-BE code units reproduces the
    JS ordering exactly for the whole Unicode range.
    """
    b = k.encode("utf-16-be")
    return [(b[i] << 8) | b[i + 1] for i in range(0, len(b), 2)]


def canonicalize(value: JsonValue) -> bytes:
    """Serialize a JSON value to RFC 8785 canonical form as UTF-8 bytes.

    Compact separators, object keys sorted by UTF-16 code unit, arrays in order,
    ECMAScript number form. Raises on non-finite numbers.
    """
    return _canon(value).encode("utf-8")


def _canon(value: JsonValue) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _ecmascript_number(value)
    if isinstance(value, str):
        return _canonicalize_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canon(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=_utf16_key)
        parts = [_canonicalize_string(k) + ":" + _canon(value[k]) for k in keys]
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"canonicalize: unsupported type {type(value).__name__}")


# ---------------------------------------------------------------------------
# Keypair classes
# ---------------------------------------------------------------------------


class Ed25519Keypair:
    """ed25519 signing keypair. ``public_key_b64`` is the base64url raw 32-byte
    public key (the wire identity)."""

    __slots__ = ("_priv", "_pub", "public_key_b64")

    def __init__(self, priv: Ed25519PrivateKey) -> None:
        self._priv = priv
        self._pub = priv.public_key()
        self.public_key_b64 = b64u_encode(self.public_key_bytes())

    # camelCase alias to mirror the TS API surface.
    @property
    def publicKeyB64(self) -> str:  # noqa: N802 - interop alias
        return self.public_key_b64

    @classmethod
    def generate(cls) -> "Ed25519Keypair":
        return cls(Ed25519PrivateKey.generate())

    @classmethod
    def from_seed(cls, seed: bytes) -> "Ed25519Keypair":
        if len(seed) != 32:
            raise ValueError("ed25519 seed must be 32 bytes")
        return cls(Ed25519PrivateKey.from_private_bytes(seed))

    @classmethod
    def from_seed_b64(cls, seed_b64: str) -> "Ed25519Keypair":
        return cls.from_seed(b64u_decode(seed_b64))

    def public_key_bytes(self) -> bytes:
        return self._pub.public_bytes(Encoding.Raw, PublicFormat.Raw)

    def sign_bytes(self, message: bytes) -> bytes:
        return self._priv.sign(message)

    def export_private_b64(self) -> str:
        raw = self._priv.private_bytes(
            Encoding.Raw, PrivateFormat.Raw, NoEncryption()
        )
        return b64u_encode(raw)


class X25519Keypair:
    """X25519 encryption ("box") keypair. ``public_key_b64`` is the base64url raw
    32-byte public key, published to ``_keys`` as ``box``."""

    __slots__ = ("_priv", "_pub", "public_key_b64")

    def __init__(self, priv: X25519PrivateKey) -> None:
        self._priv = priv
        self._pub = priv.public_key()
        self.public_key_b64 = b64u_encode(self.public_key_bytes())

    @property
    def publicKeyB64(self) -> str:  # noqa: N802 - interop alias
        return self.public_key_b64

    @classmethod
    def generate(cls) -> "X25519Keypair":
        return cls(X25519PrivateKey.generate())

    @classmethod
    def from_raw(cls, priv: bytes) -> "X25519Keypair":
        if len(priv) != 32:
            raise ValueError("x25519 private key must be 32 bytes")
        return cls(X25519PrivateKey.from_private_bytes(priv))

    @classmethod
    def from_raw_b64(cls, priv_b64: str) -> "X25519Keypair":
        return cls.from_raw(b64u_decode(priv_b64))

    def public_key_bytes(self) -> bytes:
        return self._pub.public_bytes(Encoding.Raw, PublicFormat.Raw)

    def exchange(self, peer_pub: X25519PublicKey) -> bytes:
        return self._priv.exchange(peer_pub)

    def export_private_b64(self) -> str:
        raw = self._priv.private_bytes(
            Encoding.Raw, PrivateFormat.Raw, NoEncryption()
        )
        return b64u_encode(raw)


class Keypair:
    """Factory namespace mirroring the TS ``Keypair.*`` shape."""

    @staticmethod
    def ed25519() -> Ed25519Keypair:
        return Ed25519Keypair.generate()

    @staticmethod
    def x25519() -> X25519Keypair:
        return X25519Keypair.generate()

    @staticmethod
    def ed25519_from_seed(seed: bytes) -> Ed25519Keypair:
        return Ed25519Keypair.from_seed(seed)

    @staticmethod
    def x25519_from_raw(priv: bytes) -> X25519Keypair:
        return X25519Keypair.from_raw(priv)

    @staticmethod
    def ed25519_from_seed_b64(seed_b64: str) -> Ed25519Keypair:
        return Ed25519Keypair.from_seed_b64(seed_b64)

    @staticmethod
    def x25519_from_raw_b64(priv_b64: str) -> X25519Keypair:
        return X25519Keypair.from_raw_b64(priv_b64)


# ---------------------------------------------------------------------------
# Signing (s1)
# ---------------------------------------------------------------------------


def _signing_bytes(pub: str, ts: int, payload: JsonValue) -> bytes:
    """Canonical (JCS) bytes of the s1 frame fed to ed25519 (before ``sig``).

    The frame's own keys are reordered by JCS to ``$nbus, alg, payload, pub, ts``
    (CRYPTO.md §3.4/§8.3) — ``canonicalize`` handles that automatically.
    """
    frame = {
        "$nbus": "s1",
        "alg": "ed25519",
        "pub": pub,
        "ts": ts,
        "payload": payload,
    }
    return canonicalize(frame)


def sign(
    payload: JsonValue,
    signer: Ed25519Keypair,
    ts: Optional[int] = None,
) -> dict[str, Any]:
    """Build an ``s1`` signed envelope over ``payload``.

    ``ts`` defaults to the current unix time in seconds; injectable for
    deterministic tests.
    """
    if ts is None:
        ts = int(time.time())
    pub = signer.public_key_b64
    sig = signer.sign_bytes(_signing_bytes(pub, ts, payload))
    return {
        "$nbus": "s1",
        "alg": "ed25519",
        "pub": pub,
        "ts": ts,
        "payload": payload,
        "sig": b64u_encode(sig),
    }


def verify_signed(
    env: Any,
    max_skew_seconds: Optional[float] = 300,
    now: Optional[int] = None,
) -> VerifyResult:
    """Verify an ``s1`` envelope, fail-closed.

    Any structural problem, bad signature, or out-of-skew ``ts`` yields
    ``VerifyResult(ok=False, reason=...)``. ``max_skew_seconds`` default 300;
    pass ``0`` or ``None``/``math.inf`` to disable the freshness check.
    """
    try:
        if (
            not isinstance(env, dict)
            or env.get("$nbus") != "s1"
            or env.get("alg") != "ed25519"
        ):
            return VerifyResult(ok=False, reason="not an s1 envelope")
        pub = env.get("pub")
        sig = env.get("sig")
        if not isinstance(pub, str) or not isinstance(sig, str):
            return VerifyResult(ok=False, reason="malformed pub/sig")
        ts = env.get("ts")
        if not isinstance(ts, (int, float)) or isinstance(ts, bool):
            return VerifyResult(ok=False, reason="malformed ts")
        if not math.isfinite(ts):
            return VerifyResult(ok=False, reason="malformed ts")

        skew = max_skew_seconds
        if skew is not None and skew != 0 and skew != math.inf:
            current = now if now is not None else int(time.time())
            if abs(current - ts) > skew:
                return VerifyResult(ok=False, reason="ts outside skew window")

        pub_raw = b64u_decode(pub)
        if len(pub_raw) != 32:
            return VerifyResult(ok=False, reason="bad public key length")
        sig_raw = b64u_decode(sig)
        if len(sig_raw) != 64:
            return VerifyResult(ok=False, reason="bad signature length")

        pub_key = Ed25519PublicKey.from_public_bytes(pub_raw)
        msg = _signing_bytes(pub, ts, env.get("payload"))
        try:
            pub_key.verify(sig_raw, msg)
        except InvalidSignature:
            return VerifyResult(ok=False, reason="signature verification failed")

        return VerifyResult(ok=True, pub=pub, payload=env.get("payload"))
    except Exception as e:  # noqa: BLE001 - fail closed on any wire garbage
        return VerifyResult(ok=False, reason=str(e))


# ---------------------------------------------------------------------------
# Encryption (e1)
# ---------------------------------------------------------------------------

_E1_ALG = "x25519-hkdf-sha256-aes256gcm"
_HKDF_INFO = b"nbus-e1"


def _derive_key(shared: bytes, epk: bytes) -> bytes:
    """Derive the AES-256 key: HKDF-SHA256(ikm=shared, salt=epk, info='nbus-e1')."""
    return HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=epk,
        info=_HKDF_INFO,
    ).derive(shared)


def encrypt_to(
    payload: JsonValue,
    recipient_pub_b64: str,
    aad: Optional[bytes] = None,
) -> dict[str, Any]:
    """Build an ``e1`` envelope encrypting ``payload`` to a recipient X25519
    public key (base64url raw).

    Ephemeral keypair, ECDH, HKDF-SHA256, AES-256-GCM. The 16-byte GCM tag is
    appended to the ciphertext inside ``ct`` (``cryptography``'s ``AESGCM``
    already returns ``ct||tag``). Optional ``aad`` is authenticated (not
    encrypted) and stored base64url.
    """
    recip_raw = b64u_decode(recipient_pub_b64)
    if len(recip_raw) != 32:
        raise ValueError("recipient public key must be 32 bytes")
    recipient_pub = X25519PublicKey.from_public_bytes(recip_raw)

    eph = X25519PrivateKey.generate()
    epk = eph.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    shared = eph.exchange(recipient_pub)
    key = _derive_key(shared, epk)

    iv = os.urandom(12)
    pt = canonicalize(payload)
    ct = AESGCM(key).encrypt(iv, pt, aad)  # returns ciphertext || 16-byte tag

    env: dict[str, Any] = {
        "$nbus": "e1",
        "alg": _E1_ALG,
        "epk": b64u_encode(epk),
        "iv": b64u_encode(iv),
        "ct": b64u_encode(ct),
    }
    if aad is not None:
        env["aad"] = b64u_encode(aad)
    return env


def decrypt(env: Any, recipient: X25519Keypair) -> DecryptResult:
    """Decrypt an ``e1`` envelope with the recipient keypair, fail-closed."""
    try:
        if (
            not isinstance(env, dict)
            or env.get("$nbus") != "e1"
            or env.get("alg") != _E1_ALG
        ):
            return DecryptResult(ok=False, reason="not an e1 envelope")
        epk_b64 = env.get("epk")
        iv_b64 = env.get("iv")
        ct_b64 = env.get("ct")
        if (
            not isinstance(epk_b64, str)
            or not isinstance(iv_b64, str)
            or not isinstance(ct_b64, str)
        ):
            return DecryptResult(ok=False, reason="malformed e1 fields")

        epk = b64u_decode(epk_b64)
        if len(epk) != 32:
            return DecryptResult(ok=False, reason="bad epk length")
        iv = b64u_decode(iv_b64)
        if len(iv) != 12:
            return DecryptResult(ok=False, reason="bad iv length")
        ct_tag = b64u_decode(ct_b64)
        if len(ct_tag) < 16:
            return DecryptResult(ok=False, reason="ciphertext too short")

        eph_pub = X25519PublicKey.from_public_bytes(epk)
        shared = recipient.exchange(eph_pub)
        key = _derive_key(shared, epk)

        aad_b64 = env.get("aad")
        aad = b64u_decode(aad_b64) if isinstance(aad_b64, str) else None

        try:
            pt = AESGCM(key).decrypt(iv, ct_tag, aad)
        except InvalidTag:
            return DecryptResult(ok=False, reason="authentication tag mismatch")

        payload = json.loads(pt.decode("utf-8"))
        return DecryptResult(ok=True, payload=payload)
    except Exception as e:  # noqa: BLE001 - fail closed on any wire garbage
        return DecryptResult(ok=False, reason=str(e))


# ---------------------------------------------------------------------------
# Sign-then-encrypt (§3.3)
# ---------------------------------------------------------------------------


def seal_signed_encrypted(
    payload: JsonValue,
    signer: Ed25519Keypair,
    recipient_pub_b64: str,
    ts: Optional[int] = None,
    aad: Optional[bytes] = None,
) -> dict[str, Any]:
    """Build an ``s1`` over ``payload``, then wrap the whole ``s1`` object as the
    plaintext of an ``e1`` to ``recipient_pub_b64`` (sign-then-encrypt)."""
    inner = sign(payload, signer, ts)
    return encrypt_to(inner, recipient_pub_b64, aad)


def open_signed_encrypted(
    env: Any,
    recipient: X25519Keypair,
    max_skew_seconds: Optional[float] = 300,
    now: Optional[int] = None,
) -> OpenResult:
    """Open a sign-then-encrypt envelope: decrypt the outer ``e1``, then verify
    the inner ``s1``. Fail-closed at both stages."""
    dec = decrypt(env, recipient)
    if not dec.ok:
        return OpenResult(ok=False, reason=f"decrypt: {dec.reason}")

    if envelope_kind(dec.payload) != "s1":
        return OpenResult(
            ok=False, reason="decrypted payload is not an s1 envelope"
        )
    ver = verify_signed(dec.payload, max_skew_seconds, now)
    if not ver.ok:
        return OpenResult(ok=False, reason=f"verify: {ver.reason}")

    return OpenResult(ok=True, pub=ver.pub, payload=ver.payload)


# ---------------------------------------------------------------------------
# Discriminator helpers
# ---------------------------------------------------------------------------


def envelope_kind(v: Any) -> Optional[str]:
    """Return the envelope kind (``"s1"``/``"e1"``), or ``None`` for plain values."""
    if not isinstance(v, dict):
        return None
    tag = v.get("$nbus")
    if tag == "s1":
        return "s1"
    if tag == "e1":
        return "e1"
    return None


def is_envelope(v: Any) -> bool:
    """Is ``v`` a signed or encrypted envelope (by discriminator)?"""
    return envelope_kind(v) is not None


# Type alias for a verify predicate: (pub, envelope) -> bool.
VerifyPredicate = Callable[[str, dict[str, Any]], bool]
