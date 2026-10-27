import dataclasses
import hashlib
import json
import threading

import httpx
import pytest

# Package-level import: a missing find_loci/LociResult fails each test, not collection.
from memripal import loci
from memripal.backend import BackendCallFailed, FixtureBackend, MetaBackend, ResponseCache
from memripal.imaging import Processed
from memripal.meta_client import MetaClient
from memripal.probe import PHRASE_PROMPT, PHRASE_SCHEMA

W, H = 1000, 800  # diagonal ~1280.6 px; 5% spacing ~64 px; 0.5% area = 4000
IMAGE = b"\xff\xd8\xff\xe0fake-processed-jpeg-bytes\xff\xd9"
PROCESSED = Processed(jpeg=IMAGE, width=W, height=H, sha=hashlib.sha256(IMAGE).hexdigest())
FAKE_KEY = "fake-test-key-0123456789abcdefXYZ"
SAFETY_S = 5.0  # bounds a wrong implementation's hang; never reached by a correct one

NOUNS = [
    "lamp", "chair", "desk", "sofa", "clock", "plant", "rug", "shelf", "door", "window",
    "mirror", "vase", "bench", "stool", "piano", "radio", "kettle", "fridge", "oven", "sink",
]  # fmt: skip
CELL = {noun: i for i, noun in enumerate(NOUNS)}


def token(i: int) -> str:
    """120 px square in cell i of a 5x4 grid of 200 px cells: separated, 1.8% of the image."""
    x1, y1 = 20 + 200 * (i % 5), 20 + 200 * (i // 5)
    return f"<|box;x1={x1};y1={y1};x2={x1 + 120};y2={y1 + 120};w={W};h={H}|>"


def sam_text(phrase: str) -> str:
    return token(CELL[phrase]) if phrase in CELL else ""


class FakeBackend:
    """In-process ModelBackend: phrases for the first ask, `reask` for the re-ask, SAM by phrase."""

    mode = "fake"

    def __init__(self, phrases, reask=(), sam=None):
        self.phrases = phrases
        self.reask = list(reask)
        self.sam = sam or {}
        self.requests = []
        self._lock = threading.Lock()

    def call(self, req):
        with self._lock:
            self.requests.append(req)
        if req.method == "spark_json":
            if req.subject == "phrases":
                if isinstance(self.phrases, Exception):
                    raise self.phrases
                return {"phrases": list(self.phrases)}
            if req.subject == "phrases-reask":
                return {"phrases": list(self.reask)}
            raise AssertionError(f"unexpected spark subject {req.subject!r}")
        if req.method == "segment":
            answer = self.sam.get(req.subject, sam_text)
            if isinstance(answer, Exception):
                raise answer
            return answer(req.subject) if callable(answer) else answer
        raise AssertionError(f"unexpected method {req.method!r}")

    def of(self, method, subject=None):
        return [r for r in self.requests if r.method == method and (subject is None or r.subject == subject)]

    def segment_subjects(self):
        return [r.subject for r in self.of("segment")]


def find(backend, **kw):
    return loci.find_loci(backend, PROCESSED, **kw)


def locus_phrases(result):
    return {lc.phrase for lc in result.loci}


# Covers: MEM-014
# Requirement: find_loci asks Spark once for object phrases (subject "phrases", PHRASE_SCHEMA,
# the processed image), runs SAM once per phrase on the same image, and returns a frozen
# LociResult(loci, phrases, reask_used); 12 well-separated phrases give 12 numbered loci
# with no re-ask.
class TestFindLociHappyPath:
    def test_twelve_good_phrases_give_twelve_loci_without_reask(self):
        fake = FakeBackend(NOUNS[:12])
        result = find(fake)
        assert len(result.loci) == 12
        assert [lc.n for lc in result.loci] == list(range(1, 13))
        assert locus_phrases(result) == set(NOUNS[:12])
        assert result.reask_used is False
        assert fake.of("spark_json", "phrases-reask") == []

    def test_result_is_frozen_lociresult(self):
        result = find(FakeBackend(NOUNS[:12]))
        assert isinstance(result, loci.LociResult)
        assert all(isinstance(lc, loci.Locus) for lc in result.loci)
        with pytest.raises(dataclasses.FrozenInstanceError):
            result.reask_used = True

    def test_phrases_lists_the_cleaned_phrases(self):
        result = find(FakeBackend(NOUNS[:12]))
        assert sorted(result.phrases) == sorted(NOUNS[:12])

    def test_phrase_request_carries_image_and_schema(self):
        fake = FakeBackend(NOUNS[:12])
        find(fake)
        [first] = fake.of("spark_json", "phrases")
        assert first.image_jpeg == IMAGE
        assert first.schema == PHRASE_SCHEMA

    def test_one_sam_call_per_phrase_on_the_same_image(self):
        fake = FakeBackend(NOUNS[:12])
        find(fake)
        assert sorted(fake.segment_subjects()) == sorted(NOUNS[:12])
        assert all(r.image_jpeg == IMAGE for r in fake.of("segment"))


# Covers: MEM-014
# Requirement: when fewer than 10 loci survive selection, find_loci re-asks Spark exactly once
# (subject "phrases-reask") with the already-kept phrases as an exclude list, runs SAM only on
# phrases it has not already segmented (case-folded), and re-selects; reask_used is True.
class TestReask:
    REASK = ["mirror", "vase", "bench", "stool", "piano", "LAMP", "chair"]

    def test_seven_phrases_reask_once_and_reach_ten(self):
        fake = FakeBackend(NOUNS[:7], reask=self.REASK)
        result = find(fake)
        assert len(fake.of("spark_json", "phrases-reask")) == 1
        assert result.reask_used is True
        assert len(result.loci) >= 10

    def test_sam_runs_only_on_new_reask_phrases(self):
        fake = FakeBackend(NOUNS[:7], reask=self.REASK)
        find(fake)
        folded = [s.casefold() for s in fake.segment_subjects()]
        assert sorted(folded) == sorted(NOUNS[:7] + ["mirror", "vase", "bench", "stool", "piano"])

    def test_reask_request_depends_on_the_exclude_list(self):
        a, b = FakeBackend(NOUNS[:7], reask=[]), FakeBackend(NOUNS[7:14], reask=[])
        find(a)
        find(b)
        [ra] = a.of("spark_json", "phrases-reask")
        [rb] = b.of("spark_json", "phrases-reask")
        assert ra.cache_key().digest() != rb.cache_key().digest()

    def test_reask_with_nothing_new_still_returns_and_never_loops(self):
        fake = FakeBackend(NOUNS[:7], reask=NOUNS[:7])
        result = find(fake)
        assert len(fake.of("spark_json", "phrases-reask")) == 1
        assert len(result.loci) == 7
        assert result.reask_used is True


# Covers: MEM-014
# Requirement: hostile Spark output never raises: phrases are stripped; empty, case-fold
# duplicate, non-string, longer-than-40-char and control-character entries are dropped; at
# most 30 phrases are segmented. A SAM answer over 256 KB counts as no boxes for that phrase
# only; out-of-frame boxes are dropped.
class TestHostileResponses:
    def test_phrase_cleaning(self):
        forty = "y" * 40
        hostile = [
            "  lamp  ", "Lamp", "LAMP", "", "   ", 3, None, {"a": 1}, ["chair"], True,
            "x" * 41, forty, "z" * 5000, "chair\x00", "desk\nlamp", "tab\tle", "esc\x1b",
        ]  # fmt: skip
        fake = FakeBackend(hostile, reask=[])
        find(fake)
        assert sorted(fake.segment_subjects()) == sorted(["lamp", forty])

    def test_two_hundred_phrases_capped_at_thirty(self):
        many = [f"item {i}" for i in range(200)]
        fake = FakeBackend(many, reask=[])
        result = find(fake)
        assert len(fake.of("segment")) == 30
        assert set(fake.segment_subjects()) == set(many[:30])
        assert len(result.phrases) <= 30

    def test_oversized_sam_text_yields_no_boxes_for_that_phrase_only(self):
        huge = token(CELL["lamp"]) + "x" * 300_000
        fake = FakeBackend(NOUNS[:12], sam={"lamp": huge})
        result = find(fake)
        assert "lamp" not in locus_phrases(result)
        assert locus_phrases(result) >= set(NOUNS[1:12])

    def test_large_but_under_cap_sam_text_still_parses(self):
        big = token(CELL["lamp"]) + "x" * 200_000
        result = find(FakeBackend(NOUNS[:12], sam={"lamp": big}))
        assert "lamp" in locus_phrases(result)

    def test_out_of_frame_box_dropped(self):
        bad = f"<|box;x1=900;y1=10;x2={W + 50};y2=200;w={W};h={H}|>"
        result = find(FakeBackend(NOUNS[:12], sam={"lamp": bad}))
        assert "lamp" not in locus_phrases(result)
        assert len(result.loci) == 11


# Covers: MEM-014
# Requirement: one phrase's failed SAM call means no boxes for that phrase and the run
# continues; a failed first Spark call raises BackendCallFailed.
class TestFailures:
    def test_one_failed_sam_call_does_not_abort(self):
        fake = FakeBackend(NOUNS[:12], sam={"lamp": BackendCallFailed("segment call failed: 500 x")})
        result = find(fake)
        assert "lamp" not in locus_phrases(result)
        assert locus_phrases(result) == set(NOUNS[1:12])

    def test_failed_first_spark_call_raises(self):
        fake = FakeBackend(BackendCallFailed("spark_json call failed: 500 x"))
        with pytest.raises(BackendCallFailed):
            find(fake)


class _Recorder:
    """Wraps a backend and records every answer under the request's derived key."""

    mode = "record"

    def __init__(self, inner, root):
        self.inner = inner
        self.cache = ResponseCache(root)

    def call(self, req):
        value = self.inner.call(req)
        body = value.encode("utf-8") if isinstance(value, str) else json.dumps(value).encode("utf-8")
        self.cache.put(req.cache_key(), body)
        return value


# Covers: MEM-014
# Requirement: a run recorded under derived request keys replays offline through
# FixtureBackend to an identical LociResult every time (deterministic, no network).
class TestFixtureReplay:
    def test_replay_is_deterministic_and_matches_recording(self, tmp_path):
        recorded = find(_Recorder(FakeBackend(NOUNS[:7], reask=TestReask.REASK), tmp_path))
        first = find(FixtureBackend(tmp_path))
        second = find(FixtureBackend(tmp_path))
        assert first == second == recorded
        assert first.reask_used is True


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def _clock_setting_sam(clock, t):
    def answer(phrase):
        clock.t = t
        return sam_text(phrase)

    return answer


# Covers: MEM-014
# Requirement: find_loci honours a wall-clock deadline (deadline_s, default 90): phrases still
# pending when it passes count as no boxes and the run returns without waiting for them; the
# re-ask is skipped when fewer than 15 s remain (at exactly 15 s it still runs).
class TestDeadline:
    def test_pending_phrases_at_deadline_yield_no_boxes_and_run_returns(self):
        clock = FakeClock()
        slow_started, slow_finished = threading.Event(), threading.Event()
        release = threading.Event()

        def slow(phrase):
            slow_started.set()
            release.wait(SAFETY_S)
            slow_finished.set()
            return sam_text(phrase)

        def fast(phrase):
            slow_started.wait(SAFETY_S)
            clock.t = 1000.0
            return sam_text(phrase)

        phrases = NOUNS[:6]
        fake = FakeBackend(phrases, sam={p: (slow if p == "lamp" else fast) for p in phrases})
        try:
            result = find(fake, workers=6, deadline_s=90.0, clock=clock)
            returned_before_slow = not slow_finished.is_set()
        finally:
            release.set()
        assert returned_before_slow
        assert "lamp" not in locus_phrases(result)
        assert locus_phrases(result) <= set(phrases[1:])
        assert fake.of("spark_json", "phrases-reask") == []

    def test_reask_skipped_when_under_fifteen_seconds_remain(self):
        clock = FakeClock()
        sam = {p: _clock_setting_sam(clock, 76.0) for p in NOUNS[:7]}
        fake = FakeBackend(NOUNS[:7], reask=TestReask.REASK, sam=sam)
        result = find(fake, deadline_s=90.0, clock=clock)
        assert fake.of("spark_json", "phrases-reask") == []
        assert result.reask_used is False
        assert len(result.loci) == 7

    def test_reask_runs_at_exactly_fifteen_seconds_remaining(self):
        clock = FakeClock()
        sam = {p: _clock_setting_sam(clock, 75.0) for p in NOUNS[:7]}
        fake = FakeBackend(NOUNS[:7], reask=TestReask.REASK, sam=sam)
        result = find(fake, deadline_s=90.0, clock=clock)
        assert len(fake.of("spark_json", "phrases-reask")) == 1
        assert result.reask_used is True


class _ProgressRecorder:
    def __init__(self):
        self.calls = []
        self._lock = threading.Lock()

    def __call__(self, *args, **kwargs):
        with self._lock:
            self.calls.append((args, kwargs))

    def phrases(self):
        return [
            next(a for a in [*args, *kwargs.values()] if isinstance(a, str)) for args, kwargs in self.calls
        ]


# Covers: MEM-014
# Requirement: on_progress fires exactly once per finished phrase (re-ask phrases included)
# and identifies that phrase; leaving it None runs the same pipeline with the same result.
class TestOnProgress:
    def test_one_call_per_phrase(self):
        rec = _ProgressRecorder()
        find(FakeBackend(NOUNS[:12]), on_progress=rec)
        assert sorted(rec.phrases()) == sorted(NOUNS[:12])

    def test_reask_phrases_also_reported(self):
        rec = _ProgressRecorder()
        find(FakeBackend(NOUNS[:7], reask=TestReask.REASK), on_progress=rec)
        assert sorted(p.casefold() for p in rec.phrases()) == sorted(
            NOUNS[:7] + ["mirror", "vase", "bench", "stool", "piano"]
        )

    def test_default_none_gives_same_result(self):
        with_rec = find(FakeBackend(NOUNS[:12]), on_progress=_ProgressRecorder())
        assert find(FakeBackend(NOUNS[:12])) == with_rec


def _envelope(content: dict) -> dict:
    return {"choices": [{"message": {"content": json.dumps(content)}}]}


class _MetaApi:
    """httpx.MockTransport handler standing in for the Meta Model API (no network)."""

    def __init__(self, first, reask):
        self.first, self.reask = first, reask
        self.prompts = []
        self._lock = threading.Lock()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        if request.url.path.endswith("/chat/completions"):
            prompt = payload["messages"][0]["content"][0]["text"]
            with self._lock:
                self.prompts.append(prompt)
                phrases = self.first if len(self.prompts) == 1 else self.reask
            return httpx.Response(200, json=_envelope({"phrases": phrases}))
        if request.url.path.endswith("/responses"):
            phrase = payload["input"][0]["content"][0]["text"]
            return httpx.Response(200, json={"output_text": sam_text(phrase)})
        return httpx.Response(404, json={"error": {"code": "not_found"}})


# Covers: MEM-014
# Requirement: through the live MetaBackend (MockTransport, no network) the first Spark call
# sends PHRASE_PROMPT and the single re-ask sends a prompt listing every kept phrase as
# already found, so the exclude list really reaches the model.
class TestMetaBackendReaskWiring:
    def test_reask_prompt_lists_kept_phrases(self):
        api = _MetaApi(NOUNS[:7], TestReask.REASK)
        client = MetaClient(FAKE_KEY, transport=httpx.MockTransport(api), sleep=lambda s: None)
        result = find(MetaBackend(FAKE_KEY, client=client))
        assert len(api.prompts) == 2
        assert api.prompts[0] == PHRASE_PROMPT
        assert api.prompts[1] != PHRASE_PROMPT
        for phrase in NOUNS[:7]:
            assert f"- {phrase}" in api.prompts[1]
        assert result.reask_used is True
        assert len(result.loci) >= 10
