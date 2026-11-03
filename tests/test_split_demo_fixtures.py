# Covers: MEM-087
# Requirement: the Memorize demo text ships as a committed fixture: fixtures/demo/study_techniques.txt
# holds the 6 evidence-based study techniques (retrieval practice, spaced practice, interleaving,
# elaboration, concrete examples, dual coding), one paragraph each in that order, as non-blank
# LF-only UTF-8 within the 20 KB notes cap. It is listed in fixtures/MANIFEST.md, and git never
# rewrites its line endings (eol=lf or -text), because the notes text is part of the split replay key.
import base64
import socket
import subprocess
from pathlib import Path

from fastapi.testclient import TestClient

from memripal.app import create_app
from memripal.backend import FixtureBackend, FixtureMissing, ResponseCache
from memripal.imaging import validate_processed
from memripal.split import MAX_LABEL_CHARS, MAX_NOTES_BYTES, split_notes
from memripal.textnorm import normalize

REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO / "fixtures"
STUDY_NOTES = FIXTURES / "demo" / "study_techniques.txt"
STUDY_NOTES_REL = "fixtures/demo/study_techniques.txt"
SENTINEL_PHOTO = FIXTURES / "demo" / "photo.jpg"
REPLAY_DIR = FIXTURES / "replay"
LOOPBACK_URL = "http://127.0.0.1"
# The Kendall demo route (static/demo_route.js) has 6 stations: one technique per station.
DEMO_STATIONS = 6
# (technique, stem its keyword label must contain), in speech order.
TECHNIQUES = (
    ("retrieval practice", "retriev"),
    ("spaced practice", "spac"),
    ("interleaving", "interleav"),
    ("elaboration", "elaborat"),
    ("concrete examples", "concrete"),
    ("dual coding", "dual"),
)


def _notes_bytes() -> bytes:
    assert STUDY_NOTES.is_file(), f"missing demo notes fixture {STUDY_NOTES_REL}"
    return STUDY_NOTES.read_bytes()


def _notes_text() -> str:
    return _notes_bytes().decode("utf-8")


def _paragraphs(notes: str) -> list[str]:
    return [p.strip() for p in notes.split("\n\n") if p.strip()]


def _sentinel_jpeg() -> bytes:
    return SENTINEL_PHOTO.read_bytes()


class TestStudyTechniquesNotesFixture:
    def test_notes_are_committed_non_blank_lf_only_utf8_within_notes_cap(self):
        raw = _notes_bytes()
        notes = raw.decode("utf-8")
        assert notes.strip(), "demo notes are blank"
        assert len(raw) <= MAX_NOTES_BYTES
        assert b"\r" not in raw, "demo notes must be LF-only (the text keys the split replay)"
        assert raw.isascii(), "demo notes must be ASCII-only"

    def test_notes_hold_one_paragraph_per_technique_in_order(self):
        paragraphs = _paragraphs(_notes_text())
        assert len(paragraphs) == len(TECHNIQUES) == DEMO_STATIONS
        for paragraph, (technique, _) in zip(paragraphs, TECHNIQUES, strict=True):
            assert normalize(paragraph).startswith(technique), (technique, paragraph[:60])

    def test_manifest_lists_study_techniques_notes(self):
        text = (FIXTURES / "MANIFEST.md").read_text(encoding="utf-8")
        assert "`demo/study_techniques.txt`" in text

    def test_git_never_rewrites_study_notes_line_endings(self):
        out = subprocess.run(
            ["git", "check-attr", "text", "eol", "--", STUDY_NOTES_REL],
            cwd=str(REPO),
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        ).stdout
        attrs = dict(line.rsplit(": ", 2)[1:] for line in out.splitlines() if line.count(": ") >= 2)
        assert attrs.get("text") == "unset" or attrs.get("eol") == "lf", out


def _assert_six_technique_keywords(points, notes: str) -> None:
    assert isinstance(points, list)
    assert len(points) == DEMO_STATIONS, [p.get("label") for p in points]
    paragraphs = [normalize(p) for p in _paragraphs(notes)]
    for i, (point, (technique, stem)) in enumerate(zip(points, TECHNIQUES, strict=True)):
        assert set(point) == {"label", "source_quote"}
        label, quote = point["label"], point["source_quote"]
        assert label.strip() and len(label) <= MAX_LABEL_CHARS, label
        assert stem in normalize(label), f"keyword {i} {label!r} does not name {technique!r}"
        quote_norm = normalize(quote)
        assert quote_norm, f"keyword {i} has a blank source_quote"
        assert quote_norm in paragraphs[i], f"keyword {i} quote {quote!r} is not from the {technique!r} text"


# Covers: MEM-087
# Requirement: in fixture mode the Memorize breakdown of the 6-technique demo text replays from
# committed fixtures: a notes-mode split of fixtures/demo/study_techniques.txt for the 6-station demo
# route (loci_count 6), keyed on the sentinel JPEG fixtures/demo/photo.jpg (the committed demo photo,
# sent unchanged; split never sends the image to the model), yields exactly 6 keywords, one per
# technique in speech order, each label naming its technique and each source_quote copied verbatim
# from that technique's paragraph. Every request the split issues under the current templates digest
# has a recorded replay fixture, so the demo needs no live call.
class TestStudyTechniquesSplitReplay:
    def test_sentinel_photo_is_accepted_unchanged_as_a_processed_photo(self):
        jpeg = _sentinel_jpeg()
        assert validate_processed(jpeg).jpeg == jpeg

    def test_every_split_request_under_the_current_templates_digest_has_a_replay_fixture(self):
        cache = ResponseCache(REPLAY_DIR)
        replay = FixtureBackend(REPLAY_DIR)
        missing = []

        class _Recording:
            mode = "fixture"

            def call(self, req):
                try:
                    return replay.call(req)
                except FixtureMissing:
                    missing.append(cache.path_for(req.cache_key()).relative_to(REPO).as_posix())
                    raise

        try:
            split_notes(_Recording(), _sentinel_jpeg(), _notes_text(), DEMO_STATIONS)
        except FixtureMissing:
            pass
        assert missing == [], f"split replay fixtures to record: {missing}"

    def test_replayed_split_yields_exactly_six_technique_keywords_in_order(self):
        notes = _notes_text()
        points = split_notes(FixtureBackend(REPLAY_DIR), _sentinel_jpeg(), notes, DEMO_STATIONS)
        _assert_six_technique_keywords(points, notes)


def _no_network(*args, **kwargs):
    raise AssertionError("fixture-mode split attempted a network connection")


# Covers: MEM-087
# Requirement: the Memorize split runs offline through the real HTTP API in fixture mode with all
# name resolution and outbound connections blocked: GET /demo/photo.jpg (the sentinel) -> POST /split
# (mode notes, the 6-technique demo text, loci_count 6) answers 200 with exactly the 6 technique
# keywords, making 0 live model calls.
class TestStudyTechniquesOfflineSplit:
    def test_split_over_http_returns_six_technique_keywords_without_network(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_MODE", "fixture")
        monkeypatch.delenv("META_API_KEY", raising=False)
        monkeypatch.setattr(socket, "getaddrinfo", _no_network)
        monkeypatch.setattr(socket, "create_connection", _no_network)
        client = TestClient(create_app(), base_url=LOOPBACK_URL)
        assert client.get("/healthz").json()["mode"] == "fixture"

        photo = client.get("/demo/photo.jpg")
        assert photo.status_code == 200, photo.text[:200]
        assert photo.content == _sentinel_jpeg()
        notes = _notes_text()
        resp = client.post(
            "/split",
            json={
                "photo": base64.b64encode(photo.content).decode("ascii"),
                "mode": "notes",
                "text": notes,
                "loci_count": DEMO_STATIONS,
            },
        )
        assert resp.status_code == 200, resp.text[:200]
        _assert_six_technique_keywords(resp.json()["points"], notes)
