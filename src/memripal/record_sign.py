"""Signed association records (MEM-036, ADR 0027): /scenes only renders a record /associate signed."""

import hashlib
import hmac
import json
import os
import secrets

RECORD_KEY_ENV = "MEMRIPAL_RECORD_KEY"


def record_key() -> bytes:
    """MEMRIPAL_RECORD_KEY as UTF-8 bytes; blank or unset -> a random key, so signatures die with the app."""
    # Strip: Secret Manager values carry a trailing newline.
    configured = os.environ.get(RECORD_KEY_ENV, "").strip()
    return configured.encode("utf-8") if configured else secrets.token_bytes(32)


def sign_record(key: bytes, record: object) -> str:
    """Lowercase hex HMAC-SHA256 over the record's canonical JSON."""
    canonical = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hmac.new(key, canonical.encode("ascii"), hashlib.sha256).hexdigest()


def sig_ok(key: bytes, record: object, sig: object) -> bool:
    if not isinstance(sig, str):
        return False
    # Compared as bytes: compare_digest raises TypeError on a non-ASCII str.
    return hmac.compare_digest(sig.encode("utf-8"), sign_record(key, record).encode("ascii"))
