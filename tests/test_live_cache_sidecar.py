# Covers: MEM-043
# Requirement (P1 sidecars, Kev Q23(ii)): every live-cache response entry the MetaBackend writes gets one
# sidecar file next to it, `<entry file name>.sha`, naming the photo sha of the run that produced it
# (RequestKey.photo_sha = process_upload(photo).sha), for every method: loci (Spark phrases, the
# re-ask, SAM segment), notes (split) and associate, including the provider-distinct Modal SAM and
# non-Meta chat entries. The sidecar is written atomically (temp file, then os.replace onto its final
# path; one file per entry, so concurrent writes cannot clash) and never holds the key. An OSError while
# writing it is logged like an entry write failure and never fails the call. promote_live_cache.py
# attributes entries to a room by these sidecars.
import dataclasses
import json
import os
from io import BytesIO
from types import SimpleNamespace
from unittest import mock

import pytest
from PIL import Image, ImageDraw
from test_associate import good_record
from test_live_cache import (
    FAKE_KEY,
    IMAGE,
    IMAGE_SHA,
    VALID_SPARK,
    _chat_envelope,
    _FakeClient,
    _files_under,
    _ok,
    _request,
    _segment_request,
)

from memripal.associate import associate
from memripal.backend import MetaBackend, ResponseCache
from memripal.imaging import process_upload
from memripal.loci import find_loci
from memripal.split import split_notes

SIDECAR_SUFFIX = ".sha"
PHRASES = ["kettle", "toaster", "spice rack", "cutting board"]
REASK_PHRASES = ["fruit bowl", "oven mitt"]
ITEM = "milk carton"
LOCUS = "kettle"
NOTES = "Buy milk. Call the dentist. Water the plants."


def sidecar_of(entry):
    """The sidecar path for one response entry: same directory, entry file name plus SIDECAR_SUFFIX."""
    return entry.with_name(entry.name + SIDECAR_SUFFIX)


def is_sidecar(path):
    return path.name.endswith(SIDECAR_SUFFIX)


def response_entries(root):
    """Response entries under a live-cache root: not photos/, not sidecars, not temp files."""
    return [
        p
        for p in _files_under(root)
        if p.relative_to(root).parts[0] != "photos" and not is_sidecar(p) and not p.name.endswith(".tmp")
    ]


def room_photo(color=(50, 45, 40)):
    img = Image.new("RGB", (640, 480), color)
    draw = ImageDraw.Draw(img)
    for i in range(4):
        draw.rectangle((40 + 140 * i, 120, 140 + 140 * i, 360), fill=(200 - 40 * i, 60 + 30 * i, 90))
    buf = BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


class RoutingClient:
    """MetaBackend's client for every flow: replies by schema_name (the request subject), no network."""

    def __init__(self):
        self.subjects = []

    def chat_json(self, **kwargs):
        subject = kwargs["schema_name"]
        self.subjects.append(subject)
        if subject == "split":
            content = {"points": [{"label": "milk", "source_quote": "Buy milk."}]}
        elif subject == "association":
            content = good_record(ITEM, LOCUS)
        elif subject == "phrases-reask":
            content = {"phrases": REASK_PHRASES}
        else:
            content = {"phrases": PHRASES}
        return _ok(_chat_envelope(content))

    def segment(self, **kwargs):
        self.subjects.append("segment")
        text = f"<ref>{kwargs['phrase']}</ref><box>(40,120),(140,360)</box>"
        return _ok(json.dumps({"output_text": text}).encode("utf-8"))


def _run(flow, backend, processed):
    if flow == "loci":
        find_loci(backend, processed, clock=lambda: 0.0)
    elif flow == "notes":
        split_notes(backend, processed.jpeg, NOTES, 6)
    else:
        assert associate(backend, processed, ITEM, LOCUS).status == "valid"


def _assert_every_entry_has_its_sidecar(root, sha):
    entries = response_entries(root)
    assert entries, "the run wrote no response entry"
    for entry in entries:
        sidecar = sidecar_of(entry)
        assert sidecar.is_file(), f"no sidecar for {entry.relative_to(root).as_posix()}"
        text = sidecar.read_text(encoding="ascii")
        assert sha in text
        assert FAKE_KEY not in text
    # One sidecar per entry, none orphaned.
    assert sorted(p for p in _files_under(root) if is_sidecar(p)) == sorted(sidecar_of(e) for e in entries)


# Covers: MEM-043
class TestEveryEntryGetsAPhotoShaSidecar:
    @pytest.mark.parametrize("flow", ["loci", "notes", "associate"])
    def test_each_flow_writes_one_sidecar_per_entry_naming_the_photo_sha(self, tmp_path, flow):
        processed = process_upload(room_photo())
        backend = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=RoutingClient())
        _run(flow, backend, processed)
        _assert_every_entry_has_its_sidecar(tmp_path, processed.sha)

    def test_loci_run_sidecars_cover_spark_reask_and_segment_entries(self, tmp_path):
        processed = process_upload(room_photo())
        client = RoutingClient()
        find_loci(MetaBackend(FAKE_KEY, cache_root=tmp_path, client=client), processed, clock=lambda: 0.0)
        assert {"phrases", "phrases-reask", "segment"} <= set(client.subjects)
        spark = [p for p in response_entries(tmp_path) if p.parent.name == "spark_json"]
        segment = [p for p in response_entries(tmp_path) if p.parent.name == "segment"]
        assert len(spark) == 2
        assert len(segment) == len(PHRASES) + len(REASK_PHRASES)
        for entry in spark + segment:
            assert processed.sha in sidecar_of(entry).read_text(encoding="ascii")

    def test_direct_spark_and_segment_calls_write_sidecars_next_to_their_entries(self, tmp_path):
        cache = ResponseCache(tmp_path)
        spark_req, seg_req = _request(), _segment_request()
        MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(VALID_SPARK)).call(spark_req)
        seg_result = _ok(b'{"output_text": "<box>1 2 3 4</box>"}')
        MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(seg_result)).call(seg_req)
        for req in (spark_req, seg_req):
            sidecar = sidecar_of(cache.path_for(req.cache_key()))
            assert sidecar.parent == cache.path_for(req.cache_key()).parent
            assert IMAGE_SHA in sidecar.read_text(encoding="ascii")

    def test_modal_segment_and_non_meta_chat_entries_get_sidecars(self, tmp_path):
        seg_client = SimpleNamespace(segment=lambda image_jpeg, phrase: "<box>1 2 3 4</box>")
        chat = SimpleNamespace(name="local", model="llama3.2", client=_FakeClient(VALID_SPARK))
        backend = MetaBackend(
            FAKE_KEY, cache_root=tmp_path, client=_FakeClient(VALID_SPARK), seg_client=seg_client, chat=chat
        )
        seg_req, spark_req = _segment_request(), _request()
        backend.call(seg_req)
        backend.call(spark_req)
        cache = ResponseCache(tmp_path)
        stored = [
            dataclasses.replace(seg_req, model="modal/" + seg_req.model),
            dataclasses.replace(spark_req, model="local/llama3.2"),
        ]
        for req in stored:
            entry = cache.path_for(req.cache_key())
            assert entry.is_file()
            assert IMAGE_SHA in sidecar_of(entry).read_text(encoding="ascii")
        _assert_every_entry_has_its_sidecar(tmp_path, IMAGE_SHA)

    def test_two_photos_sidecars_each_name_only_their_own_photo(self, tmp_path):
        first, second = process_upload(room_photo()), process_upload(room_photo((180, 170, 150)))
        assert first.sha != second.sha
        shas = {}
        for processed in (first, second):
            before = set(response_entries(tmp_path))
            backend = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=RoutingClient())
            _run("associate", backend, processed)
            _run("notes", backend, processed)
            new = set(response_entries(tmp_path)) - before
            assert new
            shas.update({entry: processed.sha for entry in new})
        for entry, sha in shas.items():
            text = sidecar_of(entry).read_text(encoding="ascii")
            other = second.sha if sha == first.sha else first.sha
            assert sha in text
            assert other not in text


_REAL_REPLACE = os.replace


# Covers: MEM-043
class TestSidecarWriteIsAtomicAndBestEffort:
    def test_sidecar_lands_by_os_replace_onto_its_final_path_and_leaves_no_temp(self, tmp_path):
        req = _request()
        sidecar = sidecar_of(ResponseCache(tmp_path).path_for(req.cache_key()))
        with mock.patch("os.replace", wraps=os.replace) as replace:
            MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(VALID_SPARK)).call(req)
        assert os.fspath(sidecar) in [os.fspath(c.args[1]) for c in replace.call_args_list]
        assert sidecar.is_file()
        assert not [p for p in _files_under(tmp_path) if p.name.endswith(".tmp")]

    def test_sidecar_write_oserror_never_fails_the_call(self, tmp_path):
        def replace(src, dst):
            if os.fspath(dst).endswith(SIDECAR_SUFFIX):
                raise PermissionError(13, "The process cannot access the file", os.fspath(dst))
            return _REAL_REPLACE(src, dst)

        backend = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(VALID_SPARK))
        with mock.patch("os.replace", side_effect=replace) as patched:
            assert backend.call(_request()) == {"phrases": ["book", "mug"]}
        assert [c for c in patched.call_args_list if os.fspath(c.args[1]).endswith(SIDECAR_SUFFIX)]
        assert not [p for p in _files_under(tmp_path) if is_sidecar(p)]
        assert not [p for p in _files_under(tmp_path) if p.name.endswith(".tmp")]

    def test_photo_bytes_are_unchanged_by_sidecar_writes(self, tmp_path):
        MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_FakeClient(VALID_SPARK)).call(_request())
        assert (tmp_path / "photos" / f"{IMAGE_SHA}.jpg").read_bytes() == IMAGE
        assert not [p for p in _files_under(tmp_path / "photos") if is_sidecar(p)]
        _assert_every_entry_has_its_sidecar(tmp_path, IMAGE_SHA)
