# Covers: MEM-136
# Requirement: a Cloud Run restart (or a second instance) must never reset the Meta spend estimate, so
# the counter lives in a pluggable store: memripal.meta_spend_guard.FirestoreSpendStore(transact,
# timeout_s=5.0) in prod, FileSpendStore(path) (the old spent.json) for dev, fixture and BYOK.
# transact(fn) runs fn(current dict | None) -> dict atomically and may retry fn on contention.
# Both stores: read() -> float, charge(cost, cap) raises MetaSpendCapReached, adding nothing, when
# spent + cost > cap. Fail closed: any store error, timeout or invalid data (not {"spent_usd": finite
# float >= 0}) -> read() is inf and charge refuses; a missing Firestore doc is refused too (the counter
# must be seeded via seed_spend(transact, usd), which never lowers it and never overwrites unknown
# state). MetaSpendGuard(state_dir=None, *, cap_usd=None, store=None) delegates to the store;
# guard_from_env() picks it from MEMRIPAL_META_SPEND_STORE ("file" default | "firestore", else
# ValueError), with MEMRIPAL_META_SPEND_FIRESTORE_DOC (default "memripal/meta-spend") and
# GOOGLE_CLOUD_PROJECT, never touching the network at build time. scripts/seed_meta_spend.py --usd N
# [--doc PATH] [--project P] seeds the prod doc.
import copy
import importlib.util
import json
import math
import threading
from pathlib import Path

import pytest

from memripal import meta_spend_guard
from memripal.meta_spend_guard import (
    CALL_COST_USD,
    SPEND_CAP_ENV,
    SPEND_DIR_ENV,
    FileSpendStore,
    FirestoreSpendStore,
    MetaSpendCapReached,
    MetaSpendGuard,
    guard_from_env,
    seed_spend,
)

REPO = Path(__file__).resolve().parents[1]
SEED_SCRIPT = REPO / "scripts" / "seed_meta_spend.py"
STORE_ENV = "MEMRIPAL_META_SPEND_STORE"
DOC_ENV = "MEMRIPAL_META_SPEND_FIRESTORE_DOC"
CHAT = CALL_COST_USD["chat"]
MAX_ATTEMPTS = 50
BAD_DOCS = [
    {"spent_usd": True},
    {"spent_usd": float("nan")},
    {"spent_usd": float("inf")},
    {"spent_usd": -1.0},
    {"spent_usd": "1.0"},
    {},
    {"other": 1.0},
    ["spent_usd", 1.0],
    "1.0",
    3.0,
]


class FakeDoc:
    """In-memory Firestore doc with optimistic transactions: fn runs outside the lock, commit only if
    the version is unchanged, else retry (MAX_ATTEMPTS, then raise), like a real Firestore transaction."""

    def __init__(self, data=None):
        self.data = copy.deepcopy(data)
        self.version = 0
        self._lock = threading.Lock()
        self.before_commit = None  # test hook: runs once between fn and commit

    def transact(self, fn):
        for _ in range(MAX_ATTEMPTS):
            with self._lock:
                snapshot, version = copy.deepcopy(self.data), self.version
            result = fn(snapshot)
            hook, self.before_commit = self.before_commit, None
            if hook is not None:
                hook()
            with self._lock:
                if self.version == version:
                    self.data = copy.deepcopy(result)
                    self.version += 1
                    return
        raise RuntimeError("transaction contention: too many attempts")

    def bump(self, delta: float) -> None:
        """Another writer commits directly (a concurrent instance)."""
        with self._lock:
            self.data = {"spent_usd": self.data["spent_usd"] + delta}
            self.version += 1


def _raising(exc: BaseException):
    def transact(fn):
        raise exc

    return transact


def _store(doc: FakeDoc) -> FirestoreSpendStore:
    return FirestoreSpendStore(doc.transact)


def _guard(doc: FakeDoc, cap: float = 100.0) -> MetaSpendGuard:
    return MetaSpendGuard(store=_store(doc), cap_usd=cap)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in (SPEND_CAP_ENV, SPEND_DIR_ENV, STORE_ENV, DOC_ENV, "GOOGLE_CLOUD_PROJECT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


class TestFirestoreRestartPersistence:
    def test_new_guard_on_same_doc_sees_prior_spend(self):
        doc = FakeDoc({"spent_usd": 0.0})
        first = _guard(doc)
        first.charge("chat")
        first.charge("segment")

        restarted = _guard(doc)

        assert restarted.spent_usd == pytest.approx(CHAT + CALL_COST_USD["segment"])
        assert doc.data["spent_usd"] == pytest.approx(CHAT + CALL_COST_USD["segment"])

    def test_cap_reached_before_restart_still_refuses_after(self):
        doc = FakeDoc({"spent_usd": 0.0})
        _guard(doc, cap=CHAT * 1.5).charge("chat")

        with pytest.raises(MetaSpendCapReached):
            _guard(doc, cap=CHAT * 1.5).charge("chat")
        assert doc.data["spent_usd"] == pytest.approx(CHAT)

    def test_valid_int_value_reads_as_float(self):
        assert _store(FakeDoc({"spent_usd": 3})).read() == 3.0


class TestFirestoreConcurrency:
    def test_parallel_charges_on_two_instances_never_pass_the_cap(self):
        # cap 0.51 so exactly 25 chats fit whatever the float summation order (25 * 0.02 = 0.50).
        doc = FakeDoc({"spent_usd": 0.0})
        cap = 0.51
        guards = [_guard(doc, cap=cap), _guard(doc, cap=cap)]
        n = 40
        barrier = threading.Barrier(n)
        outcomes: list = [None] * n

        def worker(i: int) -> None:
            barrier.wait()
            try:
                guards[i % 2].charge("chat")
                outcomes[i] = "ok"
            except Exception as exc:  # noqa: BLE001 - the outcome type is the assertion
                outcomes[i] = exc

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        assert not any(t.is_alive() for t in threads), "a charge hung"

        refused = [o for o in outcomes if o != "ok"]
        assert outcomes.count("ok") == 25
        assert len(refused) == 15 and all(isinstance(o, MetaSpendCapReached) for o in refused), refused
        assert doc.data["spent_usd"] == pytest.approx(25 * CHAT)
        assert doc.data["spent_usd"] <= cap

    def test_retried_transaction_recomputes_from_the_fresh_value(self):
        doc = FakeDoc({"spent_usd": 1.0})
        doc.before_commit = lambda: doc.bump(0.5)  # another instance commits mid-transaction

        _store(doc).charge(CHAT, 100.0)

        assert doc.data["spent_usd"] == pytest.approx(1.5 + CHAT)

    def test_retry_that_now_passes_the_cap_is_refused(self):
        doc = FakeDoc({"spent_usd": 0.0})
        doc.before_commit = lambda: doc.bump(0.5)

        with pytest.raises(MetaSpendCapReached):
            _store(doc).charge(CHAT, 0.5)
        assert doc.data == {"spent_usd": 0.5}


class TestFirestoreFailsClosed:
    @pytest.mark.parametrize(
        "exc",
        [
            ConnectionError("unreachable"),
            TimeoutError("deadline exceeded"),
            PermissionError("403 auth"),
            Exception("anything"),
            RuntimeError("transaction contention: too many attempts"),
        ],
        ids=lambda e: type(e).__name__,
    )
    def test_store_error_refuses_and_reads_inf(self, exc):
        store = FirestoreSpendStore(_raising(exc))
        assert store.read() == math.inf
        with pytest.raises(MetaSpendCapReached):
            store.charge(CHAT, 100.0)

    def test_guard_on_unreachable_store_refuses_and_reads_inf(self):
        guard = MetaSpendGuard(store=FirestoreSpendStore(_raising(ConnectionError("down"))), cap_usd=100.0)
        assert guard.spent_usd == math.inf
        with pytest.raises(MetaSpendCapReached):
            guard.charge("chat")

    def test_commit_failure_after_fn_ran_still_refuses(self):
        doc = FakeDoc({"spent_usd": 1.0})

        def transact(fn):
            fn(copy.deepcopy(doc.data))
            raise TimeoutError("commit deadline exceeded")

        with pytest.raises(MetaSpendCapReached):
            FirestoreSpendStore(transact).charge(CHAT, 100.0)
        assert doc.data == {"spent_usd": 1.0}

    @pytest.mark.parametrize("bad", BAD_DOCS, ids=repr)
    def test_bad_doc_is_refused_and_left_unchanged(self, bad):
        doc = FakeDoc(bad)
        before = repr(doc.data)
        store = _store(doc)

        assert store.read() == math.inf
        with pytest.raises(MetaSpendCapReached):
            store.charge(CHAT, 100.0)
        assert repr(doc.data) == before


class TestFirestoreMissingDocMustBeSeeded:
    def test_missing_doc_reads_inf_and_refuses_without_creating_it(self):
        doc = FakeDoc(None)
        store = _store(doc)

        assert store.read() == math.inf
        with pytest.raises(MetaSpendCapReached):
            store.charge(CHAT, 100.0)
        assert doc.data is None

    def test_after_seeding_charges_count_from_the_seed(self):
        doc = FakeDoc(None)
        assert seed_spend(doc.transact, 10.0) == 10.0

        guard = _guard(doc)
        guard.charge("chat")

        assert guard.spent_usd == pytest.approx(10.0 + CHAT)
        assert doc.data["spent_usd"] == pytest.approx(10.0 + CHAT)


class TestCapEdge:
    def test_landing_exactly_on_the_cap_is_allowed(self):
        doc = FakeDoc({"spent_usd": 0.48})
        _store(doc).charge(0.02, 0.5)
        assert doc.data["spent_usd"] == 0.5

    def test_one_cent_over_the_cap_is_refused(self):
        doc = FakeDoc({"spent_usd": 0.49})
        with pytest.raises(MetaSpendCapReached):
            _store(doc).charge(0.02, 0.5)
        assert doc.data == {"spent_usd": 0.49}

    def test_zero_cap_refuses_every_kind(self):
        doc = FakeDoc({"spent_usd": 0.0})
        guard = _guard(doc, cap=0.0)
        for kind in CALL_COST_USD:
            with pytest.raises(MetaSpendCapReached):
                guard.charge(kind)
        assert doc.data == {"spent_usd": 0.0}


class TestSeedSpend:
    def test_seed_never_lowers_the_counter(self):
        doc = FakeDoc({"spent_usd": 20.0})
        assert seed_spend(doc.transact, 10.0) == 20.0
        assert doc.data["spent_usd"] == 20.0

    def test_seed_raises_a_lower_counter(self):
        doc = FakeDoc({"spent_usd": 5.0})
        assert seed_spend(doc.transact, 10.0) == 10.0
        assert doc.data["spent_usd"] == 10.0

    def test_seed_zero_creates_a_usable_counter(self):
        doc = FakeDoc(None)
        assert seed_spend(doc.transact, 0.0) == 0.0
        _store(doc).charge(CHAT, 1.0)
        assert doc.data["spent_usd"] == pytest.approx(CHAT)

    @pytest.mark.parametrize("usd", [-0.01, float("nan"), float("inf"), float("-inf")], ids=repr)
    def test_invalid_usd_is_a_value_error_and_writes_nothing(self, usd):
        doc = FakeDoc(None)
        with pytest.raises(ValueError):
            seed_spend(doc.transact, usd)
        assert doc.data is None

    @pytest.mark.parametrize("bad", BAD_DOCS, ids=repr)
    def test_invalid_existing_data_is_never_overwritten(self, bad):
        doc = FakeDoc(bad)
        before = repr(doc.data)
        with pytest.raises(ValueError):
            seed_spend(doc.transact, 10.0)
        assert repr(doc.data) == before


class TestFileSpendStore:
    def test_missing_file_reads_zero(self, tmp_path):
        assert FileSpendStore(tmp_path / "spend" / "spent.json").read() == 0.0

    def test_charge_persists_across_a_new_store(self, tmp_path):
        path = tmp_path / "spend" / "spent.json"
        FileSpendStore(path).charge(CHAT, 1.0)
        assert FileSpendStore(path).read() == pytest.approx(CHAT)
        assert json.loads(path.read_text(encoding="ascii")) == {"spent_usd": pytest.approx(CHAT)}

    def test_over_cap_is_refused_and_adds_nothing(self, tmp_path):
        path = tmp_path / "spent.json"
        store = FileSpendStore(path)
        store.charge(CHAT, CHAT * 1.5)
        with pytest.raises(MetaSpendCapReached):
            store.charge(CHAT, CHAT * 1.5)
        assert store.read() == pytest.approx(CHAT)

    @pytest.mark.parametrize(
        "raw", ['{"spent_usd": true}', '{"spent_usd": NaN}', '{"spent_usd": -1}', "[]", "{"]
    )
    def test_bad_file_is_refused_and_left_unchanged(self, tmp_path, raw):
        path = tmp_path / "spent.json"
        path.write_text(raw, encoding="ascii")
        store = FileSpendStore(path)
        assert store.read() == math.inf
        with pytest.raises(MetaSpendCapReached):
            store.charge(CHAT, 100.0)
        assert path.read_text(encoding="ascii") == raw

    def test_default_guard_uses_spent_json_under_state_dir(self, tmp_path):
        MetaSpendGuard(tmp_path / "spend", cap_usd=1.0).charge("chat")
        assert FileSpendStore(tmp_path / "spend" / "spent.json").read() == pytest.approx(CHAT)


class _FakeFactory:
    """Stands in for firestore_transact: records how it was built, returns a FakeDoc's transact."""

    def __init__(self, doc: FakeDoc):
        self.doc = doc
        self.calls: list[tuple[str, str | None]] = []
        self.transacts = 0

    def __call__(self, doc_path, *, project=None, timeout_s=5.0):
        self.calls.append((doc_path, project))

        def transact(fn):
            self.transacts += 1
            return self.doc.transact(fn)

        return transact


class TestGuardFromEnv:
    @pytest.mark.parametrize("value", [None, "", "file"])
    def test_file_store_by_default(self, monkeypatch, tmp_path, value):
        if value is not None:
            monkeypatch.setenv(STORE_ENV, value)
        monkeypatch.setenv(SPEND_DIR_ENV, str(tmp_path / "spend"))
        factory = _FakeFactory(FakeDoc({"spent_usd": 0.0}))
        monkeypatch.setattr(meta_spend_guard, "firestore_transact", factory)

        guard = guard_from_env()
        guard.charge("chat")

        assert factory.calls == []
        assert FileSpendStore(tmp_path / "spend" / "spent.json").read() == pytest.approx(CHAT)

    def test_firestore_store_uses_default_doc_and_no_network_at_build(self, monkeypatch):
        monkeypatch.setenv(STORE_ENV, "firestore")
        factory = _FakeFactory(FakeDoc({"spent_usd": 1.0}))
        monkeypatch.setattr(meta_spend_guard, "firestore_transact", factory)

        guard = guard_from_env()

        assert factory.calls == [("memripal/meta-spend", None)]
        assert factory.transacts == 0, "building the guard touched the store"
        guard.charge("chat")
        assert factory.doc.data["spent_usd"] == pytest.approx(1.0 + CHAT)

    def test_firestore_doc_and_project_come_from_env(self, monkeypatch):
        monkeypatch.setenv(STORE_ENV, "firestore")
        monkeypatch.setenv(DOC_ENV, "spend/prod")
        monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "memripal-proj")
        factory = _FakeFactory(FakeDoc({"spent_usd": 2.0}))
        monkeypatch.setattr(meta_spend_guard, "firestore_transact", factory)

        assert guard_from_env().spent_usd == 2.0
        assert factory.calls == [("spend/prod", "memripal-proj")]

    @pytest.mark.parametrize("value", ["postgres", "memory", "FILE-ish"])
    def test_unknown_store_is_a_value_error(self, monkeypatch, value):
        monkeypatch.setenv(STORE_ENV, value)
        monkeypatch.setattr(meta_spend_guard, "firestore_transact", _FakeFactory(FakeDoc()))
        with pytest.raises(ValueError):
            guard_from_env()


def _load_seed_script():
    spec = importlib.util.spec_from_file_location("seed_meta_spend_under_test", SEED_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestSeedScript:
    def test_seeds_the_named_doc(self, monkeypatch):
        factory = _FakeFactory(FakeDoc(None))
        monkeypatch.setattr(meta_spend_guard, "firestore_transact", factory)
        script = _load_seed_script()

        assert script.main(["--usd", "12.5", "--doc", "spend/prod", "--project", "memripal-proj"]) in (
            0,
            None,
        )

        assert factory.calls == [("spend/prod", "memripal-proj")]
        assert factory.doc.data == {"spent_usd": 12.5}

    def test_help_exits_zero(self, monkeypatch):
        monkeypatch.setattr(meta_spend_guard, "firestore_transact", _FakeFactory(FakeDoc()))
        with pytest.raises(SystemExit) as exc:
            _load_seed_script().main(["--help"])
        assert exc.value.code == 0

    @pytest.mark.parametrize("usd", ["-1", "abc", "nan"])
    def test_bad_usd_is_rejected_before_any_store_call(self, monkeypatch, usd):
        factory = _FakeFactory(FakeDoc(None))
        monkeypatch.setattr(meta_spend_guard, "firestore_transact", factory)
        with pytest.raises(SystemExit) as exc:
            _load_seed_script().main(["--usd", usd])
        assert exc.value.code == 2
        assert factory.transacts == 0
        assert factory.doc.data is None
