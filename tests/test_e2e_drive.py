# Covers: MEM-001, MEM-002, MEM-017, MEM-034, MEM-035
# Requirement: scripts/e2e_drive.py drives the whole UI against a fixture-mode server it starts itself.
# Its browser-free helpers must: accept only an http(s) --base-url (trailing slash dropped) and default
# --out to a fresh dir under the temp dir; start the server on loopback with every inherited MEMRIPAL_*
# var stripped (no stray passcode, record key or live mode) plus MEMRIPAL_MODE=fixture and the public
# test host allow-listed; map a base URL to the same port on that non-loopback public host; wait for
# readiness without hanging when the server dies or the timeout passes; and exit 0 only when exactly
# 21 steps ran and all passed, 1 on any failure or missing step, 2 when the server never became ready.
# The module must import without playwright installed.
import contextlib
import importlib.util
import sys
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "e2e_drive.py"
PUBLIC_HOST = "memripal-e2e.test"
EXPECTED = 21


def _load():
    spec = importlib.util.spec_from_file_location("e2e_drive_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _results(n_pass, n_fail=0):
    passed = [(f"step {i}", "PASS", "") for i in range(n_pass)]
    failed = [(f"bad {i}", "FAIL", "boom") for i in range(n_fail)]
    return passed + failed


class RecordingRun:
    def __init__(self, results):
        self.results = results
        self.calls = []

    def __call__(self, base, out):
        self.calls.append((base, out))
        return list(self.results)


class FakeTime:
    """Injected clock + sleep: sleeping advances the clock, never real time."""

    def __init__(self, max_sleeps=100_000):
        self.now = 1000.0
        self.slept = 0.0
        self.max_sleeps = max_sleeps
        self.sleeps = 0

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps += 1
        if self.sleeps > self.max_sleeps:
            raise AssertionError("wait_until_ready never gave up")
        self.now += seconds
        self.slept += seconds


def _seq(*values):
    """Callable returning each value in turn, then repeating the last."""
    items = list(values)

    def call():
        return items.pop(0) if len(items) > 1 else items[0]

    return call


@pytest.fixture
def mod():
    return _load()


# Covers: MEM-017
class TestParseArgs:
    @pytest.mark.parametrize(
        "url", ["ftp://127.0.0.1:8000", "file:///etc/passwd", "127.0.0.1:8000", "http://"]
    )
    def test_rejects_non_http_base_url(self, mod, url, capsys):
        with pytest.raises(SystemExit) as exc:
            mod.parse_args(["--base-url", url])
        assert exc.value.code == 2
        assert "--base-url" in capsys.readouterr().err

    @pytest.mark.parametrize(
        "url, expected",
        [
            ("http://127.0.0.1:8000/", "http://127.0.0.1:8000"),
            ("https://memripal.example.run.app", "https://memripal.example.run.app"),
        ],
    )
    def test_accepts_http_and_https_and_drops_trailing_slash(self, mod, url, expected, tmp_path):
        args = mod.parse_args(["--base-url", url, "--out", str(tmp_path)])
        assert args.base_url == expected
        assert Path(args.out) == tmp_path

    def test_no_base_url_means_start_own_server_and_default_out(self, mod, monkeypatch, tmp_path):
        monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
        args = mod.parse_args([])
        assert args.base_url is None
        assert Path(args.out).parent == tmp_path / "memripal-e2e"

    def test_default_out_dir_is_under_system_temp(self, mod, monkeypatch, tmp_path):
        monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
        out = mod.default_out_dir()
        assert out.parent == tmp_path / "memripal-e2e"
        assert out.name  # a per-run subdir, not the shared parent


# Covers: MEM-002, MEM-034
class TestServerLaunch:
    def test_server_env_strips_every_inherited_memripal_var(self, mod):
        base = {
            "PATH": "/usr/bin",
            "SYSTEMROOT": "C:/Windows",
            "MEMRIPAL_RECORD_KEY": "secret-record-key",
            "MEMRIPAL_PASSCODE": "secret-passcode",
            "MEMRIPAL_CALL_BUDGET": "0",
            "MEMRIPAL_MODE": "meta",
            "MEMRIPAL_ALLOWED_HOSTS": "evil.example",
        }
        env = mod.server_env(base)
        assert env == {
            "PATH": "/usr/bin",
            "SYSTEMROOT": "C:/Windows",
            "MEMRIPAL_MODE": "fixture",
            "MEMRIPAL_ALLOWED_HOSTS": PUBLIC_HOST,
        }

    def test_server_env_from_empty_base_still_forces_fixture_mode(self, mod):
        assert mod.server_env({}) == {"MEMRIPAL_MODE": "fixture", "MEMRIPAL_ALLOWED_HOSTS": PUBLIC_HOST}

    def test_server_env_does_not_mutate_its_input(self, mod):
        base = {"MEMRIPAL_PASSCODE": "x", "HOME": "/h"}
        mod.server_env(base)
        assert base == {"MEMRIPAL_PASSCODE": "x", "HOME": "/h"}

    def test_server_command_runs_the_app_on_loopback_with_the_given_python_and_port(self, mod):
        cmd = mod.server_command(8123, python="/opt/py/bin/python")
        assert cmd[0] == "/opt/py/bin/python"
        assert "memripal.app:app" in cmd
        assert cmd[cmd.index("--host") + 1] == "127.0.0.1"
        assert cmd[cmd.index("--port") + 1] == "8123"

    def test_pick_free_port_returns_a_valid_port_number(self, mod):
        port = mod.pick_free_port()
        assert isinstance(port, int)
        assert 0 < port < 65536


# Covers: MEM-034, MEM-035
class TestPublicUrl:
    def test_keeps_port_and_swaps_host_for_the_public_test_host(self, mod):
        assert mod.public_url("http://127.0.0.1:5555") == f"http://{PUBLIC_HOST}:5555/"

    def test_no_port_and_https_scheme_kept(self, mod):
        assert mod.public_url("https://127.0.0.1") == f"https://{PUBLIC_HOST}/"

    def test_custom_host_and_path_dropped_to_root(self, mod):
        assert (
            mod.public_url("http://localhost:9000/some/page", host="other.test") == "http://other.test:9000/"
        )

    def test_public_host_is_not_loopback(self, mod):
        from urllib.parse import urlsplit

        host = urlsplit(mod.public_url("http://127.0.0.1:5555")).hostname
        assert host not in {"localhost", "127.0.0.1", "::1", ""}


# Covers: MEM-001
class TestWaitUntilReady:
    def test_ready_on_first_probe_without_sleeping(self, mod):
        t = FakeTime()
        assert mod.wait_until_ready(lambda: True, lambda: True, sleep=t.sleep, clock=t.clock) is True
        assert t.slept == 0

    def test_ready_after_a_few_failed_probes(self, mod):
        t = FakeTime()
        probe = _seq(False, False, True)
        ok = mod.wait_until_ready(
            probe, lambda: True, timeout=30.0, interval=0.5, sleep=t.sleep, clock=t.clock
        )
        assert ok is True
        assert t.slept == pytest.approx(1.0)

    def test_dead_server_before_start_returns_false_immediately(self, mod):
        t = FakeTime()
        ok = mod.wait_until_ready(lambda: True, lambda: False, sleep=t.sleep, clock=t.clock)
        assert ok is False
        assert t.slept == 0

    def test_server_dying_mid_wait_returns_false_before_timeout(self, mod):
        t = FakeTime()
        alive = _seq(True, True, True, False)
        ok = mod.wait_until_ready(
            lambda: False, alive, timeout=30.0, interval=0.2, sleep=t.sleep, clock=t.clock
        )
        assert ok is False
        assert t.slept < 30.0

    def test_times_out_on_injected_clock_without_overshooting(self, mod):
        t = FakeTime()
        ok = mod.wait_until_ready(
            lambda: False, lambda: True, timeout=5.0, interval=0.2, sleep=t.sleep, clock=t.clock
        )
        assert ok is False
        assert 5.0 - 0.2 <= t.slept <= 5.0 + 0.2 + 1e-6

    def test_zero_timeout_still_probes_once(self, mod):
        t = FakeTime()
        assert mod.wait_until_ready(lambda: True, lambda: True, timeout=0.0, sleep=t.sleep, clock=t.clock)
        t2 = FakeTime()
        assert not mod.wait_until_ready(
            lambda: False, lambda: True, timeout=0.0, sleep=t2.sleep, clock=t2.clock
        )
        assert t2.slept == 0


# Covers: MEM-017
class TestSummaryAndExitCode:
    def test_summarize_empty(self, mod):
        assert mod.summarize([]) == {"passed": 0, "failed": 0, "total": 0}

    def test_summarize_counts_any_non_pass_verdict_as_failed(self, mod):
        results = _results(3, 1) + [("odd", "SKIP", "")]
        assert mod.summarize(results) == {"passed": 3, "failed": 2, "total": 5}

    def test_exit_0_only_when_all_expected_steps_pass(self, mod):
        assert mod.EXPECTED_STEPS == EXPECTED
        assert mod.exit_code(_results(EXPECTED)) == 0

    @pytest.mark.parametrize(
        "results",
        [
            [],
            _results(EXPECTED - 1),
            _results(EXPECTED - 1, 1),
            _results(EXPECTED, 1),
            _results(EXPECTED + 1),
        ],
        ids=["empty", "one-step-missing", "one-failure", "extra-failure", "extra-step"],
    )
    def test_exit_1_on_failure_or_wrong_step_count(self, mod, results):
        assert mod.exit_code(results) == 1

    def test_exit_code_honours_custom_expected(self, mod):
        assert mod.exit_code(_results(2), expected=2) == 0
        assert mod.exit_code([], expected=0) == 0
        assert mod.exit_code(_results(2), expected=3) == 1


# Covers: MEM-001, MEM-017
class TestMain:
    @pytest.fixture
    def no_server(self, mod, monkeypatch):
        @contextlib.contextmanager
        def forbidden(out):
            raise AssertionError("main started a server despite --base-url")
            yield  # pragma: no cover

        monkeypatch.setattr(mod, "serve", forbidden)

    def _fake_serve(self, mod, monkeypatch, base):
        seen = []

        @contextlib.contextmanager
        def fake(out):
            seen.append(out)
            yield base

        monkeypatch.setattr(mod, "serve", fake)
        return seen

    def test_base_url_all_pass_exits_0_and_creates_out(self, mod, no_server, tmp_path):
        out = tmp_path / "nested" / "run"
        run = RecordingRun(_results(EXPECTED))
        assert mod.main(["--base-url", "http://127.0.0.1:8000/", "--out", str(out)], run=run) == 0
        assert run.calls == [("http://127.0.0.1:8000", out.resolve())]
        assert out.is_dir()

    @pytest.mark.parametrize("results", [_results(EXPECTED - 1, 1), _results(EXPECTED - 1), []])
    def test_base_url_failure_or_missing_step_exits_1(self, mod, no_server, tmp_path, results):
        run = RecordingRun(results)
        assert mod.main(["--base-url", "http://127.0.0.1:8000", "--out", str(tmp_path)], run=run) == 1
        assert len(run.calls) == 1

    def test_ftp_base_url_rejected_without_running(self, mod, no_server, tmp_path):
        run = RecordingRun(_results(EXPECTED))
        with pytest.raises(SystemExit) as exc:
            mod.main(["--base-url", "ftp://127.0.0.1:8000", "--out", str(tmp_path)], run=run)
        assert exc.value.code == 2
        assert run.calls == []

    def test_server_never_ready_exits_2_without_running(self, mod, monkeypatch, tmp_path, capsys):
        seen = self._fake_serve(mod, monkeypatch, None)
        run = RecordingRun(_results(EXPECTED))
        assert mod.main(["--out", str(tmp_path)], run=run) == 2
        assert run.calls == []
        assert seen == [tmp_path.resolve()]
        assert "server.log" in capsys.readouterr().err

    def test_own_server_url_is_handed_to_run(self, mod, monkeypatch, tmp_path):
        self._fake_serve(mod, monkeypatch, "http://127.0.0.1:5555")
        run = RecordingRun(_results(EXPECTED))
        assert mod.main(["--out", str(tmp_path)], run=run) == 0
        assert run.calls == [("http://127.0.0.1:5555", tmp_path.resolve())]


# Covers: MEM-017
class TestImport:
    def test_module_imports_without_playwright(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "playwright", None)
        monkeypatch.setitem(sys.modules, "playwright.sync_api", None)
        module = _load()
        assert module.summarize([]) == {"passed": 0, "failed": 0, "total": 0}
        assert callable(module.main)
