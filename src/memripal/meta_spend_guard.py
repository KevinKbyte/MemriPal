"""Persisted Meta spend estimate with a hard cap; Meta's own spend limit only notifies (MEM-094)."""

import json
import math
import os
import threading
from pathlib import Path

from memripal.backend import BackendCallFailed, _atomic_write

SPEND_CAP_ENV = "MEMRIPAL_META_SPEND_CAP_USD"
SPEND_DIR_ENV = "MEMRIPAL_META_SPEND_DIR"
# Under the $150 Meta credit, leaving margin for estimate error.
DEFAULT_CAP_USD = 135.0
# Deliberately high per-call estimates (prices: docs/plans/2026-10-26-memripal.md). Spark is $1.25/$4.25 per
# 1M tokens, so a photo prompt plus a 1024-token reply is about $0.01; SAM is unpriced, assumed at twice an
# image edit ($0.01); ASR is $0.18 per hour and a recall clip lasts seconds.
CALL_COST_USD = {"chat": 0.02, "segment": 0.02, "asr": 0.01}
# Muse Image is $0.01 per image, doubled like the rest; apart so CALL_COST_USD stays the served call kinds.
IMAGE_CALL_COST_USD = {"image_edit": 0.02, "image_generate": 0.02}
_COSTS = CALL_COST_USD | IMAGE_CALL_COST_USD
# Fixed code for the client: names the limit hit, never the estimate or exception text.
CAP_ERROR_CODE = "meta_spend_cap_reached"
STATE_FILE = "spent.json"
# Process-wide: guards on one state dir read-modify-write the same file.
_LOCK = threading.Lock()


class MetaSpendCapReached(BackendCallFailed):
    """The Meta spend cap refused a call before it was sent."""


def _check_cap(value: str | float) -> float:
    cap = float(value)
    if not math.isfinite(cap) or cap < 0:
        raise ValueError(f"Meta spend cap must be a finite number >= 0, got {value!r}")
    return cap


class MetaSpendGuard:
    def __init__(self, state_dir: Path, *, cap_usd: float | None = None) -> None:
        self._path = Path(state_dir) / STATE_FILE
        cap = os.environ.get(SPEND_CAP_ENV, DEFAULT_CAP_USD) if cap_usd is None else cap_usd
        self.cap_usd = _check_cap(cap)

    @property
    def spent_usd(self) -> float:
        """The persisted estimate; inf for unreadable state, so charge fails closed instead of resetting."""
        try:
            record = json.loads(self._path.read_bytes())
        except FileNotFoundError:
            return 0.0
        except ValueError:
            return math.inf
        spent = record.get("spent_usd") if isinstance(record, dict) else None
        valid = isinstance(spent, int | float) and not isinstance(spent, bool) and math.isfinite(spent)
        return float(spent) if valid and spent >= 0 else math.inf

    def charge(self, kind: str) -> None:
        """Add `kind`'s estimate, or raise MetaSpendCapReached, adding nothing, if it would pass the cap."""
        cost = _COSTS[kind]
        with _LOCK:
            spent = self.spent_usd
            if spent + cost > self.cap_usd:
                estimate = "unreadable" if spent == math.inf else f"${spent:.2f}"
                raise MetaSpendCapReached(
                    f"Meta spend cap of ${self.cap_usd:.2f} reached (estimate {estimate}): {kind} refused"
                )
            _atomic_write(self._path, json.dumps({"spent_usd": spent + cost}).encode("ascii"))


def spend_dir_from_env() -> Path:
    """MEMRIPAL_META_SPEND_DIR, else ~/.memripal/meta-spend; BYOK state sits under its byok/ (MEM-122)."""
    state_dir = os.environ.get(SPEND_DIR_ENV, "").strip()
    return Path(state_dir) if state_dir else Path.home() / ".memripal" / "meta-spend"


def guard_from_env() -> MetaSpendGuard:
    """Meta mode's guard: state under spend_dir_from_env()."""
    return MetaSpendGuard(spend_dir_from_env())


def meta_asr_client_from_env():
    """Live mode's Meta ASR client, charged to the env guard; None without META_API_KEY."""
    # Lazy: meta_client imports this module.
    from memripal.meta_client import MetaClient

    api_key = os.environ.get("META_API_KEY", "")
    return MetaClient(api_key, spend_guard=guard_from_env()) if api_key else None
