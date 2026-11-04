# Covers: MEM-132
# Requirement: scripts/gen_landmark_slots_fixture.py <photo> [--out PATH] runs /loci in-process (fixture mode,
# no live calls) and writes the bundled landmark-slots fixture, a /loci reply: {image (data URL), width,
# height, photo_sha, reask_used, loci}, with at least SLOT_COUNT (3) loci; a missing photo exits nonzero
# and writes nothing. MEMRIPAL_MODE=meta with META_API_KEY unset exits 1 with a
# "gen_landmark_slots_fixture:" stderr naming META_API_KEY and writes nothing.
import importlib.util
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "gen_landmark_slots_fixture.py"
PHOTO = REPO_ROOT / "fixtures" / "demo" / "photo.jpg"


def _main(*argv: str) -> int:
    spec = importlib.util.spec_from_file_location("gen_landmark_slots_fixture_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        return module.main(list(argv))
    except SystemExit as exc:
        return exc.code


class TestGenLandmarkSlotsFixture:
    def test_writes_loci_reply_with_three_or_more_loci(self, tmp_path):
        out = tmp_path / "x.json"
        assert _main(str(PHOTO), "--out", str(out)) == 0
        data = json.loads(out.read_text(encoding="utf-8"))
        prefixes = tuple(f"data:image/{t};base64," for t in ("jpeg", "png", "webp"))
        assert data["image"].startswith(prefixes)
        assert isinstance(data["width"], int) and data["width"] > 0
        assert isinstance(data["height"], int) and data["height"] > 0
        assert isinstance(data["loci"], list) and len(data["loci"]) >= 3

    def test_missing_photo_exits_nonzero_and_writes_nothing(self, tmp_path):
        out = tmp_path / "x.json"
        code = _main(str(tmp_path / "nope.jpg"), "--out", str(out))
        assert code not in (0, None)
        assert not out.exists()

    def test_meta_mode_without_api_key_exits_1_and_writes_nothing(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setenv("MEMRIPAL_MODE", "meta")
        monkeypatch.delenv("META_API_KEY", raising=False)
        out = tmp_path / "x.json"
        code = _main(str(PHOTO), "--out", str(out))
        err = capsys.readouterr().err
        assert code == 1
        assert err.startswith("gen_landmark_slots_fixture:")
        assert "META_API_KEY" in err
        assert not out.exists()
