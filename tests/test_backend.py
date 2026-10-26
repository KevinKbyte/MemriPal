import dataclasses
import hashlib
import json

import pytest

from memripal.backend import (
    CacheKey,
    FixtureBackend,
    FixtureMissing,
    ResponseCache,
)

PHOTO_SHA = "a" * 64

EXPECTED_EXT = {"segment": ".txt", "spark_json": ".json", "image_edit": ".webp"}


def _expected_digest(key):
    payload = json.dumps(dataclasses.asdict(key), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# Covers: MEM-003
# Requirement: a cached model response is addressed by a logical key (method, photo,
# subject, attempt, prompt version) whose digest is deterministic, changes when any field
# changes, and never includes auth material or raw request bytes.
class TestCacheKeyDigest:
    def test_equal_fields_give_equal_digest(self):
        a = CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book")
        b = CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book")
        assert a.digest() == b.digest()

    def test_digest_is_sha256_of_sorted_compact_json(self):
        key = CacheKey(method="spark_json", photo_sha=PHOTO_SHA, subject="phrases", attempt=2)
        assert key.digest() == _expected_digest(key)

    def test_digest_is_64_hex_chars(self):
        digest = CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="mug").digest()
        assert len(digest) == 64
        assert all(c in "0123456789abcdef" for c in digest)

    def test_defaults_attempt_zero_and_string_prompt_version(self):
        key = CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book")
        assert key.attempt == 0
        assert isinstance(key.prompt_version, str)
        assert key.prompt_version

    @pytest.mark.parametrize(
        "field,new_value",
        [
            ("method", "image_edit"),
            ("photo_sha", "b" * 64),
            ("subject", "lamp"),
            ("attempt", 1),
            ("prompt_version", "some-other-prompt-version"),
        ],
    )
    def test_changing_any_field_changes_digest(self, field, new_value):
        base = CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book")
        changed = dataclasses.replace(base, **{field: new_value})
        assert changed.digest() != base.digest()

    def test_is_frozen(self):
        key = CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book")
        with pytest.raises(dataclasses.FrozenInstanceError):
            key.subject = "mug"

    def test_has_exactly_logical_fields_and_no_auth_field(self):
        names = {f.name for f in dataclasses.fields(CacheKey)}
        assert names == {"method", "photo_sha", "subject", "attempt", "prompt_version"}
        for forbidden in ("auth", "key", "token", "api_key", "authorization", "request", "body"):
            assert not any(forbidden in n.lower() for n in names - {"photo_sha"}), forbidden


# Covers: MEM-003
# Requirement: the write-through response cache stores each body at
# root/<method>/<digest><ext> (segment .txt, spark_json .json, image_edit .webp), returns
# it byte-for-byte on get, returns None on a miss, and rejects unknown methods.
class TestResponseCache:
    @pytest.mark.parametrize("method", sorted(EXPECTED_EXT))
    def test_put_writes_to_method_dir_with_digest_and_ext(self, tmp_path, method):
        cache = ResponseCache(tmp_path)
        key = CacheKey(method=method, photo_sha=PHOTO_SHA, subject="book")
        path = cache.put(key, b"payload")
        expected = tmp_path / method / f"{key.digest()}{EXPECTED_EXT[method]}"
        assert path == expected
        assert expected.read_bytes() == b"payload"

    @pytest.mark.parametrize("method", sorted(EXPECTED_EXT))
    def test_get_round_trips_put_bytes(self, tmp_path, method):
        cache = ResponseCache(tmp_path)
        key = CacheKey(method=method, photo_sha=PHOTO_SHA, subject="mug", attempt=3)
        body = bytes(range(256))
        cache.put(key, body)
        assert cache.get(key) == body

    def test_get_miss_returns_none(self, tmp_path):
        cache = ResponseCache(tmp_path)
        key = CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book")
        assert cache.get(key) is None

    def test_get_miss_when_only_other_attempt_cached(self, tmp_path):
        cache = ResponseCache(tmp_path)
        cache.put(CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book"), b"x")
        other = CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book", attempt=1)
        assert cache.get(other) is None

    def test_put_empty_body_round_trips(self, tmp_path):
        cache = ResponseCache(tmp_path)
        key = CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book")
        cache.put(key, b"")
        assert cache.get(key) == b""

    def test_put_overwrites_existing_entry(self, tmp_path):
        cache = ResponseCache(tmp_path)
        key = CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book")
        cache.put(key, b"old")
        cache.put(key, b"new")
        assert cache.get(key) == b"new"

    def test_put_unknown_method_raises_value_error(self, tmp_path):
        cache = ResponseCache(tmp_path)
        key = CacheKey(method="bogus", photo_sha=PHOTO_SHA, subject="book")
        with pytest.raises(ValueError):
            cache.put(key, b"x")
        assert not (tmp_path / "bogus").exists()

    def test_get_unknown_method_raises_value_error(self, tmp_path):
        cache = ResponseCache(tmp_path)
        key = CacheKey(method="bogus", photo_sha=PHOTO_SHA, subject="book")
        with pytest.raises(ValueError):
            cache.get(key)


# Covers: MEM-003
# Requirement: in fixture mode the app replays recorded responses from the cache with no
# network: segment -> utf-8 text, spark_json -> parsed dict, image_edit -> raw bytes; a
# missing recording raises FixtureMissing (a LookupError) naming the method and digest.
class TestFixtureBackend:
    def test_segment_replays_utf8_text(self, tmp_path):
        text = "<seg>book \u00e9</seg>"
        key = CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book")
        ResponseCache(tmp_path).put(key, text.encode("utf-8"))
        assert FixtureBackend(tmp_path).segment(PHOTO_SHA, "book") == text

    def test_segment_uses_attempt_in_key(self, tmp_path):
        cache = ResponseCache(tmp_path)
        cache.put(CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book"), b"a0")
        cache.put(CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book", attempt=1), b"a1")
        backend = FixtureBackend(tmp_path)
        assert backend.segment(PHOTO_SHA, "book") == "a0"
        assert backend.segment(PHOTO_SHA, "book", attempt=1) == "a1"

    def test_spark_json_replays_parsed_dict(self, tmp_path):
        data = {"phrases": ["book", "mug", "lamp"]}
        key = CacheKey(method="spark_json", photo_sha=PHOTO_SHA, subject="phrases")
        ResponseCache(tmp_path).put(key, json.dumps(data).encode("utf-8"))
        result = FixtureBackend(tmp_path).spark_json(PHOTO_SHA, "phrases")
        assert isinstance(result, dict)
        assert result == data

    def test_image_edit_replays_raw_bytes(self, tmp_path):
        body = b"RIFF\x00\x00\x00\x00WEBPVP8 \xff\x00"
        key = CacheKey(method="image_edit", photo_sha=PHOTO_SHA, subject="book")
        ResponseCache(tmp_path).put(key, body)
        result = FixtureBackend(tmp_path).image_edit(PHOTO_SHA, "book")
        assert isinstance(result, bytes)
        assert result == body

    def test_fixture_missing_is_lookup_error(self):
        assert issubclass(FixtureMissing, LookupError)

    @pytest.mark.parametrize(
        "method,call",
        [
            ("segment", lambda b: b.segment(PHOTO_SHA, "book")),
            ("spark_json", lambda b: b.spark_json(PHOTO_SHA, "book")),
            ("image_edit", lambda b: b.image_edit(PHOTO_SHA, "book")),
        ],
    )
    def test_miss_raises_fixture_missing_naming_method_and_digest(self, tmp_path, method, call):
        digest = CacheKey(method=method, photo_sha=PHOTO_SHA, subject="book").digest()
        with pytest.raises(FixtureMissing) as excinfo:
            call(FixtureBackend(tmp_path))
        message = str(excinfo.value)
        assert method in message
        assert digest in message

    def test_miss_for_other_attempt_raises_fixture_missing(self, tmp_path):
        ResponseCache(tmp_path).put(CacheKey(method="segment", photo_sha=PHOTO_SHA, subject="book"), b"a0")
        with pytest.raises(FixtureMissing):
            FixtureBackend(tmp_path).segment(PHOTO_SHA, "book", attempt=1)
