import os
import threading
from unittest import mock

import pytest
from test_live_cache import (
    FAKE_KEY,
    IMAGE,
    IMAGE_SHA,
    VALID_SEGMENT,
    VALID_SPARK,
    _FakeClient,
    _files_under,
    _request,
    _segment_request,
)

from memripal.backend import MetaBackend, ResponseCache

_REAL_REPLACE = os.replace
PHOTO_NAME = f"{IMAGE_SHA}.jpg"


def _replace_failing_for(predicate):
    """os.replace stand-in: PermissionError (a Windows sharing violation) when predicate(dst) holds."""

    def replace(src, dst):
        if predicate(os.fspath(dst)):
            raise PermissionError(13, "The process cannot access the file", os.fspath(dst))
        return _REAL_REPLACE(src, dst)

    return replace


def _is_photo(dst):
    return os.path.basename(dst) == PHOTO_NAME


# Covers: MEM-014
# Requirement: live-cache writes are best-effort. Once a live call returned a valid value, an
# OSError (e.g. a Windows PermissionError when several concurrent segment calls on the same
# processed photo replace photos/<sha>.jpg at once) while writing the response entry or the
# photo never fails the request: MetaBackend.call still returns the value. A photo already on
# disk is not rewritten, and N concurrent calls with the same image all succeed.
class TestCacheWritesBestEffort:
    @pytest.mark.parametrize(
        ("req_factory", "result", "expected"),
        [
            (_request, VALID_SPARK, {"phrases": ["book", "mug"]}),
            (_segment_request, VALID_SEGMENT, "<box>1 2 3 4</box>"),
        ],
        ids=["spark_json", "segment"],
    )
    def test_photo_write_permission_error_still_returns_value(self, tmp_path, req_factory, result, expected):
        backend = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(result))
        with mock.patch("os.replace", side_effect=_replace_failing_for(_is_photo)):
            assert backend.call(req_factory()) == expected

        assert not (tmp_path / "photos" / PHOTO_NAME).exists()
        assert not [p for p in _files_under(tmp_path) if p.name.endswith(".tmp")]

    def test_response_write_permission_error_still_returns_value(self, tmp_path):
        req = _request()
        backend = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(VALID_SPARK))
        with mock.patch("os.replace", side_effect=_replace_failing_for(lambda dst: not _is_photo(dst))):
            assert backend.call(req) == {"phrases": ["book", "mug"]}

        assert not ResponseCache(tmp_path).path_for(req.cache_key()).exists()
        assert not [p for p in _files_under(tmp_path) if p.name.endswith(".tmp")]

    def test_every_cache_write_failing_still_returns_value(self, tmp_path):
        backend = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(VALID_SPARK))
        with mock.patch("os.replace", side_effect=OSError("disk full")):
            assert backend.call(_request()) == {"phrases": ["book", "mug"]}

        assert _files_under(tmp_path) == []

    def test_existing_photo_is_not_rewritten_by_a_later_call(self, tmp_path):
        backend = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(VALID_SEGMENT))
        with mock.patch("os.replace", wraps=os.replace) as replace:
            backend.call(_segment_request(subject="book"))
            backend.call(_segment_request(subject="mug"))

        photo_writes = [c for c in replace.call_args_list if _is_photo(os.fspath(c.args[1]))]
        assert len(photo_writes) == 1
        assert (tmp_path / "photos" / PHOTO_NAME).read_bytes() == IMAGE

    def test_put_photo_skips_an_existing_photo(self, tmp_path):
        cache = ResponseCache(tmp_path)
        photo = cache.put_photo(IMAGE)
        with mock.patch("os.replace", wraps=os.replace) as replace:
            again = cache.put_photo(IMAGE)

        assert again == photo
        assert not [c for c in replace.call_args_list if _is_photo(os.fspath(c.args[1]))]
        assert photo.read_bytes() == IMAGE

    def test_concurrent_same_image_calls_all_succeed(self, tmp_path):
        n = 6
        barrier = threading.Barrier(n, timeout=10)
        claimed = set()
        lock = threading.Lock()

        class _GatedClient(_FakeClient):
            def segment(self, **kwargs):
                barrier.wait()  # every thread is past its network call before any cache write
                return self.result

        def contended_replace(src, dst):
            # Deterministic stand-in for Windows: only the first replace onto a path wins.
            with lock:
                key = os.path.normcase(os.fspath(dst))
                if key in claimed:
                    raise PermissionError(13, "The process cannot access the file", os.fspath(dst))
                claimed.add(key)
                return _REAL_REPLACE(src, dst)

        backend = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_GatedClient(VALID_SEGMENT))
        results, errors = {}, []

        def worker(i):
            try:
                results[i] = backend.call(_segment_request(subject=f"thing-{i}"))
            except BaseException as exc:
                errors.append(exc)

        with mock.patch("os.replace", side_effect=contended_replace):
            threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=30)

        assert not [t for t in threads if t.is_alive()]
        assert errors == []
        assert results == {i: "<box>1 2 3 4</box>" for i in range(n)}
        assert _files_under(tmp_path / "photos") == [tmp_path / "photos" / PHOTO_NAME]
        assert (tmp_path / "photos" / PHOTO_NAME).read_bytes() == IMAGE


# Covers: MEM-014
# Requirement: the processed photo is written before the response entry, so a response entry
# is never left in the live cache without its photo: when the photo write fails, no response
# entry is written either (and the call still returns its valid value).
class TestPhotoWrittenBeforeResponse:
    def test_photo_replace_happens_before_response_replace(self, tmp_path):
        req = _request()
        response = ResponseCache(tmp_path).path_for(req.cache_key())
        with mock.patch("os.replace", wraps=os.replace) as replace:
            MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(VALID_SPARK)).call(req)

        dsts = [os.fspath(c.args[1]) for c in replace.call_args_list]
        photo = os.fspath(tmp_path / "photos" / PHOTO_NAME)
        assert dsts.index(photo) < dsts.index(os.fspath(response))

    def test_failed_photo_write_leaves_no_response_entry(self, tmp_path):
        req = _request()
        backend = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(VALID_SPARK))
        with mock.patch("os.replace", side_effect=_replace_failing_for(_is_photo)):
            assert backend.call(req) == {"phrases": ["book", "mug"]}

        assert _files_under(tmp_path) == []


def _replace_losing_race_for(predicate):
    """os.replace stand-in: a concurrent winner lands dst first, then this replace hits PermissionError."""

    def replace(src, dst):
        if predicate(os.fspath(dst)):
            with open(dst, "wb") as f:
                f.write(IMAGE)  # the winner's identical, content-addressed bytes
            raise PermissionError(13, "The process cannot access the file", os.fspath(dst))
        return _REAL_REPLACE(src, dst)

    return replace


# Covers: MEM-014
# Requirement: photos/<sha>.jpg is content-addressed, so a photo write that fails because a
# concurrent same-image call already landed that file counts as success: put_photo returns the
# path without raising, and MetaBackend.call still writes its response cache entry (a lost race
# must not make the next live run re-pay the call). A photo write failing while the target is
# still missing is a real failure: put_photo raises and no response entry is written.
class TestExistingPhotoCountsAsSuccess:
    def test_put_photo_returns_path_when_a_concurrent_winner_landed_it(self, tmp_path):
        cache = ResponseCache(tmp_path)
        with mock.patch("os.replace", side_effect=_replace_losing_race_for(_is_photo)):
            photo = cache.put_photo(IMAGE)

        assert photo == tmp_path / "photos" / PHOTO_NAME
        assert photo.read_bytes() == IMAGE
        assert not [p for p in _files_under(tmp_path) if p.name.endswith(".tmp")]

    def test_put_photo_still_raises_when_the_target_is_missing(self, tmp_path):
        cache = ResponseCache(tmp_path)
        with mock.patch("os.replace", side_effect=_replace_failing_for(_is_photo)):
            with pytest.raises(PermissionError):
                cache.put_photo(IMAGE)

        assert _files_under(tmp_path) == []

    @pytest.mark.parametrize(
        ("req_factory", "result", "expected"),
        [
            (_request, VALID_SPARK, {"phrases": ["book", "mug"]}),
            (_segment_request, VALID_SEGMENT, "<box>1 2 3 4</box>"),
        ],
        ids=["spark_json", "segment"],
    )
    def test_lost_photo_race_still_caches_the_response(self, tmp_path, req_factory, result, expected):
        req = req_factory()
        backend = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(result))
        with mock.patch("os.replace", side_effect=_replace_losing_race_for(_is_photo)):
            assert backend.call(req) == expected

        assert ResponseCache(tmp_path).get(req.cache_key()) is not None
        assert (tmp_path / "photos" / PHOTO_NAME).read_bytes() == IMAGE
        assert not [p for p in _files_under(tmp_path) if p.name.endswith(".tmp")]
