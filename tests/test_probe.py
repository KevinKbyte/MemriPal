# Covers: MEM-008
# Requirement: the live probe runs Spark phrase listing, per-phrase SAM, locus selection
# (with exactly one Spark re-ask round when fewer than 10 loci survive), one association
# and the tier-1 (whole photo) and tier-2 (crop) toothbrush edits, then reports phrases,
# kept loci, the 5 plan checks and every call's outcome; failed calls are recorded, never
# raised, with dependent results null; malformed HTTP-200 bodies (unparseable JSON, empty
# choices, undecodable image bytes, decompression-bomb images, inverted SAM boxes) null
# only the affected report field and the run continues; the report never holds the key
# or raw image bytes; and probe_live.py refuses to run (exit 2) when META_API_KEY is absent.
import base64
import importlib.util
import itertools
import json
import os
import subprocess
import sys
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image

from memripal.meta_client import MetaClient, to_data_url
from memripal.probe import run_probe

REPO_ROOT = Path(__file__).resolve().parents[1]
PROBE_SCRIPT = REPO_ROOT / "scripts" / "probe_live.py"

# Built by concatenation so this file never matches the pre-commit secret scanner (MEM-004).
KEY = "fake" + "-probe-" + "q" * 24

ALL_PHRASES = [
    "armchair",
    "bookcase",
    "clock",
    "doormat",
    "easel",
    "fern",
    "guitar",
    "hat rack",
    "ironing board",
    "jar",
    "kettle",
    "ladder",
    "mirror",
    "nightstand",
    "ottoman",
    "piano",
    "quilt",
]
EXPECTED_CHECKS = {"schema_image_ok", "parser_installs", "score_present", "image_output_dims", "drift_metric"}
CALL_KEYS = {"kind", "ok", "status", "attempts", "latency_s", "error"}


def _photo() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (1000, 1000), (90, 110, 130)).save(buf, format="JPEG")
    return buf.getvalue()


def _edited_webp() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (640, 480), (200, 40, 40)).save(buf, format="WEBP")
    return buf.getvalue()


PHOTO = _photo()
EDITED = _edited_webp()


def _token(phrase: str, with_conf: bool) -> str:
    """Non-overlapping box per phrase on a 5x5 grid of 200px cells; earlier phrases are larger."""
    i = ALL_PHRASES.index(phrase)
    x1, y1 = (i % 5) * 200, (i // 5) * 200
    width = 100 + 5 * (len(ALL_PHRASES) - i)  # >= 105 * 60 = 6300 px > 0.5% of 1e6
    tok = f"<|box;x1={x1};y1={y1};x2={x1 + width};y2={y1 + 60};w=1000;h=1000"
    return tok + (";c=0.9|>" if with_conf else "|>")


class FakeMeta:
    """MockTransport handler emulating the three Meta endpoints, recording each payload."""

    def __init__(self, rounds, *, phrase_status=200, edit_status=200, with_conf=True):
        self.rounds = list(rounds)
        self.phrase_status = phrase_status
        self.edit_status = edit_status
        self.with_conf = with_conf
        self.phrase_calls: list[dict] = []
        self.assoc_calls: list[dict] = []
        self.sam_calls: list[dict] = []
        self.edit_calls: list[dict] = []

    @staticmethod
    def _chat(obj) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(obj)}}]})

    @staticmethod
    def _error(status) -> httpx.Response:
        error = {"message": "x", "type": "t", "param": None, "code": "e"}
        return httpx.Response(status, json={"error": error})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        path = request.url.path
        if path.endswith("/chat/completions"):
            schema_text = json.dumps(payload["response_format"]["json_schema"]["schema"])
            if '"phrases"' in schema_text:
                self.phrase_calls.append(payload)
                if self.phrase_status != 200:
                    return self._error(self.phrase_status)
                idx = len(self.phrase_calls) - 1
                phrases = self.rounds[idx] if idx < len(self.rounds) else []
                return self._chat({"phrases": phrases})
            self.assoc_calls.append(payload)
            return self._chat({"item": "toothbrush", "locus": "x", "scene": "a scene"})
        if path.endswith("/responses"):
            self.sam_calls.append(payload)
            phrase = payload["input"][0]["content"][0]["text"]
            text = _token(phrase, self.with_conf) if phrase in ALL_PHRASES else ""
            return httpx.Response(200, json={"output_text": text})
        if path.endswith("/images/edits"):
            self.edit_calls.append(payload)
            if self.edit_status != 200:
                return self._error(self.edit_status)
            return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(EDITED).decode()}]})
        return httpx.Response(404, json={"error": {"code": "not_found"}})


def probe(fake: FakeMeta) -> dict:
    client = MetaClient(KEY, transport=httpx.MockTransport(fake), sleep=lambda s: None, rand=lambda: 0.0)
    clock = itertools.count(0.0, 0.25).__next__
    return run_probe(client, PHOTO, clock=clock)


def _texts(payload: dict) -> str:
    return " ".join(
        part.get("text", "")
        for msg in payload["messages"]
        for part in msg["content"]
        if part["type"] == "text"
    )


class TestRunProbeHappy:
    # Covers: MEM-008

    def setup_method(self):
        self.fake = FakeMeta([ALL_PHRASES[:12]])
        self.report = probe(self.fake)

    def test_kept_loci_and_no_reask(self):
        r = self.report
        assert r["reask_used"] is False
        assert len(self.fake.phrase_calls) == 1
        assert r["kept_count"] >= 10
        assert r["kept_count"] == len(r["kept_loci"])
        assert set(r["phrases"]) == set(ALL_PHRASES[:12])
        assert all(set(k) == {"phrase", "box"} for k in r["kept_loci"])
        assert r["kept_loci"][0]["phrase"] == "armchair"

    def test_phrase_call_carries_image_and_sam_runs_per_phrase(self):
        first = self.fake.phrase_calls[0]
        assert "image_url" in json.dumps(first["messages"])
        assert [p["input"][0]["content"][0]["text"] for p in self.fake.sam_calls] == ALL_PHRASES[:12]

    def test_checks_exact_keys_and_values(self):
        checks = self.report["checks"]
        assert set(checks) == EXPECTED_CHECKS
        assert checks["schema_image_ok"] is True
        assert checks["parser_installs"] is (importlib.util.find_spec("meta_sam_parser") is not None)
        assert checks["score_present"] is True
        assert checks["image_output_dims"] == [640, 480]
        assert isinstance(checks["drift_metric"], float)
        assert checks["drift_metric"] >= 0.0

    def test_association_without_image_on_first_locus(self):
        assert len(self.fake.assoc_calls) == 1
        assoc = self.fake.assoc_calls[0]
        assert "image_url" not in json.dumps(assoc["messages"])
        schema_text = json.dumps(assoc["response_format"]["json_schema"]["schema"])
        for key in ("item", "locus", "scene"):
            assert f'"{key}"' in schema_text
        text = _texts(assoc)
        assert "toothbrush" in text and "armchair" in text

    def test_tier1_whole_photo_then_tier2_crop(self):
        assert len(self.fake.edit_calls) == 2
        tier1, tier2 = self.fake.edit_calls
        assert tier1["prompt"] == "add a giant toothbrush at the armchair; keep everything else exactly as is"
        assert tier1["images"][0]["image_url"] == to_data_url(PHOTO)
        assert tier2["images"][0]["image_url"] != to_data_url(PHOTO)
        assert tier2["images"][0]["image_url"].startswith("data:image/jpeg;base64,")

    def test_calls_recorded(self):
        calls = self.report["calls"]
        assert len(calls) == 1 + 12 + 1 + 2
        assert all(set(c) == CALL_KEYS for c in calls)
        assert all(c["ok"] is True and c["status"] == 200 and c["error"] is None for c in calls)
        assert all(isinstance(c["kind"], str) and c["kind"] for c in calls)

    def test_report_serialisable_without_key_or_raw_images(self):
        dumped = json.dumps(self.report)
        assert KEY not in dumped
        assert base64.b64encode(PHOTO).decode()[:200] not in dumped
        assert base64.b64encode(EDITED).decode()[:200] not in dumped


class TestRunProbeReask:
    # Covers: MEM-008

    def test_reask_round_when_fewer_than_ten_kept(self):
        fake = FakeMeta([ALL_PHRASES[:8], ALL_PHRASES[12:17]])
        r = probe(fake)
        assert r["reask_used"] is True
        assert len(fake.phrase_calls) == 2
        reask_text = _texts(fake.phrase_calls[1])
        for kept in ALL_PHRASES[:8]:
            assert kept in reask_text
        assert r["kept_count"] == 13
        assert len(fake.sam_calls) == 13
        assert r["kept_loci"][0]["phrase"] == "armchair"

    def test_only_one_reask_even_if_still_short(self):
        fake = FakeMeta([ALL_PHRASES[:8], ALL_PHRASES[12:13], ALL_PHRASES[13:17]])
        r = probe(fake)
        assert r["reask_used"] is True
        assert len(fake.phrase_calls) == 2
        assert r["kept_count"] == 9
        assert len(fake.edit_calls) == 2

    def test_score_absent_when_no_confidence(self):
        r = probe(FakeMeta([ALL_PHRASES[:12]], with_conf=False))
        assert r["checks"]["score_present"] is False


class TestRunProbeFailures:
    # Covers: MEM-008

    def test_failed_spark_recorded_not_raised(self):
        fake = FakeMeta([ALL_PHRASES[:12]], phrase_status=400)
        r = probe(fake)
        assert r["kept_count"] == 0
        assert r["kept_loci"] == []
        checks = r["checks"]
        assert set(checks) == EXPECTED_CHECKS
        assert checks["schema_image_ok"] is False
        assert checks["score_present"] is False
        assert checks["image_output_dims"] is None
        assert checks["drift_metric"] is None
        failed = [c for c in r["calls"] if c["ok"] is False]
        assert failed and failed[0]["status"] == 400 and failed[0]["error"].startswith("400")
        assert fake.edit_calls == []
        assert fake.assoc_calls == []
        assert KEY not in json.dumps(r)

    def test_failed_edits_give_null_dims_and_drift(self):
        fake = FakeMeta([ALL_PHRASES[:12]], edit_status=413)
        r = probe(fake)
        assert r["checks"]["image_output_dims"] is None
        assert r["checks"]["drift_metric"] is None
        edit_failures = [c for c in r["calls"] if c["status"] == 413]
        assert len(edit_failures) == 2
        assert all(c["ok"] is False and c["attempts"] == 1 for c in edit_failures)
        json.dumps(r)


class MalformedMeta(FakeMeta):
    """FakeMeta whose chosen endpoint answers HTTP 200 with a body the parsers cannot read."""

    def __init__(self, rounds, *, malformed: str):
        super().__init__(rounds)
        self.malformed = malformed

    def __call__(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        path = request.url.path
        is_chat = path.endswith("/chat/completions")
        is_phrase = is_chat and '"phrases"' in json.dumps(payload["response_format"]["json_schema"]["schema"])
        if self.malformed == "phrases" and is_phrase:
            self.phrase_calls.append(payload)
            return httpx.Response(200, json={"choices": []})
        if self.malformed == "association" and is_chat and not is_phrase:
            self.assoc_calls.append(payload)
            return httpx.Response(200, json={"choices": [{"message": {"content": "not json {"}}]})
        if self.malformed == "edit" and path.endswith("/images/edits"):
            self.edit_calls.append(payload)
            junk = base64.b64encode(b"definitely not an image").decode()
            return httpx.Response(200, json={"data": [{"b64_json": junk}]})
        return super().__call__(request)


class TestRunProbeMalformedResponses:
    # Covers: MEM-008

    def test_malformed_phrase_body_nulls_schema_check_and_continues(self):
        fake = MalformedMeta([ALL_PHRASES[:12]], malformed="phrases")
        r = probe(fake)
        assert r["checks"]["schema_image_ok"] is False
        assert r["kept_count"] == 0
        assert r["association"] is None
        assert r["association_skipped"] == "no kept loci"
        assert [c["ok"] for c in r["calls"] if c["kind"] == "spark_phrases"] == [True]
        json.dumps(r)

    def test_malformed_association_body_gives_null_association_and_edits_still_run(self):
        fake = MalformedMeta([ALL_PHRASES[:12]], malformed="association")
        r = probe(fake)
        assert r["association"] is None
        assert len(fake.assoc_calls) == 1
        assert len(fake.edit_calls) == 2
        assert r["checks"]["image_output_dims"] == [640, 480]
        assert isinstance(r["checks"]["drift_metric"], float)

    def test_undecodable_edit_image_gives_null_dims_and_drift(self):
        fake = MalformedMeta([ALL_PHRASES[:12]], malformed="edit")
        r = probe(fake)
        assert len(fake.edit_calls) == 2
        assert r["tier1"]["dims"] is None
        assert r["tier2"]["dims"] is None
        assert r["checks"]["image_output_dims"] is None
        assert r["checks"]["drift_metric"] is None
        assert r["association"] == {"item": "toothbrush", "locus": "x", "scene": "a scene"}
        json.dumps(r)


class HostileMeta(FakeMeta):
    """FakeMeta whose SAM answers with a fixed token and/or whose edits return fixed image bytes."""

    def __init__(self, rounds, *, sam_text: str | None = None, edit_image: bytes | None = None):
        super().__init__(rounds)
        self.sam_text = sam_text
        self.edit_image = edit_image

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if self.sam_text is not None and path.endswith("/responses"):
            self.sam_calls.append(json.loads(request.content))
            return httpx.Response(200, json={"output_text": self.sam_text})
        if self.edit_image is not None and path.endswith("/images/edits"):
            self.edit_calls.append(json.loads(request.content))
            b64 = base64.b64encode(self.edit_image).decode()
            return httpx.Response(200, json={"data": [{"b64_json": b64}]})
        return super().__call__(request)


class TestRunProbeHostileResponses:
    # Covers: MEM-008

    def test_only_inverted_sam_boxes_finish_with_no_kept_loci(self):
        inverted = "<|box;x1=600;y1=600;x2=400;y2=400;w=1000;h=1000;c=0.9|>"
        fake = HostileMeta([ALL_PHRASES[:12]], sam_text=inverted)
        r = probe(fake)
        assert r["kept_count"] == 0
        assert r["kept_loci"] == []
        assert r["association_skipped"] == "no kept loci"
        assert fake.edit_calls == []
        assert r["checks"]["image_output_dims"] is None
        json.dumps(r)

    def test_decompression_bomb_edit_image_gives_null_dims(self, monkeypatch):
        # 1500x1500 = 2.25 Mpx exceeds 2 * MAX_IMAGE_PIXELS, so PIL raises DecompressionBombError;
        # the 1000x1000 input photo (1 Mpx) stays under the limit.
        buf = BytesIO()
        Image.new("RGB", (1500, 1500), (10, 20, 30)).save(buf, format="WEBP")
        monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 1_000_000)
        fake = HostileMeta([ALL_PHRASES[:12]], edit_image=buf.getvalue())
        r = probe(fake)
        assert len(fake.edit_calls) == 2
        assert r["tier1"]["dims"] is None
        assert r["tier2"]["dims"] is None
        assert r["checks"]["image_output_dims"] is None
        assert r["checks"]["drift_metric"] is None
        json.dumps(r)


class TestProbeLiveScript:
    # Covers: MEM-008

    def test_missing_key_exits_2_without_reading_photo(self, tmp_path):
        env = {k: v for k, v in os.environ.items() if k != "META_API_KEY"}
        missing_photo = tmp_path / "does-not-exist.jpg"
        out_dir = tmp_path / "out"
        proc = subprocess.run(
            [sys.executable, str(PROBE_SCRIPT), "--photo", str(missing_photo), "--out", str(out_dir)],
            env=env,
            cwd=tmp_path,
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert proc.returncode == 2
        assert "META_API_KEY" in proc.stderr
        assert "Traceback" not in proc.stderr
        assert "FileNotFoundError" not in proc.stderr
        assert not out_dir.exists()
