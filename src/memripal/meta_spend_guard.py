"""Persisted Meta spend estimate with a hard cap; Meta's own spend limit only notifies (MEM-094)."""

import json
import math
import os
import threading
from pathlib import Path

from memripal.backend import BackendCallFailed, _atomic_write

SPEND_CAP_ENV = "MEMRIPAL_META_SPEND_CAP_USD"
SPEND_DIR_ENV = "MEMRIPAL_META_SPEND_DIR"
SPEND_STORE_ENV = "MEMRIPAL_META_SPEND_STORE"
SPEND_DOC_ENV = "MEMRIPAL_META_SPEND_FIRESTORE_DOC"
DEFAULT_SPEND_DOC = "memripal/meta-spend"
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


def _spent_of(record) -> float | None:
    """The record's spent_usd if it is a finite number >= 0, else None (invalid state)."""
    spent = record.get("spent_usd") if isinstance(record, dict) else None
    valid = isinstance(spent, int | float) and not isinstance(spent, bool) and math.isfinite(spent)
    return float(spent) if valid and spent >= 0 else None


def _refusal(spent: float, cap: float) -> MetaSpendCapReached:
    estimate = "unreadable" if spent == math.inf else f"${spent:.2f}"
    return MetaSpendCapReached(f"Meta spend cap of ${cap:.2f} reached (estimate {estimate})")


class FileSpendStore:
    """spent.json on local disk: dev, fixture and BYOK; resets with the disk (ADR 0081)."""

    def __init__(self, path: Path) -> None:
        self._path = Path(path)

    def read(self) -> float:
        """The persisted estimate; inf for unreadable state, so charge fails closed instead of resetting."""
        try:
            record = json.loads(self._path.read_bytes())
        except FileNotFoundError:
            return 0.0
        except ValueError:
            return math.inf
        spent = _spent_of(record)
        return math.inf if spent is None else spent

    def charge(self, cost: float, cap: float) -> None:
        with _LOCK:
            spent = self.read()
            if spent + cost > cap:
                raise _refusal(spent, cap)
            _atomic_write(self._path, json.dumps({"spent_usd": spent + cost}).encode("ascii"))


class FirestoreSpendStore:
    """One Firestore doc updated in a transaction, so restarts and instances share it (ADR 0081).

    transact(fn) runs fn(current dict | None) -> dict atomically, retrying fn on contention. Any error,
    a timeout past timeout_s, a missing doc or invalid data refuses: unreachable counts as cap reached."""

    def __init__(self, transact, *, timeout_s: float = 5.0) -> None:
        self._transact = transact
        self._timeout_s = timeout_s

    def _run(self, fn) -> None:
        # A wall-clock deadline over the whole transaction, retries included; per-RPC timeouts alone
        # let a contended or retrying commit hang the request. A late commit only overcounts.
        box: dict = {}

        def target() -> None:
            try:
                self._transact(fn)
            except Exception as exc:  # noqa: BLE001 - re-raised in the caller's thread
                box["error"] = exc

        worker = threading.Thread(target=target, daemon=True)
        worker.start()
        worker.join(self._timeout_s)
        if worker.is_alive():
            raise TimeoutError(f"Meta spend store timed out after {self._timeout_s}s")
        if "error" in box:
            raise box["error"]

    def read(self) -> float:
        seen: list[float] = []

        def peek(current):
            spent = _spent_of(current)
            seen.append(math.inf if spent is None else spent)
            return current

        try:
            self._run(peek)
        except Exception:  # noqa: BLE001 - fail closed on any store error
            return math.inf
        return seen[-1]

    def charge(self, cost: float, cap: float) -> None:
        def step(current):
            spent = _spent_of(current)
            spent = math.inf if spent is None else spent
            if spent + cost > cap:
                raise _refusal(spent, cap)
            return {"spent_usd": spent + cost}

        try:
            self._run(step)
        except MetaSpendCapReached:
            raise
        except Exception as exc:  # noqa: BLE001 - fail closed: unreachable counts as cap reached
            raise MetaSpendCapReached(f"Meta spend store unavailable ({type(exc).__name__})") from exc


class MetaSpendGuard:
    def __init__(self, state_dir: Path | None = None, *, cap_usd: float | None = None, store=None) -> None:
        if store is None and state_dir is None:
            raise ValueError("MetaSpendGuard needs a state_dir or a store")
        # _path is the file store's spent.json; byok._ByokGuard reads and writes it directly.
        self._path = Path(state_dir) / STATE_FILE if state_dir is not None else None
        self._store = FileSpendStore(self._path) if store is None else store
        cap = os.environ.get(SPEND_CAP_ENV, DEFAULT_CAP_USD) if cap_usd is None else cap_usd
        self.cap_usd = _check_cap(cap)

    @property
    def spent_usd(self) -> float:
        """The store's estimate; inf for unreadable state, so charge fails closed instead of resetting."""
        return self._store.read()

    def charge(self, kind: str) -> None:
        """Add `kind`'s estimate, or raise MetaSpendCapReached, adding nothing, if it would pass the cap."""
        cost = _COSTS[kind]
        try:
            self._store.charge(cost, self.cap_usd)
        except MetaSpendCapReached as exc:
            raise MetaSpendCapReached(f"{exc}: {kind} refused") from exc


def seed_spend(transact, usd: float) -> float:
    """Set the counter to max(existing, usd), creating it if missing; never lowers it, never overwrites
    invalid data (ValueError). Returns the stored value."""
    if isinstance(usd, bool) or not isinstance(usd, int | float) or not math.isfinite(usd) or usd < 0:
        raise ValueError(f"seed must be a finite number >= 0, got {usd!r}")
    stored: list[float] = []

    def step(current):
        existing = 0.0 if current is None else _spent_of(current)
        if existing is None:
            raise ValueError(f"refusing to overwrite invalid spend data: {current!r}")
        stored.append(max(existing, float(usd)))
        return {"spent_usd": stored[-1]}

    transact(step)
    return stored[-1]


def firestore_transact(doc_path: str, *, project: str | None = None, timeout_s: float = 5.0):
    """A transact(fn) over one Firestore doc; the client is built on first use, never at build time."""
    segments = doc_path.split("/") if isinstance(doc_path, str) else []
    if not segments or len(segments) % 2 or not all(segments):
        raise ValueError(f"Firestore doc path must be collection/doc[/collection/doc...], got {doc_path!r}")
    clients: list = []

    def transact(fn) -> None:
        from google.cloud import firestore  # lazy: network and import cost only on first use

        if not clients:
            clients.append(firestore.Client(project=project))
        client = clients[0]
        ref = client.document(doc_path)

        @firestore.transactional
        def run(transaction) -> None:
            snapshot = ref.get(transaction=transaction, timeout=timeout_s)
            current = snapshot.to_dict() if snapshot.exists else None
            result = fn(current)
            if result is not current:  # a read returns current unchanged: nothing to write
                transaction.set(ref, result)

        run(client.transaction())

    return transact


def spend_dir_from_env() -> Path:
    """MEMRIPAL_META_SPEND_DIR, else ~/.memripal/meta-spend; BYOK state sits under its byok/ (MEM-122)."""
    state_dir = os.environ.get(SPEND_DIR_ENV, "").strip()
    return Path(state_dir) if state_dir else Path.home() / ".memripal" / "meta-spend"


def guard_from_env() -> MetaSpendGuard:
    """Meta mode's guard on MEMRIPAL_META_SPEND_STORE: file (default, under spend_dir_from_env()) or
    firestore (ADR 0081); anything else fails startup. Building it never touches the network."""
    kind = os.environ.get(SPEND_STORE_ENV, "").strip() or "file"
    if kind == "file":
        return MetaSpendGuard(spend_dir_from_env())
    if kind == "firestore":
        doc = os.environ.get(SPEND_DOC_ENV, "").strip() or DEFAULT_SPEND_DOC
        project = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip() or None
        return MetaSpendGuard(store=FirestoreSpendStore(firestore_transact(doc, project=project)))
    raise ValueError(f"{SPEND_STORE_ENV} must be file or firestore, got {kind!r}")


def meta_asr_client_from_env():
    """Live mode's Meta ASR client, charged to the env guard; None without META_API_KEY."""
    # Lazy: meta_client imports this module.
    from memripal.meta_client import MetaClient

    api_key = os.environ.get("META_API_KEY", "")
    return MetaClient(api_key, spend_guard=guard_from_env()) if api_key else None
