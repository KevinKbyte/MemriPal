# Covers: MEM-023
# Requirement: the offline demo covers the whole associate flow, not just loci. The committed
# fixtures ship demo speaker notes at fixtures/demo/notes.txt (non-blank UTF-8, within the 20 KB
# notes cap, listed in fixtures/MANIFEST.md) plus replay fixtures so that, in fixture mode, the
# notes-mode split of those notes against the processed demo photo replays to exactly one point
# per demo locus (12), each point a <= 100-char label with a source_quote copied verbatim from the
# notes, in speech order; and each of the 12 (point label, locus label) pairs, paired in order,
# replays an association whose status is "valid" with a record that passes the MEM-021 validator.
import socket
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import memripal.app as app_module
from memripal.app import create_app
from memripal.associate import associate, validate_association
from memripal.backend import FixtureBackend
from memripal.imaging import process_upload
from memripal.loci import find_loci
from memripal.split import MAX_LABEL_CHARS, MAX_NOTES_BYTES, MAX_POINTS, split_notes
from memripal.textnorm import normalize

REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO / "fixtures"
DEMO_PHOTO = FIXTURES / "demo" / "photo.jpg"
DEMO_NOTES = FIXTURES / "demo" / "notes.txt"
REPLAY_DIR = FIXTURES / "replay"
LOOPBACK_URL = "http://127.0.0.1"
JPEG_DATA_URL = "data:image/jpeg;base64,"
DEMO_PAIRS = 12


def _notes_text() -> str:
    assert DEMO_NOTES.is_file(), f"missing demo notes fixture {DEMO_NOTES.relative_to(REPO).as_posix()}"
    return DEMO_NOTES.read_bytes().decode("utf-8")


def _assert_points_shape(points, notes: str, count: int) -> None:
    assert isinstance(points, list)
    assert len(points) == count
    notes_norm = normalize(notes)
    positions = []
    for point in points:
        assert set(point) == {"label", "source_quote"}
        label, quote = point["label"], point["source_quote"]
        assert label.strip(), "blank point label"
        assert len(label) <= MAX_LABEL_CHARS
        assert normalize(quote), "blank source_quote"
        assert normalize(quote) in notes_norm, f"source_quote not verbatim in notes: {quote!r}"
        positions.append(notes_norm.index(normalize(quote)))
    assert positions == sorted(positions), "points are not in speech order"
    labels = [normalize(p["label"]) for p in points]
    assert len(set(labels)) == len(labels), "duplicate point labels"


@pytest.fixture(scope="module")
def demo():
    """The processed demo photo and its replayed loci: what POST /loci hands the client."""
    processed = process_upload(DEMO_PHOTO.read_bytes())
    # A frozen clock keeps the deadline out of play: replay is judged on keys alone.
    result = find_loci(FixtureBackend(REPLAY_DIR), processed, clock=lambda: 0.0)
    return processed, [lc.label for lc in result.loci]


@pytest.fixture(scope="module")
def demo_points(demo):
    """Replays the demo split once; a call inside each test keeps a missing fixture a FAILED test."""
    cache = {}

    def points():
        if "points" not in cache:
            processed, loci = demo
            notes = _notes_text()
            cache["points"] = split_notes(FixtureBackend(REPLAY_DIR), processed.jpeg, notes, len(loci))
        return cache["points"]

    return points


class TestDemoNotesFixture:
    def test_notes_file_is_committed_non_blank_utf8_within_notes_cap(self):
        notes = _notes_text()
        assert notes.strip(), "demo notes are blank"
        assert len(notes.encode("utf-8")) <= MAX_NOTES_BYTES

    def test_manifest_lists_demo_notes(self):
        text = (FIXTURES / "MANIFEST.md").read_text(encoding="utf-8")
        assert "`demo/notes.txt`" in text

    def test_demo_has_twelve_loci_to_pair_with(self, demo):
        _, loci = demo
        assert len(loci) == DEMO_PAIRS == MAX_POINTS


# Covers: MEM-023
# Requirement: the notes text is part of the split replay key, so a checkout must hold the exact
# bytes the generator keyed on. With core.autocrlf=true (Windows) a plain text file is rewritten to
# CRLF on checkout and its split replay silently misses; git therefore treats
# fixtures/demo/notes.txt as LF-only (eol=lf) or as binary (-text).
class TestDemoNotesLineEndings:
    def test_git_never_rewrites_demo_notes_line_endings(self):
        out = subprocess.run(
            ["git", "check-attr", "text", "eol", "--", "fixtures/demo/notes.txt"],
            cwd=str(REPO),
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        ).stdout
        attrs = dict(line.rsplit(": ", 2)[1:] for line in out.splitlines() if line.count(": ") >= 2)
        assert attrs.get("text") == "unset" or attrs.get("eol") == "lf", out


class TestDemoSplitReplay:
    def test_replayed_split_yields_one_verbatim_point_per_locus_in_speech_order(self, demo, demo_points):
        _, loci = demo
        _assert_points_shape(demo_points(), _notes_text(), len(loci))


class TestDemoAssociationReplay:
    @pytest.mark.parametrize("i", range(DEMO_PAIRS))
    def test_replayed_association_for_pair_is_valid(self, demo, demo_points, i):
        processed, loci = demo
        points = demo_points()
        assert len(points) == DEMO_PAIRS
        item, locus = points[i]["label"], loci[i]
        result = associate(FixtureBackend(REPLAY_DIR), processed, item, locus)
        assert result.status == "valid", f"pair {i} ({item!r} @ {locus!r}): {result.reason}"
        assert 1 <= result.attempts <= 3
        assert validate_association(result.record, item, locus) is None


# Covers: MEM-023
# Requirement: the server serves the committed demo notes at GET /demo/notes.txt (200, text/plain,
# byte-identical to fixtures/demo/notes.txt) so the "Load demo" path can fill the notes box without
# a client copy; when the file is missing it answers 404 {"error": "demo_missing"} JSON, never a 500.
class TestDemoNotesRoute:
    @staticmethod
    def _client():
        return TestClient(create_app(backend=FixtureBackend(REPLAY_DIR)), base_url=LOOPBACK_URL)

    def test_demo_notes_served_byte_identical_as_text_plain(self):
        resp = self._client().get("/demo/notes.txt")
        assert resp.status_code == 200, resp.text[:200]
        assert resp.headers["content-type"].split(";")[0].strip() == "text/plain"
        assert resp.content == DEMO_NOTES.read_bytes()

    def test_missing_demo_notes_is_404_demo_missing_json(self, monkeypatch, tmp_path):
        monkeypatch.setattr(app_module, "DEMO_NOTES", tmp_path / "absent" / "notes.txt")
        client = TestClient(
            create_app(backend=FixtureBackend(tmp_path)),
            base_url=LOOPBACK_URL,
            raise_server_exceptions=False,
        )
        resp = client.get("/demo/notes.txt")
        assert resp.status_code == 404, resp.text[:200]
        assert resp.headers["content-type"].startswith("application/json")
        assert resp.json() == {"error": "demo_missing"}


def _no_network(*args, **kwargs):
    raise AssertionError("offline demo attempted a network connection")


# Covers: MEM-023
# Requirement: the full demo runs offline end to end through the real HTTP API in fixture mode with
# all name resolution and outbound connections blocked: GET /demo/photo.jpg -> POST /loci (the served
# bytes) -> GET /demo/notes.txt -> POST /split (mode notes, the processed photo from /loci, one point
# per locus) -> POST /associate for each of the 12 (point label, locus label) pairs in order, with
# the /loci data URL; every association answers 200 with status "valid" and a record that passes the
# MEM-021 validator.
class TestOfflineDemoEndToEnd:
    def test_upload_loci_split_associate_all_valid_without_network(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_MODE", "fixture")
        monkeypatch.delenv("META_API_KEY", raising=False)
        monkeypatch.setattr(socket, "getaddrinfo", _no_network)
        monkeypatch.setattr(socket, "create_connection", _no_network)
        client = TestClient(create_app(), base_url=LOOPBACK_URL)
        assert client.get("/healthz").json()["mode"] == "fixture"

        photo = client.get("/demo/photo.jpg")
        assert photo.status_code == 200, photo.text[:200]
        loci_resp = client.post("/loci", content=photo.content, headers={"Content-Type": "image/jpeg"})
        assert loci_resp.status_code == 200, loci_resp.text[:200]
        body = loci_resp.json()
        image, loci = body["image"], [lc["label"] for lc in body["loci"]]
        assert image.startswith(JPEG_DATA_URL)
        assert len(loci) == DEMO_PAIRS

        notes_resp = client.get("/demo/notes.txt")
        assert notes_resp.status_code == 200, notes_resp.text[:200]
        notes = notes_resp.content.decode("utf-8")
        split_resp = client.post(
            "/split",
            json={
                "photo": image[len(JPEG_DATA_URL) :],
                "mode": "notes",
                "text": notes,
                "loci_count": len(loci),
            },
        )
        assert split_resp.status_code == 200, split_resp.text[:200]
        points = split_resp.json()["points"]
        _assert_points_shape(points, notes, len(loci))

        failures = []
        for i, (point, locus) in enumerate(zip(points, loci, strict=True)):
            item = point["label"]
            resp = client.post("/associate", json={"image": image, "item": item, "locus": locus})
            if resp.status_code != 200:
                failures.append((i, item, locus, resp.status_code, resp.text[:120]))
                continue
            result = resp.json()
            if result["status"] != "valid" or validate_association(result["record"], item, locus):
                failures.append((i, item, locus, result["status"], result["attempts"]))
        assert failures == []
