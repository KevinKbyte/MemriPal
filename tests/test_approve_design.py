# Covers: MEM-070
# Requirement: a changed shot (a tip shot whose bytes differ from the same-named shot rendered at
# the merge-base) fails `scripts/design_gate.py` unless Kev recorded an approval for it with
# `scripts/approve_design.py <gate-outdir> --approvals <file>`, which records the gate run's tip
# commit plus the sha256 of each changed shot (appending to earlier approvals). The gate passes
# with a matching approval (same tip, same shot hash) and refuses an approval for an older tip,
# for a different hash, or for a different shot; a render identical to the base needs no
# approval; an approval never overrides a failing check; an unreadable approvals file fails
# closed. approve_design.py exits 2 on bad usage or a directory holding no gate run, writing
# nothing.
import importlib.util
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
APPROVE = REPO_ROOT / "scripts" / "approve_design.py"


def _load_path(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Shared fixture helpers (FakeShooter, Repo, _gate, ...) live with the gate tests.
G = _load_path("design_gate_test_support", Path(__file__).resolve().parent / "test_design_gate.py")

pytestmark = G.pytestmark

CHANGED = {G.PHONE: "v2"}  # tip's phone shot differs from the base render; the wide shot does not


def _approve(*argv) -> int:
    try:
        return _load_path("approve_design_under_test", APPROVE).main(list(argv))
    except SystemExit as exc:
        return exc.code


@pytest.fixture
def repo(tmp_path):
    return G._make_repo(tmp_path)


def _changed_shooter(tip, **kw):
    return G.FakeShooter(tip, tip=G._render(looks=CHANGED, **kw))


def _gate(capsys, tmp_path, repo, shooter, *extra, outdir="out"):
    argv = [
        "--repo",
        str(repo.path),
        "--base",
        "main",
        "--outdir",
        str(tmp_path / outdir),
        "--approvals",
        str(tmp_path / "approvals.json"),
        *extra,
    ]
    try:
        code = G._load().main(argv, shoot=shooter)
    except SystemExit as exc:
        code = exc.code
    return code, capsys.readouterr().out.splitlines()


def _approve_run(tmp_path, outdir="out") -> int:
    return _approve(str(tmp_path / outdir), "--approvals", str(tmp_path / "approvals.json"))


def _approval_fail_for(lines, shot):
    return any(shot in line and "approv" in line.lower() for line in G._fails(lines))


class TestGateRequiresApproval:
    def test_changed_shot_without_approval_fails_naming_only_changed_shots(self, capsys, tmp_path, repo):
        code, lines = _gate(capsys, tmp_path, repo, _changed_shooter(G._design_commit(repo)))
        assert code == 1
        assert _approval_fail_for(lines, G.PHONE)
        assert not any(G.WIDE in line for line in G._fails(lines))

    def test_render_identical_to_base_needs_no_approval(self, capsys, tmp_path, repo):
        code, lines = _gate(capsys, tmp_path, repo, G.FakeShooter(G._design_commit(repo)))
        assert code == 0, lines
        assert not (tmp_path / "approvals.json").exists()

    def test_fresh_tip_shots_plus_approval_pass(self, capsys, tmp_path, repo):
        tip = G._design_commit(repo)
        assert _gate(capsys, tmp_path, repo, _changed_shooter(tip))[0] == 1
        assert _approve_run(tmp_path) == 0
        code, lines = _gate(capsys, tmp_path, repo, _changed_shooter(tip), outdir="out2")
        assert code == 0, lines
        assert lines[-1] == "OK"

    def test_approval_for_an_older_tip_is_refused(self, capsys, tmp_path, repo):
        old_tip = G._design_commit(repo)
        assert _gate(capsys, tmp_path, repo, _changed_shooter(old_tip))[0] == 1
        assert _approve_run(tmp_path) == 0
        new_tip = repo.commit({G.CONTRACT_PATH: G.CONTRACT + "\nNote.\n"}, "later commit, same look")
        code, lines = _gate(capsys, tmp_path, repo, _changed_shooter(new_tip), outdir="out2")
        assert code == 1
        assert _approval_fail_for(lines, G.PHONE)

    def test_approval_for_a_different_hash_is_refused(self, capsys, tmp_path, repo):
        tip = G._design_commit(repo)
        assert _gate(capsys, tmp_path, repo, _changed_shooter(tip))[0] == 1
        assert _approve_run(tmp_path) == 0
        rerender = G.FakeShooter(tip, tip=G._render(looks={G.PHONE: "v3"}))
        code, lines = _gate(capsys, tmp_path, repo, rerender, outdir="out2")
        assert code == 1
        assert _approval_fail_for(lines, G.PHONE)

    def test_approval_for_a_different_shot_is_refused(self, capsys, tmp_path, repo):
        tip = G._design_commit(repo)
        assert _gate(capsys, tmp_path, repo, _changed_shooter(tip))[0] == 1
        assert _approve_run(tmp_path) == 0
        wide_changed = G.FakeShooter(tip, tip=G._render(looks={G.PHONE: "v2", G.WIDE: "v2"}))
        code, lines = _gate(capsys, tmp_path, repo, wide_changed, outdir="out2")
        assert code == 1
        assert _approval_fail_for(lines, G.WIDE)
        assert not _approval_fail_for(lines, G.PHONE)

    def test_approvals_append_rather_than_replace(self, capsys, tmp_path, repo):
        first = G._design_commit(repo)
        assert _gate(capsys, tmp_path, repo, _changed_shooter(first))[0] == 1
        assert _approve_run(tmp_path) == 0
        second = repo.commit({G.CONTRACT_PATH: G.CONTRACT + "\nNote.\n"}, "second")
        assert _gate(capsys, tmp_path, repo, _changed_shooter(second), outdir="out2")[0] == 1
        assert _approve_run(tmp_path, "out2") == 0
        assert _gate(capsys, tmp_path, repo, _changed_shooter(second), outdir="out3")[0] == 0
        code, lines = _gate(capsys, tmp_path, repo, _changed_shooter(first), "--tip", first, outdir="out4")
        assert code == 0, lines

    def test_approval_does_not_override_a_failing_check(self, capsys, tmp_path, repo):
        tip = G._design_commit(repo)
        assert _gate(capsys, tmp_path, repo, _changed_shooter(tip))[0] == 1
        assert _approve_run(tmp_path) == 0
        broken = _changed_shooter(tip, errors=["TypeError: x is null"])
        code, lines = _gate(capsys, tmp_path, repo, broken, outdir="out2")
        assert code == 1
        assert any("TypeError: x is null" in line for line in G._fails(lines))

    def test_unreadable_approvals_file_fails_closed(self, capsys, tmp_path, repo):
        (tmp_path / "approvals.json").write_text("{not json", encoding="utf-8")
        code, lines = _gate(capsys, tmp_path, repo, _changed_shooter(G._design_commit(repo)))
        assert code == 1
        assert G._fails(lines)


class TestApproveCli:
    def test_no_arguments_exits_2(self, tmp_path):
        assert _approve() == 2

    def test_directory_without_a_gate_run_exits_2_and_writes_nothing(self, tmp_path):
        empty = tmp_path / "empty"
        empty.mkdir()
        assert _approve(str(empty), "--approvals", str(tmp_path / "approvals.json")) == 2
        assert not (tmp_path / "approvals.json").exists()

    def test_missing_directory_exits_2_and_writes_nothing(self, tmp_path):
        assert _approve(str(tmp_path / "nope"), "--approvals", str(tmp_path / "approvals.json")) == 2
        assert not (tmp_path / "approvals.json").exists()

    def test_run_with_no_changed_shots_approves_nothing_and_exits_0(self, capsys, tmp_path, repo):
        tip = G._design_commit(repo)
        assert _gate(capsys, tmp_path, repo, G.FakeShooter(tip))[0] == 0
        assert _approve_run(tmp_path) == 0
        # The empty approval must not let a later changed render through.
        code, lines = _gate(capsys, tmp_path, repo, _changed_shooter(tip), outdir="out2")
        assert code == 1
        assert _approval_fail_for(lines, G.PHONE)
