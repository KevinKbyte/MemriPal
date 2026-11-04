# Covers: MEM-014
# Requirement: Spark is a reasoning model whose hidden reasoning tokens count against
# max_completion_tokens; a live Spark call must leave room for the answer after the reasoning,
# else the reply comes back finish_reason "length" with null content and POST /loci, /split and
# /associate all fail. MetaBackend therefore sends each spark_json call with the request's own
# max_completion_tokens plus REASONING_HEADROOM_TOKENS (>= 4096), on the Meta client and on a
# chat-provider client alike. The headroom is a send-time cap only: the request's gen_params, its
# derived cache key and the live-cache entry path stay exactly as before (committed fixtures and
# replays still match), and segment calls are untouched.
import copy
import io
import json

import httpx
import pytest
from PIL import Image

from memripal.associate import associate
from memripal.backend import BackendReplyInvalid, MetaBackend, ModelRequest, ResponseCache
from memripal.chat_provider import ChatProvider
from memripal.imaging import process_upload
from memripal.loci import MIN_LOCI, find_loci
from memripal.meta_client import CallResult, MetaClient
from memripal.probe import PHRASE_SCHEMA
from memripal.split import split_notes

FAKE_KEY = "fake-test-key-reasoning-0123456789XYZ"
# Observed live: the split call spent 2046 reasoning tokens of its 2048 budget.
REASONING_TOKENS = 2046
ANSWER_TOKENS = 200
W, H = 1000, 800
NOUNS = [
    "lamp", "chair", "desk", "sofa", "clock", "plant", "rug", "shelf", "door", "window",
    "mirror", "vase",
]  # fmt: skip
NOTES = (
    "Thank you all for coming tonight. First, our budget doubled this year. "
    "Second, the new library opens in May. Finally, volunteers keep this town running."
)
SPLIT_REPLY = {
    "points": [
        {"label": "budget doubled", "source_quote": "our budget doubled this year"},
        {"label": "library opens", "source_quote": "the new library opens in May"},
        {"label": "volunteers", "source_quote": "volunteers keep this town running"},
    ]
}
ITEM = "milk carton"
LOCUS = "lamp"


def _token(i: int) -> str:
    """120 px square in cell i of a 5x4 grid of 200 px cells on a W x H frame."""
    x1, y1 = 20 + 200 * (i % 5), 20 + 200 * (i // 5)
    return f"<|box;x1={x1};y1={y1};x2={x1 + 120};y2={y1 + 120};w={W};h={H}|>"


def _record(item: str = ITEM, locus: str = LOCUS) -> dict:
    return {
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


ANSWERS = {
    "phrases": {"phrases": NOUNS},
    "phrases-reask": {"phrases": []},
    "split": SPLIT_REPLY,
    "association": _record(),
}


def _chat_reply(finish_reason: str, content: str | None, completion: int, reasoning: int) -> dict:
    return {
        "choices": [{"finish_reason": finish_reason, "message": {"role": "assistant", "content": content}}],
        "usage": {
            "completion_tokens": completion,
            "completion_tokens_details": {"reasoning_tokens": reasoning},
        },
    }


class ReasoningModel:
    """Fake Meta API whose Spark burns REASONING_TOKENS of max_completion_tokens before answering."""

    def __init__(self):
        self.budgets: list[int] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        if request.url.path.endswith("/chat/completions"):
            budget = payload["max_completion_tokens"]
            self.budgets.append(budget)
            if budget < REASONING_TOKENS + ANSWER_TOKENS:
                # The live failure: every token spent reasoning, so no answer at all.
                return httpx.Response(200, json=_chat_reply("length", None, budget, budget - 2))
            answer = ANSWERS[payload["response_format"]["json_schema"]["name"]]
            used = REASONING_TOKENS + ANSWER_TOKENS
            return httpx.Response(200, json=_chat_reply("stop", json.dumps(answer), used, REASONING_TOKENS))
        if request.url.path.endswith("/responses"):
            phrase = payload["input"][0]["content"][0]["text"]
            text = _token(NOUNS.index(phrase)) if phrase in NOUNS else ""
            return httpx.Response(200, json={"output_text": text})
        return httpx.Response(404, json={"error": {"code": "not_found"}})


def _reasoning_backend() -> tuple[MetaBackend, ReasoningModel]:
    model = ReasoningModel()
    client = MetaClient(FAKE_KEY, transport=httpx.MockTransport(model), max_retries=0)
    return MetaBackend(FAKE_KEY, client=client), model


def _processed():
    buf = io.BytesIO()
    Image.new("RGB", (W, H), (120, 80, 40)).save(buf, "JPEG")
    return process_upload(buf.getvalue())


# Covers: MEM-014
# Requirement: against a reasoning model that spends 2046 tokens thinking before it answers,
# the live loci, split and associate pipelines still get their answers (no BackendReplyInvalid
# from a finish_reason "length" reply with null content).
class TestReasoningModelStillAnswers:
    def test_find_loci_returns_loci(self):
        backend, model = _reasoning_backend()

        result = find_loci(backend, _processed())

        assert len(result.loci) >= MIN_LOCI
        assert model.budgets and min(model.budgets) >= REASONING_TOKENS + ANSWER_TOKENS

    def test_split_notes_returns_points(self):
        backend, _ = _reasoning_backend()

        points = split_notes(backend, _processed().jpeg, NOTES, 12)

        assert [p["label"] for p in points] == ["budget doubled", "library opens", "volunteers"]

    def test_associate_returns_valid_record(self):
        backend, _ = _reasoning_backend()

        result = associate(backend, _processed(), ITEM, LOCUS)

        assert result.status == "valid"
        assert result.record == _record()

    def test_reply_truncated_even_with_headroom_is_reply_invalid(self):
        # A model that out-thinks any cap: the failure stays a clean, key-free BackendReplyInvalid.
        def always_truncate(request: httpx.Request) -> httpx.Response:
            budget = json.loads(request.content)["max_completion_tokens"]
            return httpx.Response(200, json=_chat_reply("length", None, budget, budget - 2))

        client = MetaClient(FAKE_KEY, transport=httpx.MockTransport(always_truncate), max_retries=0)
        with pytest.raises(BackendReplyInvalid) as info:
            MetaBackend(FAKE_KEY, client=client).call(_spark_request())
        assert FAKE_KEY not in str(info.value)


def _headroom() -> int:
    from memripal.backend import REASONING_HEADROOM_TOKENS

    return REASONING_HEADROOM_TOKENS


IMAGE = b"\xff\xd8\xff\xe0fake-processed-jpeg-bytes\xff\xd9"


def _ok(body: bytes) -> CallResult:
    return CallResult(ok=True, status=200, body=body, error=None, attempts=1, latency_s=0.01)


class _RecordingClient:
    def __init__(self):
        self.chat_calls: list[dict] = []
        self.segment_calls: list[dict] = []

    def chat_json(self, **kwargs):
        self.chat_calls.append(kwargs)
        envelope = {"choices": [{"message": {"content": json.dumps({"phrases": ["lamp"]})}}]}
        return _ok(json.dumps(envelope).encode("utf-8"))

    def segment(self, **kwargs):
        self.segment_calls.append(kwargs)
        return _ok(json.dumps({"output_text": _token(0)}).encode("utf-8"))


def _spark_request(**overrides) -> ModelRequest:
    fields = {
        "method": "spark_json",
        "image_jpeg": IMAGE,
        "subject": "phrases",
        "attempt": 0,
        "model": "muse-spark-1.3",
        "prompt_template_id": "phrase",
        "gen_params": {"max_completion_tokens": 1024},
        "schema": PHRASE_SCHEMA,
    }
    fields.update(overrides)
    return ModelRequest(**fields)


# Covers: MEM-014
# Requirement: the sent cap is the request's max_completion_tokens + REASONING_HEADROOM_TOKENS
# (>= 4096) for every spark_json call, Meta or chat provider; the request, its cache key and its
# live-cache entry path are unchanged; segment calls carry no token cap.
class TestReasoningHeadroomSendTimeCap:
    def test_headroom_is_at_least_4096(self):
        assert _headroom() >= 4096

    def test_spark_call_sends_request_budget_plus_headroom(self):
        for budget in (1024, 2048):
            client = _RecordingClient()
            req = _spark_request(gen_params={"max_completion_tokens": budget})

            MetaBackend(FAKE_KEY, client=client).call(req)

            [kwargs] = client.chat_calls
            assert kwargs["max_completion_tokens"] == budget + _headroom()

    def test_cache_entry_lands_under_original_request_key(self, tmp_path):
        client = _RecordingClient()
        req = _spark_request(gen_params={"max_completion_tokens": 1024})
        gen_before = copy.deepcopy(req.gen_params)
        key_before = req.cache_key()

        MetaBackend(FAKE_KEY, cache_root=tmp_path, client=client).call(req)

        [kwargs] = client.chat_calls
        assert kwargs["max_completion_tokens"] == 1024 + _headroom()
        assert req.gen_params == gen_before
        assert req.cache_key() == key_before
        entry = ResponseCache(tmp_path).path_for(key_before)
        assert entry.is_file()
        assert sorted(p.name for p in (tmp_path / "spark_json").glob("*.json")) == [entry.name]

    def test_chat_provider_gets_same_headroom(self, tmp_path):
        meta_client, local_client = _RecordingClient(), _RecordingClient()
        chat = ChatProvider("local", local_client, "some-model")
        req = _spark_request(gen_params={"max_completion_tokens": 1024})
        gen_before = copy.deepcopy(req.gen_params)

        MetaBackend(FAKE_KEY, cache_root=tmp_path, client=meta_client, chat=chat).call(req)

        assert meta_client.chat_calls == []
        [kwargs] = local_client.chat_calls
        assert kwargs["model"] == "some-model"
        assert kwargs["max_completion_tokens"] == 1024 + _headroom()
        assert req.gen_params == gen_before

    def test_segment_call_carries_no_token_cap(self):
        client = _RecordingClient()
        req = _spark_request(
            method="segment",
            subject="lamp",
            model="sam-3.1",
            prompt_template_id="sam-phrase",
            gen_params={},
            schema=None,
        )

        MetaBackend(FAKE_KEY, client=client).call(req)

        [kwargs] = client.segment_calls
        assert "max_completion_tokens" not in kwargs
