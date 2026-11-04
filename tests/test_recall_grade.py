"""Contract (MEM-136, ADR 0080; RED, GREEN implements src/memripal/recall_grade.py):

- `RecallGrader(providers=[...])`: each provider has `.name`, `.model`, `.client`; `client.chat_json(model=,
  prompt=, schema=, schema_name=, max_completion_tokens=) -> meta_client.CallResult` (body = OpenAI chat
  completion bytes, content = the JSON string).
- `grade(transcript, keywords, byok_client=None) -> {"provider", "latency_ms", "items": [{"index", "verdict",
  "reason"}]} | None`. byok_client (the visitor's own Meta key client, MEM-122) is tried first with
  loci.SPARK_MODEL; its failure falls through to the configured providers.
  schema_name "recall_grade"; max_completion_tokens == 256 + backend.REASONING_HEADROOM_TOKENS; the prompt
  quotes the transcript and numbers each keyword with its 0-based item index ("0. lamp", "[0] lamp", ...).
- None on: exception, ok False, malformed JSON, index out of range, unknown verdict; empty/blank transcript
  or empty keywords -> None with no call. First provider that succeeds wins. reason truncated to 120 chars.
- Logs never carry a provider body.
"""

import json
import logging
import re

import pytest

from memripal import backend
from memripal.loci import SPARK_MODEL
from memripal.meta_client import CallResult

LABELS = ["lamp", "door", "clock"]
TRANSCRIPT = "the bang-bang sky lights over the old red door"
SENTINEL = "SENTINEL-GRADE-BODY-do-not-leak-7f3e"


def _body(content: str) -> bytes:
    return json.dumps({"choices": [{"message": {"role": "assistant", "content": content}}]}).encode()


def _result(content: str | None = None, *, ok: bool = True, raw: bytes | None = None) -> CallResult:
    body = raw if raw is not None else _body(content or "")
    return CallResult(
        ok=ok, status=200 if ok else 500, body=body, error=None if ok else "500 x", attempts=1, latency_s=0.01
    )


def _items_json(items) -> str:
    return json.dumps({"items": items})


GOOD = [
    {"index": 0, "verdict": "miss", "reason": "not mentioned"},
    {"index": 1, "verdict": "correct", "reason": "red door named"},
    {"index": 2, "verdict": "partial", "reason": "time hinted"},
]


class FakeClient:
    def __init__(self, reply):
        self.reply = reply
        self.calls: list[dict] = []

    def chat_json(self, **kwargs):
        self.calls.append(kwargs)
        if isinstance(self.reply, BaseException):
            raise self.reply
        return self.reply


class FakeProvider:
    def __init__(self, name: str, reply, model: str | None = None):
        self.name = name
        self.model = model or f"{name}/muse-spark"
        self.client = FakeClient(reply)


def _grader(*providers):
    from memripal.recall_grade import RecallGrader

    return RecallGrader(providers=list(providers))


# Covers: MEM-136
class TestRecallGraderHappyPath:
    # Requirement: Muse Spark grades a spoken recall per expected label, so a paraphrase can count.
    def test_valid_reply_returns_provider_latency_and_items(self):
        p = FakeProvider("fireworks", _result(_items_json(GOOD)))
        out = _grader(p).grade(TRANSCRIPT, LABELS)
        assert out is not None
        assert set(out) == {"provider", "latency_ms", "items"}
        assert out["provider"] == "fireworks"
        assert isinstance(out["latency_ms"], int) and not isinstance(out["latency_ms"], bool)
        assert out["latency_ms"] >= 0
        assert out["items"] == GOOD

    def test_call_uses_recall_grade_schema_model_and_token_budget(self):
        p = FakeProvider("baseten", _result(_items_json(GOOD)), model="meta-models/x")
        _grader(p).grade(TRANSCRIPT, LABELS)
        assert len(p.client.calls) == 1
        call = p.client.calls[0]
        assert call["schema_name"] == "recall_grade"
        assert call["model"] == "meta-models/x"
        assert call["max_completion_tokens"] == 256 + backend.REASONING_HEADROOM_TOKENS
        verdict = call["schema"]["properties"]["items"]["items"]["properties"]["verdict"]
        assert sorted(verdict["enum"]) == ["correct", "miss", "partial"]

    def test_prompt_quotes_transcript_and_numbers_each_label(self):
        p = FakeProvider("fireworks", _result(_items_json(GOOD)))
        _grader(p).grade(TRANSCRIPT, LABELS)
        prompt = p.client.calls[0]["prompt"]
        assert TRANSCRIPT in prompt
        for i, label in enumerate(LABELS):
            assert re.search(rf"\b{i}\b[^\w\n]{{0,4}}{re.escape(label)}", prompt), (i, label)

    def test_reason_truncated_to_120_chars(self):
        items = [{"index": 0, "verdict": "correct", "reason": "x" * 500}]
        out = _grader(FakeProvider("fireworks", _result(_items_json(items)))).grade(TRANSCRIPT, LABELS)
        assert out is not None
        assert out["items"][0]["reason"] == "x" * 120

    def test_first_provider_failure_falls_to_second(self):
        first = FakeProvider("fireworks", RuntimeError("boom"))
        second = FakeProvider("baseten", _result(_items_json(GOOD)))
        out = _grader(first, second).grade(TRANSCRIPT, LABELS)
        assert out is not None
        assert out["provider"] == "baseten"
        assert out["items"] == GOOD

    def test_first_success_wins_second_not_called(self):
        first = FakeProvider("fireworks", _result(_items_json(GOOD)))
        second = FakeProvider("baseten", _result(_items_json(GOOD)))
        out = _grader(first, second).grade(TRANSCRIPT, LABELS)
        assert out["provider"] == "fireworks"
        assert second.client.calls == []


# Covers: MEM-136
class TestRecallGraderFailuresReturnNone:
    # Requirement: any grader failure yields None so the keyword match stays the whole score.
    @pytest.mark.parametrize(
        "reply",
        [
            RuntimeError("network down"),
            TimeoutError("slow"),
            _result(_items_json(GOOD), ok=False),
            _result("not json {"),
            _result(raw=b"<html>502</html>"),
            _result(json.dumps({"nope": []})),
            _result(_items_json([{"index": 3, "verdict": "correct", "reason": "r"}])),
            _result(_items_json([{"index": -1, "verdict": "correct", "reason": "r"}])),
            _result(_items_json([{"index": 0, "verdict": "maybe", "reason": "r"}])),
        ],
        ids=[
            "exception",
            "timeout",
            "not-ok",
            "bad-json",
            "html-body",
            "no-items",
            "index-high",
            "index-negative",
            "unknown-verdict",
        ],
    )
    def test_bad_reply_returns_none(self, reply):
        assert _grader(FakeProvider("fireworks", reply)).grade(TRANSCRIPT, LABELS) is None

    def test_all_providers_fail_returns_none(self):
        out = _grader(FakeProvider("a", RuntimeError("x")), FakeProvider("b", _result("{"))).grade(
            TRANSCRIPT, LABELS
        )
        assert out is None

    @pytest.mark.parametrize("transcript,keywords", [("", LABELS), ("   ", LABELS), (TRANSCRIPT, [])])
    def test_empty_input_returns_none_without_a_call(self, transcript, keywords):
        p = FakeProvider("fireworks", _result(_items_json(GOOD)))
        assert _grader(p).grade(transcript, keywords) is None
        assert p.client.calls == []

    def test_no_providers_returns_none(self):
        assert _grader().grade(TRANSCRIPT, LABELS) is None

    def test_failure_log_never_carries_provider_body(self, caplog):
        caplog.set_level(logging.DEBUG)
        p = FakeProvider("fireworks", _result(f"not json {SENTINEL}"))
        assert _grader(p).grade(TRANSCRIPT, LABELS) is None
        for record in caplog.records:
            assert SENTINEL not in record.getMessage() + repr(record.args)


# Covers: MEM-136
class TestRecallGraderByok:
    # Requirement: a visitor's own Meta key grades first, so Spark still works when shared providers are out.
    def test_byok_client_is_tried_first_with_spark_model(self):
        byok = FakeClient(_result(_items_json(GOOD)))
        configured = FakeProvider("fireworks", _result(_items_json(GOOD)))
        out = _grader(configured).grade(TRANSCRIPT, LABELS, byok_client=byok)
        assert out is not None and out["items"] == GOOD
        assert len(byok.calls) == 1
        assert byok.calls[0]["model"] == SPARK_MODEL
        assert byok.calls[0]["schema_name"] == "recall_grade"
        assert configured.client.calls == []

    @pytest.mark.parametrize("reply", [RuntimeError("no key"), _result("{")], ids=["raises", "bad-json"])
    def test_byok_failure_falls_through_to_configured(self, reply):
        byok = FakeClient(reply)
        configured = FakeProvider("fireworks", _result(_items_json(GOOD)))
        out = _grader(configured).grade(TRANSCRIPT, LABELS, byok_client=byok)
        assert out is not None
        assert out["provider"] == "fireworks"
        assert len(byok.calls) == 1

    def test_byok_none_uses_configured_only(self):
        configured = FakeProvider("fireworks", _result(_items_json(GOOD)))
        out = _grader(configured).grade(TRANSCRIPT, LABELS, byok_client=None)
        assert out["provider"] == "fireworks"
