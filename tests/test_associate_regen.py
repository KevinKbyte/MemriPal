"""Contract (MEM-021): `associate(backend, processed, item, locus) -> Association` regeneration and keying.

- One Spark call per item (method "spark_json", schema ASSOCIATION_SCHEMA, the processed image; item and the
  locus short label ride in `gen_params[PROMPT_ARGS]` under "item" / "locus", so the D3 key includes the
  label).
- A reply failing `validate_association` is regenerated up to 2 times (attempt 0, 1, 2); each re-prompt
  carries the previous failure reason in its prompt args. Still failing after 3 calls -> status "invalid",
  never a 4th.
- `Association` (frozen): item, locus, status ("valid" | "invalid"), attempts (calls made), record (the
  reply when valid), reason (None when valid).
- Retry only on pre-send errors: BackendCallFailed / FixtureMissing propagate after one call (no
  regeneration); MetaClient retries connect errors only.
- Live wiring: MetaBackend knows the association prompt template (item, label and reason reach the prompt
  text), sends ASSOCIATION_SCHEMA under a json_schema-safe name, rejects a hostile reply (unknown field,
  wrong type, non-JSON) as BackendCallFailed without caching it, and a write-through replays identically
  from fixtures.
"""

import dataclasses
import importlib
import json
import re

import httpx
import pytest

from memripal.backend import (
    PROMPT_ARGS,
    BackendCallFailed,
    FixtureBackend,
    FixtureMissing,
    MetaBackend,
    ResponseCache,
)
from memripal.imaging import Processed
from memripal.meta_client import MetaClient

ITEM = "milk carton"
LOCUS = "left book"
IMAGE = b"\xff\xd8\xff\xe0fake-processed-jpeg-bytes\xff\xd9"
PROCESSED = Processed(jpeg=IMAGE, width=1000, height=800, sha="0" * 64)
FAKE_KEY = "fake-test-key-0123456789abcdefXYZ"
SCHEMA_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}")


@pytest.fixture
def assoc():
    # Imported per test, so a missing module fails each test rather than erroring collection.
    return importlib.import_module("memripal.associate")


def good_record(item=ITEM, locus=LOCUS, **over):
    rec = {
        "item": item,
        "locus": locus,
        "kinesthetic": f"You grip a freezing {item} with both hands.",
        "auditory": "It glugs and sloshes like a drum.",
        "visual": "A towering white carton glows.",
        "emotional": "You feel giddy and a little scared.",
        "conceptual": "Calcium builds strong bones.",
        "olfactory": "Sour cream smell fills the air.",
        "gustatory": "Cold and sweet on your tongue.",
        "spatial": f"It balances on top of the {locus}.",
        "scene_prompt_details": "giant carton, dramatic light",
        "walk_cue": "Look up at the shelf.",
        "reencode_hint": "Picture the drum sound.",
        "question": "Why does cold storage keep it fresh longer?",
        "answer": "Low temperature slows bacterial growth.",
    }
    rec.update(over)
    return rec


BAD_BLANK = good_record(olfactory="")  # rule 1
BAD_NO_ITEM = good_record(kinesthetic="You grip something freezing.")  # rule 2
BAD_EXTRA = good_record(onload="<img src=x onerror=alert(1)>")  # hostile: unknown field


def echo_record(req):
    """A valid reply for whatever item/locus the request names in its prompt args."""
    args = req.gen_params[PROMPT_ARGS]
    return good_record(item=args["item"], locus=args["locus"])


class ScriptedBackend:
    """Answers Spark calls from a script (dict, callable(req) or exception); refuses unscripted calls."""

    mode = "fake"

    def __init__(self, *answers):
        self.answers = list(answers)
        self.requests = []

    def call(self, req):
        self.requests.append(req)
        if req.method != "spark_json":
            raise AssertionError(f"unexpected method {req.method!r}")
        if not self.answers:
            raise AssertionError("unscripted extra call")
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer(req) if callable(answer) else json.loads(json.dumps(answer))


class _Recorder:
    """Writes every answer under its derived request key so FixtureBackend can replay it."""

    mode = "fake"

    def __init__(self, inner, root):
        self.inner = inner
        self.cache = ResponseCache(root)

    def call(self, req):
        value = self.inner.call(req)
        self.cache.put(req.cache_key(), json.dumps(value).encode("utf-8"))
        return value


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from _strings(v)


def carries(req, text: str) -> bool:
    """True when some string in the request's prompt args contains `text`."""
    return any(text in s for s in _strings(req.gen_params[PROMPT_ARGS]))


# Covers: MEM-021
# Requirement: a valid first reply is accepted in one Spark call (attempt 0) on the processed image with
# ASSOCIATION_SCHEMA, returning a frozen Association with status "valid" and the record, D16 included.
class TestFirstReplyValid:
    def test_one_call_valid_with_record(self, assoc):
        backend = ScriptedBackend(good_record())
        result = assoc.associate(backend, PROCESSED, ITEM, LOCUS)
        assert isinstance(result, assoc.Association)
        assert (result.item, result.locus, result.status) == (ITEM, LOCUS, "valid")
        assert result.attempts == 1
        assert result.reason is None
        assert result.record == good_record()
        assert result.record["question"] and result.record["answer"]
        assert len(backend.requests) == 1

    def test_request_shape(self, assoc):
        backend = ScriptedBackend(good_record())
        assoc.associate(backend, PROCESSED, ITEM, LOCUS)
        [req] = backend.requests
        assert req.method == "spark_json"
        assert req.attempt == 0
        assert req.image_jpeg == IMAGE
        assert req.schema == assoc.ASSOCIATION_SCHEMA
        args = req.gen_params[PROMPT_ARGS]
        assert (args["item"], args["locus"]) == (ITEM, LOCUS)

    def test_association_is_frozen(self, assoc):
        result = assoc.associate(ScriptedBackend(good_record()), PROCESSED, ITEM, LOCUS)
        with pytest.raises(dataclasses.FrozenInstanceError):
            result.status = "invalid"


# Covers: MEM-021
# Requirement: an invalid reply is regenerated at most twice, each re-prompt carrying the previous failure
# reason; bad,bad,good ends valid after 3 calls, three bad replies end "invalid" after 3 calls with no 4th.
class TestRegeneration:
    def test_bad_bad_good_is_valid_after_three_calls(self, assoc):
        backend = ScriptedBackend(BAD_BLANK, BAD_NO_ITEM, good_record())
        result = assoc.associate(backend, PROCESSED, ITEM, LOCUS)
        assert result.status == "valid"
        assert result.attempts == 3
        assert result.record == good_record()
        assert [r.attempt for r in backend.requests] == [0, 1, 2]

    def test_each_reprompt_carries_the_previous_failure_reason(self, assoc):
        reason1 = assoc.validate_association(BAD_BLANK, ITEM, LOCUS)
        reason2 = assoc.validate_association(BAD_NO_ITEM, ITEM, LOCUS)
        assert reason1 and reason2 and reason1 != reason2
        backend = ScriptedBackend(BAD_BLANK, BAD_NO_ITEM, good_record())
        assoc.associate(backend, PROCESSED, ITEM, LOCUS)
        first, second, third = backend.requests
        assert not carries(first, reason1)
        assert carries(second, reason1)
        assert carries(third, reason2)
        for req in backend.requests:
            args = req.gen_params[PROMPT_ARGS]
            assert (args["item"], args["locus"]) == (ITEM, LOCUS)

    def test_bad_good_is_valid_after_two_calls(self, assoc):
        backend = ScriptedBackend(BAD_NO_ITEM, good_record())
        result = assoc.associate(backend, PROCESSED, ITEM, LOCUS)
        assert (result.status, result.attempts, len(backend.requests)) == ("valid", 2, 2)

    def test_three_bad_is_invalid_with_no_fourth_call(self, assoc):
        backend = ScriptedBackend(BAD_BLANK, BAD_BLANK, BAD_NO_ITEM, good_record())
        result = assoc.associate(backend, PROCESSED, ITEM, LOCUS)
        assert result.status == "invalid"
        assert result.attempts == 3
        assert len(backend.requests) == 3
        assert result.reason == assoc.validate_association(BAD_NO_ITEM, ITEM, LOCUS)

    def test_hostile_replies_end_invalid_without_leaking_the_unknown_field(self, assoc):
        backend = ScriptedBackend(BAD_EXTRA, BAD_EXTRA, BAD_EXTRA)
        result = assoc.associate(backend, PROCESSED, ITEM, LOCUS)
        assert result.status == "invalid"
        assert len(backend.requests) == 3
        assert result.record is None or "onload" not in result.record


# Covers: MEM-021
# Requirement: only pre-send failures are retried (inside MetaClient); a failed or missing model call
# propagates after one call and is never regenerated.
class TestCallFailuresPropagate:
    @pytest.mark.parametrize(
        "exc", [BackendCallFailed("spark_json call failed"), FixtureMissing("no fixture")]
    )
    def test_first_call_failure_propagates_after_one_call(self, assoc, exc):
        backend = ScriptedBackend(exc, good_record(), good_record())
        with pytest.raises(type(exc)):
            assoc.associate(backend, PROCESSED, ITEM, LOCUS)
        assert len(backend.requests) == 1


# Covers: MEM-021
# Requirement: D3 - the locus short label is part of the association cache key, so reordering items across
# loci never replays an association naming the wrong locus.
class TestLocusInCacheKey:
    def test_labels_differ_only_so_keys_differ(self, assoc):
        backend = ScriptedBackend(echo_record, echo_record)
        assoc.associate(backend, PROCESSED, ITEM, "left book")
        assoc.associate(backend, PROCESSED, ITEM, "right book")
        a, b = backend.requests
        assert a.gen_params[PROMPT_ARGS]["locus"] == "left book"
        assert b.gen_params[PROMPT_ARGS]["locus"] == "right book"
        assert a.cache_key().digest() != b.cache_key().digest()

    def test_same_pair_gives_same_key(self, assoc):
        backend = ScriptedBackend(echo_record, echo_record)
        assoc.associate(backend, PROCESSED, ITEM, LOCUS)
        assoc.associate(backend, PROCESSED, ITEM, LOCUS)
        a, b = backend.requests
        assert a.cache_key().digest() == b.cache_key().digest()

    def test_reorder_replay_returns_the_correct_locus(self, assoc, tmp_path):
        recorder = _Recorder(ScriptedBackend(echo_record, echo_record), tmp_path)
        assoc.associate(recorder, PROCESSED, ITEM, "lamp")
        assoc.associate(recorder, PROCESSED, ITEM, "chair")
        replay = FixtureBackend(tmp_path)
        for label in ("chair", "lamp"):
            result = assoc.associate(replay, PROCESSED, ITEM, label)
            assert result.status == "valid"
            assert result.record["locus"] == label
            assert result.attempts == 1


def _envelope(content) -> dict:
    return {"choices": [{"message": {"content": json.dumps(content)}}]}


class _AssocApi:
    """httpx.MockTransport handler standing in for Meta chat completions (no network)."""

    def __init__(self, *script):
        self.script = list(script)
        self.payloads = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.payloads.append(json.loads(request.content))
        if not self.script:
            return httpx.Response(500, json={"error": {"code": "unscripted"}})
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        if isinstance(step, httpx.Response):
            return step
        return httpx.Response(200, json=_envelope(step))

    def prompts(self):
        return [p["messages"][0]["content"][0]["text"] for p in self.payloads]


def _live(api, cache_root=None):
    client = MetaClient(FAKE_KEY, transport=httpx.MockTransport(api), sleep=lambda s: None, rand=lambda: 0.0)
    return MetaBackend(FAKE_KEY, client=client, cache_root=cache_root)


def _cached_files(root):
    return [p for p in root.rglob("*") if p.is_file() and "photos" not in p.parts]


# Covers: MEM-021
# Requirement: through the live MetaBackend (MockTransport, no network) the association prompt names the
# item and locus label, a re-prompt names the failure reason, ASSOCIATION_SCHEMA is sent under a
# json_schema-safe name, and a valid live reply replays identically from the write-through cache.
class TestMetaBackendWiring:
    def test_prompt_names_item_and_locus_and_sends_schema(self, assoc):
        api = _AssocApi(good_record())
        result = assoc.associate(_live(api), PROCESSED, ITEM, LOCUS)
        assert result.status == "valid"
        [payload] = api.payloads
        [prompt] = api.prompts()
        assert ITEM in prompt and LOCUS in prompt
        fmt = payload["response_format"]["json_schema"]
        assert fmt["schema"] == assoc.ASSOCIATION_SCHEMA
        assert SCHEMA_NAME.fullmatch(fmt["name"])

    def test_reprompt_text_carries_the_failure_reason(self, assoc):
        reason = assoc.validate_association(BAD_NO_ITEM, ITEM, LOCUS)
        api = _AssocApi(BAD_NO_ITEM, good_record())
        result = assoc.associate(_live(api), PROCESSED, ITEM, LOCUS)
        assert result.status == "valid"
        first, second = api.prompts()
        assert reason not in first
        assert reason in second

    def test_write_through_replays_identically(self, assoc, tmp_path):
        live = assoc.associate(_live(_AssocApi(good_record()), cache_root=tmp_path), PROCESSED, ITEM, LOCUS)
        replayed = assoc.associate(FixtureBackend(tmp_path), PROCESSED, ITEM, LOCUS)
        assert replayed == live


# Covers: MEM-021
# Requirement: a hostile live reply (unknown field, wrong type, non-object, missing D16 field, non-JSON
# content) fails as BackendCallFailed after one request, nothing cached; a post-send timeout is not
# retried; a connect error (pre-send) is retried.
class TestMetaBackendHostileReplies:
    @pytest.mark.parametrize(
        "reply",
        [
            _envelope(good_record(onload="alert(1)")),
            _envelope(good_record(visual=12345)),
            _envelope([good_record()]),
            _envelope({k: v for k, v in good_record().items() if k != "question"}),
            {"choices": [{"message": {"content": "<html>not json</html>"}}]},
        ],
        ids=["unknown-field", "wrong-type", "non-object", "missing-question", "non-json"],
    )
    def test_hostile_reply_is_rejected_uncached(self, assoc, tmp_path, reply):
        api = _AssocApi(httpx.Response(200, json=reply), good_record())
        with pytest.raises(BackendCallFailed):
            assoc.associate(_live(api, cache_root=tmp_path), PROCESSED, ITEM, LOCUS)
        assert len(api.payloads) == 1
        assert _cached_files(tmp_path) == []

    def test_oversized_schema_valid_reply_ends_invalid(self, assoc):
        huge = good_record(visual="A" * 256 * 1024)
        api = _AssocApi(huge, huge, huge, good_record())
        result = assoc.associate(_live(api), PROCESSED, ITEM, LOCUS)
        assert result.status == "invalid"
        assert len(api.payloads) == 3

    def test_read_timeout_after_send_is_not_retried(self, assoc):
        api = _AssocApi(httpx.ReadTimeout("slow"), good_record())
        with pytest.raises(BackendCallFailed):
            assoc.associate(_live(api), PROCESSED, ITEM, LOCUS)
        assert len(api.payloads) == 1

    def test_connect_error_before_send_is_retried(self, assoc):
        api = _AssocApi(httpx.ConnectError("refused"), good_record())
        result = assoc.associate(_live(api), PROCESSED, ITEM, LOCUS)
        assert result.status == "valid"
        assert len(api.payloads) == 2
