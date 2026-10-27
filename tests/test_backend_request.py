import dataclasses
import hashlib
import json
import os
from unittest import mock

import pytest

from memripal import backend as backend_module
from memripal.backend import (
    BackendCallFailed,
    CacheKey,
    FixtureBackend,
    FixtureMissing,
    MetaBackend,
    ModelRequest,
    ResponseCache,
)
from memripal.meta_client import CallResult

FAKE_KEY = "fake-test-key-0123456789abcdefXYZ"
IMAGE = b"\xff\xd8\xff\xe0fake-processed-jpeg-bytes\xff\xd9"
PHRASES_SCHEMA = {
    "type": "object",
    "properties": {"phrases": {"type": "array", "items": {"type": "string"}}},
    "required": ["phrases"],
    "additionalProperties": False,
}
GEN_PARAMS = {"max_completion_tokens": 1024, "temperature": 0.0}


def _request(**overrides):
    fields = {
        "method": "spark_json",
        "image_jpeg": IMAGE,
        "subject": "phrases",
        "attempt": 0,
        "model": "muse-spark-1.3",
        "prompt_template_id": "phrase",
        "gen_params": dict(GEN_PARAMS),
        "schema": PHRASES_SCHEMA,
    }
    fields.update(overrides)
    return ModelRequest(**fields)


def _segment_request(**overrides):
    fields = {
        "method": "segment",
        "subject": "book",
        "model": "sam-3.1",
        "prompt_template_id": "sam-phrase",
        "gen_params": {},
        "schema": None,
    }
    fields.update(overrides)
    return _request(**fields)


def _files_under(root):
    return sorted(p for p in root.rglob("*") if p.is_file())


# Covers: MEM-003, MEM-014
# Requirement: a model request is an immutable value carrying everything a live call needs
# (method, processed image bytes, subject, attempt, model, prompt template id, generation
# params, schema); requests without image bytes or with missing (None) fields are rejected,
# and a caller can never supply its own photo sha.
class TestModelRequest:
    def test_is_frozen(self):
        req = _request()
        with pytest.raises(AttributeError):
            req.subject = "other"

    def test_image_bytes_cannot_be_swapped_after_construction(self):
        req = _request()
        with pytest.raises(AttributeError):
            req.image_jpeg = b"\xff\xd8\xffother"

    def test_caller_cannot_supply_photo_sha(self):
        with pytest.raises(TypeError):
            _request(photo_sha="a" * 64)

    def test_empty_image_bytes_rejected(self):
        with pytest.raises(ValueError):
            _request(image_jpeg=b"")

    @pytest.mark.parametrize("field", ["method", "image_jpeg", "subject", "model", "prompt_template_id"])
    def test_none_field_rejected(self, field):
        with pytest.raises((TypeError, ValueError)):
            _request(**{field: None})

    def test_has_exactly_plan_fields_and_no_photo_sha_field(self):
        names = {f.name for f in dataclasses.fields(ModelRequest)}
        assert names == {
            "method",
            "image_jpeg",
            "subject",
            "attempt",
            "model",
            "prompt_template_id",
            "gen_params",
            "schema",
        }

    def test_schema_may_be_none_for_schemaless_methods(self):
        req = _segment_request()
        assert req.schema is None


# Covers: MEM-003, MEM-014
# Requirement: the cache key is DERIVED from the request, never caller-supplied: photo_sha is
# sha256(image_jpeg), and the key also folds in method, subject, attempt, model id, a
# canonical gen-params digest, prompt template id, schema and the current PROMPT_VERSION.
# Identical requests give identical keys; changing any single field gives a different key.
class TestDerivedCacheKey:
    def test_photo_sha_is_sha256_of_image_bytes(self):
        key = _request().cache_key()
        assert key.photo_sha == hashlib.sha256(IMAGE).hexdigest()

    def test_key_method_matches_request_method(self):
        assert _segment_request().cache_key().method == "segment"
        assert _request().cache_key().method == "spark_json"

    def test_identical_requests_give_identical_key(self):
        assert _request().cache_key().digest() == _request().cache_key().digest()

    def test_gen_params_digest_is_canonical_over_key_order(self):
        forward = _request(gen_params={"a": 1, "b": 2})
        backward = _request(gen_params={"b": 2, "a": 1})
        assert forward.cache_key().digest() == backward.cache_key().digest()

    @pytest.mark.parametrize(
        "field,new_value",
        [
            ("method", "segment"),
            ("image_jpeg", IMAGE + b"\x00"),
            ("subject", "phrases-reask"),
            ("attempt", 1),
            ("model", "muse-spark-2.0"),
            ("prompt_template_id", "phrase-reask"),
            ("gen_params", {"max_completion_tokens": 2048, "temperature": 0.0}),
            ("schema", {**PHRASES_SCHEMA, "required": []}),
        ],
    )
    def test_changing_any_single_field_changes_key(self, field, new_value):
        base = _request()
        changed = _request(**{field: new_value})
        assert changed.cache_key().digest() != base.cache_key().digest()

    def test_changing_prompt_version_changes_key(self, monkeypatch):
        before = _request().cache_key().digest()
        monkeypatch.setattr(backend_module, "PROMPT_VERSION", "some-other-prompt-version")
        after = _request().cache_key().digest()
        assert after != before

    def test_key_carries_no_auth_material(self):
        key = _request().cache_key()
        dumped = repr(key) + key.digest()
        assert FAKE_KEY not in dumped


# Covers: MEM-003, MEM-014
# Requirement: photo_sha is always 64 lowercase hex chars; any other value (uppercase, wrong
# length, non-hex, trailing newline, empty, None) is rejected both by CacheKey and by the
# legacy positional segment()/spark_json() shims (MEM-003 compat), never silently used.
class TestPhotoShaValidation:
    BAD = [
        "A" * 64,
        "a" * 63,
        "a" * 65,
        "g" * 64,
        "a" * 64 + "\n",
        " " + "a" * 63,
        "",
    ]

    @pytest.mark.parametrize("bad", BAD)
    def test_cache_key_rejects_bad_photo_sha(self, bad):
        with pytest.raises(ValueError):
            CacheKey(method="segment", photo_sha=bad, subject="book")

    def test_cache_key_rejects_none_photo_sha(self):
        with pytest.raises((TypeError, ValueError)):
            CacheKey(method="segment", photo_sha=None, subject="book")

    def test_cache_key_accepts_lowercase_hex(self):
        sha = hashlib.sha256(b"x").hexdigest()
        assert CacheKey(method="segment", photo_sha=sha, subject="book").photo_sha == sha

    @pytest.mark.parametrize("bad", BAD)
    def test_segment_shim_rejects_bad_photo_sha(self, tmp_path, bad):
        with pytest.raises(ValueError):
            FixtureBackend(tmp_path).segment(bad, "book")

    @pytest.mark.parametrize("bad", BAD)
    def test_spark_json_shim_rejects_bad_photo_sha(self, tmp_path, bad):
        with pytest.raises(ValueError):
            FixtureBackend(tmp_path).spark_json(bad, "phrases")


# Covers: MEM-003, MEM-014
# Requirement: in fixture mode a ModelRequest replays the recording stored under its derived
# key (segment -> str, spark_json -> dict); a request differing in any key field (e.g. model)
# misses with FixtureMissing rather than replaying another request's response.
class TestFixtureBackendCall:
    def test_spark_json_replays_by_derived_key(self, tmp_path):
        req = _request()
        ResponseCache(tmp_path).put(req.cache_key(), json.dumps({"phrases": ["book"]}).encode("utf-8"))
        assert FixtureBackend(tmp_path).call(req) == {"phrases": ["book"]}

    def test_segment_replays_by_derived_key(self, tmp_path):
        req = _segment_request()
        ResponseCache(tmp_path).put(req.cache_key(), b"<box>1 2 3 4</box>")
        assert FixtureBackend(tmp_path).call(req) == "<box>1 2 3 4</box>"

    def test_other_model_misses(self, tmp_path):
        ResponseCache(tmp_path).put(_request().cache_key(), b'{"phrases": []}')
        with pytest.raises(FixtureMissing):
            FixtureBackend(tmp_path).call(_request(model="muse-spark-2.0"))

    def test_other_image_misses(self, tmp_path):
        ResponseCache(tmp_path).put(_request().cache_key(), b'{"phrases": []}')
        with pytest.raises(FixtureMissing):
            FixtureBackend(tmp_path).call(_request(image_jpeg=IMAGE + b"\x00"))


class _FakeClient:
    def __init__(self, result):
        self.result = result

    def chat_json(self, **kwargs):
        return self.result

    def segment(self, **kwargs):
        return self.result


def _ok(body):
    return CallResult(ok=True, status=200, body=body, error=None, attempts=1, latency_s=0.01)


def _chat_envelope(content):
    text = content if isinstance(content, str) else json.dumps(content)
    return json.dumps({"choices": [{"message": {"content": text}}]}).encode("utf-8")


def _meta(tmp_path, result):
    return MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(result))


# Covers: MEM-003, MEM-014
# Requirement: in meta mode a live response is written through to the cache only when the
# call succeeded and the response is complete and schema-valid, and the write is atomic
# (temp file + os.replace): a failed or invalid response leaves no file, a failed write
# leaves no partial or temp file and never clobbers an existing good entry, and a failed
# call raises BackendCallFailed whose message never contains the API key or response body.
class TestMetaBackendWriteThrough:
    def test_valid_spark_response_written_and_replayable(self, tmp_path):
        req = _request()
        got = _meta(tmp_path, _ok(_chat_envelope({"phrases": ["book", "mug"]}))).call(req)
        assert got == {"phrases": ["book", "mug"]}
        assert FixtureBackend(tmp_path).call(req) == {"phrases": ["book", "mug"]}

    def test_valid_segment_response_written_and_replayable(self, tmp_path):
        req = _segment_request()
        body = json.dumps({"output_text": "<box>1 2 3 4</box>"}).encode("utf-8")
        assert _meta(tmp_path, _ok(body)).call(req) == "<box>1 2 3 4</box>"
        assert FixtureBackend(tmp_path).call(req) == "<box>1 2 3 4</box>"

    @pytest.mark.parametrize(
        "content",
        [
            {"phrases": "book"},
            {"phrases": ["book", 3]},
            {"other": ["book"]},
            {"phrases": ["book"], "extra": 1},
            "not json {",
        ],
    )
    def test_schema_invalid_response_raises_and_writes_nothing(self, tmp_path, content):
        with pytest.raises(BackendCallFailed):
            _meta(tmp_path, _ok(_chat_envelope(content))).call(_request())
        assert _files_under(tmp_path) == []

    def test_truncated_envelope_raises_and_writes_nothing(self, tmp_path):
        with pytest.raises(BackendCallFailed):
            _meta(tmp_path, _ok(b'{"choices": [{"message": {"cont')).call(_request())
        assert _files_under(tmp_path) == []

    def test_failed_call_raises_without_key_or_body_and_writes_nothing(self, tmp_path):
        leaked = b'{"error": {"code": "rate_limited", "message": "echo SECRET-BODY-TEXT"}}'
        failed = CallResult(
            ok=False, status=429, body=leaked, error="429 rate_limited", attempts=3, latency_s=0.5
        )
        with pytest.raises(BackendCallFailed) as excinfo:
            _meta(tmp_path, failed).call(_request())
        message = str(excinfo.value)
        assert FAKE_KEY not in message
        assert "SECRET-BODY-TEXT" not in message
        assert _files_under(tmp_path) == []

    def test_write_uses_os_replace_onto_final_path(self, tmp_path):
        req = _request()
        target = ResponseCache(tmp_path).path_for(req.cache_key())
        with mock.patch("os.replace", wraps=os.replace) as replace:
            _meta(tmp_path, _ok(_chat_envelope({"phrases": ["book"]}))).call(req)
        dsts = [os.fspath(c.args[1]) for c in replace.call_args_list]
        assert os.fspath(target) in dsts
        assert _files_under(tmp_path) == [target]

    def test_failed_replace_leaves_no_partial_or_temp_file(self, tmp_path):
        with (
            mock.patch("os.replace", side_effect=OSError("disk full")),
            pytest.raises((OSError, BackendCallFailed)),
        ):
            _meta(tmp_path, _ok(_chat_envelope({"phrases": ["book"]}))).call(_request())
        assert _files_under(tmp_path) == []

    def test_failed_replace_keeps_existing_entry_intact(self, tmp_path):
        req = _request()
        target = ResponseCache(tmp_path).put(req.cache_key(), b'{"phrases": ["old"]}')
        with (
            mock.patch("os.replace", side_effect=OSError("disk full")),
            pytest.raises((OSError, BackendCallFailed)),
        ):
            _meta(tmp_path, _ok(_chat_envelope({"phrases": ["new"]}))).call(req)
        assert target.read_bytes() == b'{"phrases": ["old"]}'
        assert _files_under(tmp_path) == [target]


# Covers: MEM-003, MEM-014
# Requirement: the response cache's own put() is atomic: a failed rename leaves neither the
# final file nor a stray temp file behind.
class TestResponseCacheAtomicPut:
    def test_failed_replace_leaves_nothing(self, tmp_path):
        key = CacheKey(method="segment", photo_sha="a" * 64, subject="book")
        with mock.patch("os.replace", side_effect=OSError("disk full")), pytest.raises(OSError):
            ResponseCache(tmp_path).put(key, b"payload")
        assert _files_under(tmp_path) == []


class _RecordingClient:
    def __init__(self, result):
        self.result = result
        self.chat_calls = []

    def chat_json(self, **kwargs):
        self.chat_calls.append(kwargs)
        return self.result


def _reask_request(exclude, **gen):
    return _request(
        subject="phrases-reask",
        prompt_template_id="phrase-reask",
        gen_params={**GEN_PARAMS, **gen, "prompt_args": {"exclude": list(exclude)}},
    )


# Covers: MEM-014
# Requirement: ModelRequest's field set stays pinned, so the re-ask exclude list rides in
# gen_params["prompt_args"] (ADR 0014): it is folded into gen_params_digest (same list -> same
# key, different list -> different key), and MetaBackend.call strips it before chat_json so the
# transport never receives prompt_args while the other gen params still pass through and the
# excluded phrases reach the prompt.
class TestPromptArgsContract:
    def test_same_exclude_list_gives_same_key(self):
        a = _reask_request(["book", "mug"]).cache_key()
        b = _reask_request(["book", "mug"]).cache_key()
        assert a.gen_params_digest == b.gen_params_digest
        assert a.digest() == b.digest()

    @pytest.mark.parametrize("other", [["book"], ["book", "lamp"], [], ["mug", "book"]])
    def test_different_exclude_list_gives_different_key(self, other):
        base = _reask_request(["book", "mug"]).cache_key()
        changed = _reask_request(other).cache_key()
        assert changed.gen_params_digest != base.gen_params_digest
        assert changed.digest() != base.digest()

    def test_meta_call_strips_prompt_args_before_chat_json(self, tmp_path):
        client = _RecordingClient(_ok(_chat_envelope({"phrases": ["lamp"]})))
        req = _reask_request(["book", "mug"])

        got = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=client).call(req)

        assert got == {"phrases": ["lamp"]}
        [kwargs] = client.chat_calls
        assert "prompt_args" not in kwargs
        assert kwargs["max_completion_tokens"] == GEN_PARAMS["max_completion_tokens"]
        assert kwargs["temperature"] == GEN_PARAMS["temperature"]
        assert "book" in kwargs["prompt"] and "mug" in kwargs["prompt"]

    def test_meta_call_leaves_request_gen_params_untouched(self, tmp_path):
        client = _RecordingClient(_ok(_chat_envelope({"phrases": ["lamp"]})))
        req = _reask_request(["book"])
        key_before = req.cache_key().digest()

        MetaBackend(FAKE_KEY, cache_root=tmp_path, client=client).call(req)

        assert req.gen_params["prompt_args"] == {"exclude": ["book"]}
        assert req.cache_key().digest() == key_before
