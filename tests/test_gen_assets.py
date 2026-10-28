# Requirement: scripts/gen_assets.py generates the UI assets with Kev's own key: exactly one
# image_edit call per asset (2 paid calls, never retried, no other API call) on a 1024x1024 white
# JPEG base; icon -> icon-512.png + icon-192.png (center-crop, resized), empty-state ->
# empty-state.webp (bytes as returned), under --out (default static/assets/). --dry-run prints the
# plan and "calls: 2" with no key, no client and no writes. A missing/blank META_API_KEY exits 2
# before any call or write. A failed asset prints "<name>: failed (<error or bad_image>)", leaves
# its existing files untouched, the next asset still runs, and the run exits 1; else 0.
import base64
import importlib.util
import json
import socket
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from memripal.meta_client import CallResult

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "gen_assets.py"

# Built by concatenation so this file never matches the pre-commit secret scanner (MEM-004).
KEY = "fake" + "-gen-assets-" + "z" * 24

ICON_FILES = ("icon-512.png", "icon-192.png")
EMPTY_FILES = ("empty-state.webp",)
ALL_FILES = ICON_FILES + EMPTY_FILES
MISSING_KEY_MSG = "META_API_KEY is not set; launch via scripts/run_live.ps1"
BLUE = (20, 40, 200)
RED = (220, 10, 10)


def _load():
    spec = importlib.util.spec_from_file_location("gen_assets_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _icon_source() -> bytes:
    """800x600 lossless WebP: 100px red strips left/right, blue 600x600 center square."""
    img = Image.new("RGB", (800, 600), RED)
    img.paste(Image.new("RGB", (600, 600), BLUE), (100, 0))
    buf = BytesIO()
    img.save(buf, format="WEBP", lossless=True)
    return buf.getvalue()


def _empty_source() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (640, 480), (30, 160, 90)).save(buf, format="WEBP")
    return buf.getvalue()


ICON_WEBP = _icon_source()
EMPTY_WEBP = _empty_source()


def _body(image: bytes) -> bytes:
    return json.dumps({"data": [{"b64_json": base64.b64encode(image).decode("ascii")}]}).encode()


def _ok(image: bytes) -> CallResult:
    return CallResult(ok=True, status=200, body=_body(image), error=None, attempts=1, latency_s=0.01)


def _fail(status: int | None, error: str) -> CallResult:
    return CallResult(ok=False, status=status, body=b"", error=error, attempts=1, latency_s=0.01)


def _ok_raw(body: bytes) -> CallResult:
    return CallResult(ok=True, status=200, body=body, error=None, attempts=1, latency_s=0.01)


class FakeClient:
    """Only image_edit exists: any other MetaClient method (chat_json, segment, ...) raises."""

    def __init__(self, results: list[CallResult]):
        self._results = list(results)
        self.edits: list[dict] = []

    def image_edit(self, **kwargs) -> CallResult:
        self.edits.append(kwargs)
        if not self._results:
            raise AssertionError("more image_edit calls than canned results")
        return self._results.pop(0)


class FakeFactory:
    """Stands in for make_client=MetaClient; records the keys it was built with."""

    def __init__(self, results: list[CallResult]):
        self.client = FakeClient(results)
        self.built: list[tuple[tuple, dict]] = []

    def __call__(self, *args, **kwargs) -> FakeClient:
        self.built.append((args, kwargs))
        return self.client


def _refuse_factory(*args, **kwargs):
    raise AssertionError("client built when none was expected")


def _no_network(*args, **kwargs):
    raise AssertionError("network access attempted")


@pytest.fixture(autouse=True)
def _offline(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _no_network)
    monkeypatch.setattr(socket, "create_connection", _no_network)


def _seed(out: Path, names) -> dict[str, bytes]:
    out.mkdir(parents=True, exist_ok=True)
    seeded = {}
    for name in names:
        data = b"previous-" + name.encode()
        (out / name).write_bytes(data)
        seeded[name] = data
    return seeded


def _run(monkeypatch, out: Path, results, *, extra=()):
    monkeypatch.setenv("META_API_KEY", KEY)
    factory = FakeFactory(results)
    code = _load().main(["--out", str(out), *extra], make_client=factory)
    return code, factory


# Covers: MEM-038
class TestGenAssetsDryRun:
    def test_dry_run_prints_plan_and_call_count_without_key_client_or_writes(
        self, monkeypatch, tmp_path, capsys
    ):
        monkeypatch.delenv("META_API_KEY", raising=False)
        out = tmp_path / "out"
        code = _load().main(["--dry-run", "--out", str(out)], make_client=_refuse_factory)
        stdout = capsys.readouterr().out
        assert code == 0
        lines = [line for line in stdout.splitlines() if line.strip()]
        assert lines[-1].strip() == "calls: 2"
        plan = lines[:-1]
        assert len(plan) == 2
        assert "icon" in plan[0] and "empty-state" not in plan[0]
        assert "icon-512.png" in plan[0] and "icon-192.png" in plan[0]
        assert "empty-state" in plan[1] and "empty-state.webp" in plan[1]
        assert not out.exists() or list(out.iterdir()) == []

    def test_dry_run_with_key_set_still_builds_no_client(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setenv("META_API_KEY", KEY)
        out = tmp_path / "out"
        code = _load().main(["--dry-run", "--out", str(out)], make_client=_refuse_factory)
        captured = capsys.readouterr()
        assert code == 0
        assert "calls: 2" in captured.out
        assert KEY not in captured.out + captured.err
        assert not out.exists() or list(out.iterdir()) == []

    def test_dry_run_default_out_is_static_assets(self, monkeypatch, capsys):
        monkeypatch.delenv("META_API_KEY", raising=False)
        code = _load().main(["--dry-run"], make_client=_refuse_factory)
        stdout = capsys.readouterr().out.replace("\\", "/")
        assert code == 0
        for name in ALL_FILES:
            assert f"static/assets/{name}" in stdout

    def test_dry_run_paths_are_under_out(self, monkeypatch, tmp_path, capsys):
        monkeypatch.delenv("META_API_KEY", raising=False)
        out = tmp_path / "custom"
        _load().main(["--dry-run", "--out", str(out)], make_client=_refuse_factory)
        stdout = capsys.readouterr().out
        for name in ALL_FILES:
            assert str(out / name) in stdout


# Covers: MEM-038
class TestGenAssetsMissingKey:
    @pytest.mark.parametrize("value", [None, "", "   "])
    def test_unset_or_blank_key_exits_2_before_any_call_or_write(self, monkeypatch, tmp_path, capsys, value):
        if value is None:
            monkeypatch.delenv("META_API_KEY", raising=False)
        else:
            monkeypatch.setenv("META_API_KEY", value)
        out = tmp_path / "out"
        code = _load().main(["--out", str(out)], make_client=_refuse_factory)
        captured = capsys.readouterr()
        assert code == 2
        assert MISSING_KEY_MSG in captured.err
        assert not out.exists() or list(out.iterdir()) == []

    def test_missing_key_leaves_existing_files_untouched(self, monkeypatch, tmp_path):
        monkeypatch.delenv("META_API_KEY", raising=False)
        out = tmp_path / "out"
        seeded = _seed(out, ALL_FILES)
        code = _load().main(["--out", str(out)], make_client=_refuse_factory)
        assert code == 2
        for name, data in seeded.items():
            assert (out / name).read_bytes() == data


# Covers: MEM-038
class TestGenAssetsSuccess:
    def test_all_success_writes_three_files_and_exits_0(self, monkeypatch, tmp_path, capsys):
        out = tmp_path / "out"
        code, _ = _run(monkeypatch, out, [_ok(ICON_WEBP), _ok(EMPTY_WEBP)])
        captured = capsys.readouterr()
        assert code == 0
        assert sorted(p.name for p in out.iterdir()) == sorted(ALL_FILES)
        for name in ALL_FILES:
            assert str(out / name) in captured.out
        assert "failed" not in captured.err

    def test_client_built_once_with_env_key_never_printed(self, monkeypatch, tmp_path, capsys):
        code, factory = _run(monkeypatch, tmp_path / "out", [_ok(ICON_WEBP), _ok(EMPTY_WEBP)])
        captured = capsys.readouterr()
        assert code == 0
        assert len(factory.built) == 1
        args, kwargs = factory.built[0]
        assert (args[:1] == (KEY,)) or kwargs.get("api_key") == KEY
        assert KEY not in captured.out + captured.err

    def test_exactly_one_image_edit_per_asset_in_list_order(self, monkeypatch, tmp_path):
        mod = _load()
        monkeypatch.setenv("META_API_KEY", KEY)
        factory = FakeFactory([_ok(ICON_WEBP), _ok(EMPTY_WEBP)])
        mod.main(["--out", str(tmp_path / "out")], make_client=factory)
        edits = factory.client.edits
        assert len(edits) == 2
        for edit in edits:
            assert "size" not in edit
            assert mod.STYLE in edit["prompt"]
        assert edits[0]["prompt"] != edits[1]["prompt"]

    def test_base_image_is_1024_white_rgb_jpeg_data_url(self, monkeypatch, tmp_path):
        _, factory = _run(monkeypatch, tmp_path / "out", [_ok(ICON_WEBP), _ok(EMPTY_WEBP)])
        prefix = "data:image/jpeg;base64,"
        for edit in factory.client.edits:
            url = edit["image_data_url"]
            assert url.startswith(prefix)
            img = Image.open(BytesIO(base64.b64decode(url[len(prefix) :])))
            assert img.format == "JPEG"
            assert img.mode == "RGB"
            assert img.size == (1024, 1024)
            assert img.convert("RGB").getextrema() == ((255, 255), (255, 255), (255, 255))

    @pytest.mark.parametrize(("name", "side"), [("icon-512.png", 512), ("icon-192.png", 192)])
    def test_icon_pngs_are_square_center_crops_at_size(self, monkeypatch, tmp_path, name, side):
        out = tmp_path / "out"
        _run(monkeypatch, out, [_ok(ICON_WEBP), _ok(EMPTY_WEBP)])
        img = Image.open(out / name)
        assert img.format == "PNG"
        assert img.size == (side, side)
        rgb = img.convert("RGB")
        # The red side strips fall outside the centered square crop, so every edge is blue.
        for xy in [(0, 0), (side - 1, 0), (0, side - 1), (side - 1, side - 1), (side // 2, side // 2)]:
            r, g, b = rgb.getpixel(xy)
            assert b > 150 and r < 80, (xy, (r, g, b))

    def test_empty_state_is_returned_bytes_as_is(self, monkeypatch, tmp_path):
        out = tmp_path / "out"
        _run(monkeypatch, out, [_ok(ICON_WEBP), _ok(EMPTY_WEBP)])
        assert (out / "empty-state.webp").read_bytes() == EMPTY_WEBP

    def test_success_overwrites_previous_files(self, monkeypatch, tmp_path):
        out = tmp_path / "out"
        seeded = _seed(out, ALL_FILES)
        code, _ = _run(monkeypatch, out, [_ok(ICON_WEBP), _ok(EMPTY_WEBP)])
        assert code == 0
        for name, data in seeded.items():
            assert (out / name).read_bytes() != data


# Covers: MEM-038
class TestGenAssetsFailure:
    @pytest.mark.parametrize(
        ("status", "error"),
        [(500, "500 http_error"), (None, "transport: ConnectError"), (200, "200 response_too_large")],
    )
    def test_icon_call_failure_keeps_icon_files_and_still_writes_empty_state(
        self, monkeypatch, tmp_path, capsys, status, error
    ):
        out = tmp_path / "out"
        seeded = _seed(out, ICON_FILES)
        code, factory = _run(monkeypatch, out, [_fail(status, error), _ok(EMPTY_WEBP)])
        captured = capsys.readouterr()
        assert code == 1
        assert f"icon: failed ({error})" in captured.err
        for name, data in seeded.items():
            assert (out / name).read_bytes() == data
        assert (out / "empty-state.webp").read_bytes() == EMPTY_WEBP
        assert str(out / "empty-state.webp") in captured.out
        assert len(factory.client.edits) == 2

    def test_empty_state_call_failure_keeps_its_file_after_icon_written(self, monkeypatch, tmp_path, capsys):
        out = tmp_path / "out"
        seeded = _seed(out, EMPTY_FILES)
        code, factory = _run(monkeypatch, out, [_ok(ICON_WEBP), _fail(503, "503 http_error")])
        captured = capsys.readouterr()
        assert code == 1
        assert "empty-state: failed (503 http_error)" in captured.err
        assert (out / "empty-state.webp").read_bytes() == seeded["empty-state.webp"]
        for name in ICON_FILES:
            assert Image.open(out / name).format == "PNG"
        assert len(factory.client.edits) == 2

    @pytest.mark.parametrize(
        "body", [_body(b"definitely not an image"), b"not json at all"], ids=["undecodable", "non_json"]
    )
    def test_ok_but_undecodable_icon_body_is_bad_image(self, monkeypatch, tmp_path, capsys, body):
        out = tmp_path / "out"
        seeded = _seed(out, ICON_FILES)
        code, _ = _run(monkeypatch, out, [_ok_raw(body), _ok(EMPTY_WEBP)])
        captured = capsys.readouterr()
        assert code == 1
        assert "icon: failed (bad_image)" in captured.err
        for name, data in seeded.items():
            assert (out / name).read_bytes() == data
        assert (out / "empty-state.webp").read_bytes() == EMPTY_WEBP

    def test_ok_but_undecodable_empty_state_body_is_bad_image(self, monkeypatch, tmp_path, capsys):
        out = tmp_path / "out"
        seeded = _seed(out, EMPTY_FILES)
        code, _ = _run(monkeypatch, out, [_ok(ICON_WEBP), _ok_raw(_body(b"garbage bytes"))])
        captured = capsys.readouterr()
        assert code == 1
        assert "empty-state: failed (bad_image)" in captured.err
        assert (out / "empty-state.webp").read_bytes() == seeded["empty-state.webp"]
        for name in ICON_FILES:
            assert (out / name).is_file()

    def test_both_fail_exits_1_with_one_line_each_and_no_files(self, monkeypatch, tmp_path, capsys):
        out = tmp_path / "out"
        code, factory = _run(
            monkeypatch, out, [_fail(500, "500 http_error"), _fail(None, "transport: ReadTimeout")]
        )
        captured = capsys.readouterr()
        assert code == 1
        assert "icon: failed (500 http_error)" in captured.err
        assert "empty-state: failed (transport: ReadTimeout)" in captured.err
        assert not out.exists() or list(out.iterdir()) == []
        assert len(factory.client.edits) == 2
