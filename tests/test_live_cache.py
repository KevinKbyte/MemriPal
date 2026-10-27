import hashlib
import inspect
import json
import os
import shutil
import subprocess
import sys
from unittest import mock

import pytest

from memripal import app as app_module
from memripal import backend as backend_module
from memripal.backend import (
    BackendCallFailed,
    FixtureBackend,
    MetaBackend,
    ModelRequest,
    ResponseCache,
    select_backend,
)
from memripal.meta_client import CallResult

FAKE_KEY = "fake-test-key-0123456789abcdefXYZ"
IMAGE = b"\xff\xd8\xff\xe0fake-processed-jpeg-bytes\xff\xd9"
IMAGE_SHA = hashlib.sha256(IMAGE).hexdigest()
PHRASES_SCHEMA = {
    "type": "object",
    "properties": {"phrases": {"type": "array", "items": {"type": "string"}}},
    "required": ["phrases"],
    "additionalProperties": False,
}


def _request(**overrides):
    fields = {
        "method": "spark_json",
        "image_jpeg": IMAGE,
        "subject": "phrases",
        "attempt": 0,
        "model": "muse-spark-1.3",
        "prompt_template_id": "phrase",
        "gen_params": {"max_completion_tokens": 1024, "temperature": 0.0},
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


def _ok(body):
    return CallResult(ok=True, status=200, body=body, error=None, attempts=1, latency_s=0.01)


def _chat_envelope(content):
    text = content if isinstance(content, str) else json.dumps(content)
    return json.dumps({"choices": [{"message": {"content": text}}]}).encode("utf-8")


VALID_SPARK = _ok(_chat_envelope({"phrases": ["book", "mug"]}))
VALID_SEGMENT = _ok(json.dumps({"output_text": "<box>1 2 3 4</box>"}).encode("utf-8"))


class _FakeClient:
    def __init__(self, result):
        self.result = result

    def chat_json(self, **kwargs):
        return self.result

    def segment(self, **kwargs):
        return self.result


def _files_under(root):
    return sorted(p for p in root.rglob("*") if p.is_file())


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    monkeypatch.delenv("MEMRIPAL_MODE", raising=False)
    monkeypatch.setenv("META_API_KEY", FAKE_KEY)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


@pytest.fixture
def fake_client():
    """Replaces the lazily-imported MetaClient so select_backend's MetaBackend never hits the network."""
    client = _FakeClient(VALID_SPARK)
    with mock.patch("memripal.meta_client.MetaClient", return_value=client):
        yield client


@pytest.fixture
def layout(tmp_path):
    fixtures_root = tmp_path / "fixtures" / "replay"
    fixtures_root.mkdir(parents=True)
    live_root = tmp_path / "refs" / "private" / "live-cache"
    return fixtures_root, live_root


# Covers: MEM-014
# Requirement: live (meta) mode never writes into the git-tracked fixtures tree. select_backend
# takes a separate live_cache_root: meta mode writes its write-through cache there (None -> no
# disk writes at all), fixture mode still replays from fixtures_root, and a live_cache_root that
# resolves inside the fixtures/ directory (fixtures_root.parent) is rejected with ValueError.
class TestSelectBackendLiveCacheRoot:
    def test_meta_writes_response_under_live_root_and_nothing_under_fixtures(
        self, tmp_path, layout, fake_client
    ):
        fixtures_root, live_root = layout
        req = _request()
        backend = select_backend("meta", fixtures_root, live_cache_root=live_root)

        assert backend.call(req) == {"phrases": ["book", "mug"]}

        assert ResponseCache(live_root).path_for(req.cache_key()).is_file()
        assert FixtureBackend(live_root).call(req) == {"phrases": ["book", "mug"]}
        assert _files_under(tmp_path / "fixtures") == []

    def test_meta_without_live_root_writes_nothing_anywhere(self, tmp_path, layout, fake_client):
        fixtures_root, _ = layout
        backend = select_backend("meta", fixtures_root)

        assert backend.call(_request()) == {"phrases": ["book", "mug"]}

        assert _files_under(tmp_path) == []

    def test_meta_with_explicit_none_live_root_writes_nothing_anywhere(self, tmp_path, layout, fake_client):
        fixtures_root, _ = layout
        backend = select_backend("meta", fixtures_root, live_cache_root=None)

        assert backend.call(_request()) == {"phrases": ["book", "mug"]}

        assert _files_under(tmp_path) == []

    @pytest.mark.parametrize(
        "relative",
        [
            "fixtures",
            "fixtures/live-cache",
            "fixtures/replay",
            "fixtures/replay/live",
            "refs/../fixtures/live-cache",
        ],
    )
    def test_live_root_inside_fixtures_dir_rejected(self, tmp_path, layout, fake_client, relative):
        fixtures_root, _ = layout
        with pytest.raises(ValueError) as excinfo:
            select_backend("meta", fixtures_root, live_cache_root=tmp_path / relative)
        assert FAKE_KEY not in str(excinfo.value)

    def test_sibling_dir_sharing_fixtures_name_prefix_allowed(self, tmp_path, layout, fake_client):
        fixtures_root, _ = layout
        backend = select_backend("meta", fixtures_root, live_cache_root=tmp_path / "fixtures-live")
        assert isinstance(backend, MetaBackend)

    def test_fixture_mode_still_replays_from_fixtures_root_and_writes_nothing_live(self, layout):
        fixtures_root, live_root = layout
        req = _request()
        ResponseCache(fixtures_root).put(req.cache_key(), b'{"phrases": ["lamp"]}')

        backend = select_backend("fixture", fixtures_root, live_cache_root=live_root)

        assert isinstance(backend, FixtureBackend)
        assert backend.call(req) == {"phrases": ["lamp"]}
        assert not live_root.exists()

    @pytest.mark.parametrize(
        "result",
        [
            CallResult(ok=False, status=429, body=b"{}", error="429 rate_limited", attempts=3, latency_s=0.5),
            _ok(_chat_envelope({"phrases": "book"})),
            _ok(b'{"choices": [{"message": {"cont'),
        ],
        ids=["failed-call", "schema-invalid", "truncated"],
    )
    def test_failed_or_invalid_response_writes_neither_response_nor_photo(
        self, tmp_path, layout, fake_client, result
    ):
        fixtures_root, live_root = layout
        fake_client.result = result
        backend = select_backend("meta", fixtures_root, live_cache_root=live_root)

        with pytest.raises(BackendCallFailed):
            backend.call(_request())

        assert _files_under(tmp_path) == []


# Covers: MEM-014
# Requirement: after a successful, schema-valid live response with a cache root set, the
# processed photo that was sent is saved as <cache_root>/photos/<sha256 hex>.jpg (byte-identical
# to the request image) for a later promote step; the save is idempotent (same image -> one
# file) and atomic (temp file + os.replace onto the final path, no temp left behind).
class TestMetaBackendSavesProcessedPhoto:
    @pytest.mark.parametrize(
        ("req_factory", "result"),
        [(_request, VALID_SPARK), (_segment_request, VALID_SEGMENT)],
        ids=["spark_json", "segment"],
    )
    def test_photo_saved_at_sha_path_with_request_bytes(self, tmp_path, req_factory, result):
        req = req_factory()
        MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(result)).call(req)

        photo = tmp_path / "photos" / f"{IMAGE_SHA}.jpg"
        assert photo.is_file()
        assert photo.read_bytes() == req.image_jpeg

    def test_repeat_calls_with_same_image_keep_one_identical_photo(self, tmp_path):
        backend = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(VALID_SPARK))
        backend.call(_request())
        backend.call(_request())
        backend.call(
            _request(
                subject="phrases-reask",
                prompt_template_id="phrase-reask",
                gen_params={"prompt_args": {"exclude": ["book"]}},
            )
        )

        photos = _files_under(tmp_path / "photos")
        assert photos == [tmp_path / "photos" / f"{IMAGE_SHA}.jpg"]
        assert photos[0].read_bytes() == IMAGE

    def test_different_images_get_separate_photos(self, tmp_path):
        other = IMAGE + b"\x00"
        backend = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(VALID_SPARK))
        backend.call(_request())
        backend.call(_request(image_jpeg=other))

        photos_dir = tmp_path / "photos"
        assert (photos_dir / f"{IMAGE_SHA}.jpg").read_bytes() == IMAGE
        assert (photos_dir / f"{hashlib.sha256(other).hexdigest()}.jpg").read_bytes() == other

    def test_photo_write_is_atomic_replace_with_no_temp_left(self, tmp_path):
        photo = tmp_path / "photos" / f"{IMAGE_SHA}.jpg"
        with mock.patch("os.replace", wraps=os.replace) as replace:
            MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(VALID_SPARK)).call(_request())

        dsts = [os.fspath(c.args[1]) for c in replace.call_args_list]
        assert os.fspath(photo) in dsts
        assert not [p for p in _files_under(tmp_path) if p.name.endswith(".tmp")]

    def test_no_cache_root_saves_no_photo(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        MetaBackend(FAKE_KEY, cache_root=None, client=_FakeClient(VALID_SPARK)).call(_request())
        assert _files_under(tmp_path) == []


# Covers: MEM-014
# Requirement: the app's live cache lives at <repo>/refs/private/live-cache, which is
# gitignored and outside fixtures/, and create_app passes it to select_backend so meta mode
# writes there instead of into the committed fixtures/replay recordings.
class TestAppLiveCacheDir:
    def test_live_cache_dir_is_refs_private_live_cache(self):
        expected = app_module.REPO_ROOT / "refs" / "private" / "live-cache"
        assert getattr(app_module, "LIVE_CACHE_DIR", None) == expected

    def test_live_cache_dir_is_outside_fixtures(self):
        live = getattr(app_module, "LIVE_CACHE_DIR", None)
        assert live is not None
        assert not live.resolve().is_relative_to(app_module.REPLAY_DIR.parent.resolve())

    @pytest.mark.skipif(shutil.which("git") is None, reason="git not on PATH")
    def test_live_cache_dir_is_gitignored(self):
        proc = subprocess.run(
            ["git", "-C", str(app_module.REPO_ROOT), "check-ignore", "-q", "refs/private/live-cache/x"],
            check=False,
            capture_output=True,
        )
        assert proc.returncode == 0

    def test_meta_mode_create_app_passes_live_cache_dir(self, monkeypatch, fake_client):
        monkeypatch.setenv("MEMRIPAL_MODE", "meta")
        real = backend_module.select_backend
        with mock.patch.object(app_module, "select_backend", wraps=real) as spy:
            app_module.create_app()

        [call] = spy.call_args_list
        bound = inspect.signature(real).bind(*call.args, **call.kwargs).arguments
        assert bound.get("live_cache_root") == app_module.REPO_ROOT / "refs" / "private" / "live-cache"
        assert bound.get("fixtures_root") == app_module.REPLAY_DIR


def _make_dir_link(request, link, target):
    """Directory symlink, else a Windows junction; skips only when neither can be created."""
    link.parent.mkdir(parents=True, exist_ok=True)
    kind = None
    try:
        os.symlink(target, link, target_is_directory=True)
        kind = "symlink"
    except (OSError, NotImplementedError):
        if sys.platform == "win32":
            proc = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, check=False
            )
            if proc.returncode == 0 and link.is_junction():
                kind = "junction"
    if kind is None:
        pytest.skip("neither a directory symlink nor a junction could be created")
    request.addfinalizer(lambda: os.rmdir(link) if sys.platform == "win32" else os.unlink(link))
    print(f"dir-link kind: {kind}")
    return kind


# Covers: MEM-014
# Requirement: the live cache and the fixtures tree never nest in either direction.
# select_backend raises ValueError when live_cache_root resolves inside fixtures/ (including
# through a directory symlink or junction, so resolution follows links rather than comparing
# lexical paths) and also when fixtures/ (fixtures_root.parent) resolves inside
# live_cache_root, e.g. live_cache_root=<repo> with fixtures_root=<repo>/fixtures/replay. The
# real layout, refs/private/live-cache next to fixtures/, is allowed.
class TestLiveRootContainmentTwoWay:
    @pytest.mark.parametrize(
        "relative", [".", "refs/..", "fixtures-sibling/.."], ids=["root", "refs-dotdot", "sibling-dotdot"]
    )
    def test_live_root_containing_fixtures_dir_rejected(self, tmp_path, layout, fake_client, relative):
        fixtures_root, _ = layout
        with pytest.raises(ValueError) as excinfo:
            select_backend("meta", fixtures_root, live_cache_root=tmp_path / relative)
        assert FAKE_KEY not in str(excinfo.value)

    def test_live_root_above_repo_rejected(self, tmp_path, layout, fake_client):
        fixtures_root, _ = layout
        with pytest.raises(ValueError):
            select_backend("meta", fixtures_root, live_cache_root=tmp_path.parent)

    def test_refs_private_live_cache_next_to_fixtures_allowed(self, layout, fake_client):
        fixtures_root, live_root = layout
        assert isinstance(select_backend("meta", fixtures_root, live_cache_root=live_root), MetaBackend)

    @pytest.mark.parametrize("child", [None, "live-cache"], ids=["link-itself", "under-link"])
    def test_live_root_through_dir_link_into_fixtures_rejected(
        self, request, tmp_path, layout, fake_client, child
    ):
        fixtures_root, _ = layout
        target = tmp_path / "fixtures" / "live-target"
        target.mkdir()
        link = tmp_path / "refs" / "private" / "linked"
        _make_dir_link(request, link, target)
        live_root = link if child is None else link / child
        # Lexically outside fixtures/: only link resolution can catch it.
        assert not os.path.abspath(live_root).startswith(os.path.abspath(tmp_path / "fixtures"))

        with pytest.raises(ValueError):
            select_backend("meta", fixtures_root, live_cache_root=live_root)
