import ast
import json
from pathlib import Path
from unittest import mock

import httpx
import pytest

from memripal.backend import ModelRequest, select_backend
from memripal.meta_client import to_data_url
from memripal.probe_metrics import Box, parse_boxes

FAKE_KEY = "fake-test-key-0123456789abcdefXYZ"
MODAL_URL = "https://seg.example.test/sam"
MODAL_TOKEN = "fake-modal-token-9876543210zyxwvu"
IMAGE = b"\xff\xd8\xff\xe0fake-processed-jpeg-bytes\xff\xd9"
SRC = Path(__file__).resolve().parents[1] / "src" / "memripal"

MODAL_BOXES = {
    "boxes": [
        {"x1": 10, "y1": 20, "x2": 110, "y2": 220, "score": 0.91},
        {"x1": 300, "y1": 40, "x2": 420, "y2": 160, "score": 0.42},
    ],
    "w": 640,
    "h": 480,
}
# What the Meta SAM endpoint answers in these tests: one box, distinct from the Modal pair.
META_SAM_TEXT = "<|box;x1=1;y1=2;x2=3;y2=4;w=640;h=480;c=0.5|>"


class _Net:
    """Stands in for every real network transport (no network): records Meta and Modal calls."""

    def __init__(self):
        self.modal: list[httpx.Request] = []
        self.meta_segment: list[httpx.Request] = []
        self.meta_chat: list[httpx.Request] = []
        self.other: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        request.read()
        if request.url.host == "seg.example.test":
            self.modal.append(request)
            return httpx.Response(200, json=MODAL_BOXES)
        if request.url.path.endswith("/responses"):
            self.meta_segment.append(request)
            return httpx.Response(200, json={"output_text": META_SAM_TEXT})
        if request.url.path.endswith("/chat/completions"):
            self.meta_chat.append(request)
            content = json.dumps({"phrases": ["book"]})
            return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})
        self.other.append(request)
        return httpx.Response(404, json={"error": {"code": "not_found"}})


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in (
        "MEMRIPAL_MODE",
        "META_API_KEY",
        "MEMRIPAL_SEG_PROVIDER",
        "MEMRIPAL_MODAL_SEG_URL",
        "MODAL_SEG_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


@pytest.fixture
def net():
    fake = _Net()
    # Every httpx.Client built without an explicit transport routes here, whoever builds it.
    with mock.patch.object(
        httpx.HTTPTransport,
        "handle_request",
        autospec=True,
        side_effect=lambda _self, request: fake(request),
    ):
        yield fake


def _modal_env(monkeypatch):
    monkeypatch.setenv("META_API_KEY", FAKE_KEY)
    monkeypatch.setenv("MEMRIPAL_SEG_PROVIDER", "modal")
    monkeypatch.setenv("MEMRIPAL_MODAL_SEG_URL", MODAL_URL)
    monkeypatch.setenv("MODAL_SEG_TOKEN", MODAL_TOKEN)


def _segment_request():
    return ModelRequest(
        method="segment",
        image_jpeg=IMAGE,
        subject="book",
        attempt=0,
        model="sam-3.1",
        prompt_template_id="sam-phrase",
        gen_params={},
        schema=None,
    )


def _spark_request():
    return ModelRequest(
        method="spark_json",
        image_jpeg=IMAGE,
        subject="phrases",
        attempt=0,
        model="muse-spark-1.3",
        prompt_template_id="phrase",
        gen_params={"max_completion_tokens": 1024},
        schema=None,
    )


# Covers: MEM-016
# Requirement: the segmentation provider choice is validated when the live backend starts: an
# unknown MEMRIPAL_SEG_PROVIDER fails meta-mode startup with ValueError, and "modal" without
# MEMRIPAL_MODAL_SEG_URL or MODAL_SEG_TOKEN fails startup with ValueError; neither error ever
# contains the Meta key or the Modal token. The default ("meta") needs no Modal configuration.
class TestSegProviderStartup:
    @pytest.mark.parametrize("provider", ["openai", "", "MODAL", "sam"])
    def test_unknown_seg_provider_fails_meta_startup(self, monkeypatch, tmp_path, provider):
        monkeypatch.setenv("META_API_KEY", FAKE_KEY)
        monkeypatch.setenv("MEMRIPAL_SEG_PROVIDER", provider)
        with pytest.raises(ValueError) as excinfo:
            select_backend("meta", tmp_path)
        assert FAKE_KEY not in str(excinfo.value)

    @pytest.mark.parametrize("missing", ["MEMRIPAL_MODAL_SEG_URL", "MODAL_SEG_TOKEN"])
    def test_modal_without_its_config_fails_meta_startup(self, monkeypatch, tmp_path, missing):
        _modal_env(monkeypatch)
        monkeypatch.delenv(missing)
        with pytest.raises(ValueError) as excinfo:
            select_backend("meta", tmp_path)
        assert FAKE_KEY not in str(excinfo.value)
        assert MODAL_TOKEN not in str(excinfo.value)

    def test_default_provider_needs_no_modal_config(self, monkeypatch, tmp_path):
        monkeypatch.setenv("META_API_KEY", FAKE_KEY)
        assert select_backend("meta", tmp_path).mode == "meta"


# Covers: MEM-016
# Requirement: with MEMRIPAL_SEG_PROVIDER=modal the live backend sends segment calls (the
# processed image and the phrase) to our Modal endpoint with its bearer token, never to Meta
# SAM, and returns SAM-style token text that parse_boxes reads unchanged; Spark chat calls stay
# on Meta. With the default provider, segment calls stay on Meta and Modal is never contacted.
class TestSegProviderRouting:
    def test_modal_segment_goes_to_modal_and_parses_to_boxes(self, monkeypatch, tmp_path, net):
        _modal_env(monkeypatch)
        backend = select_backend("meta", tmp_path)

        text = backend.call(_segment_request())

        assert len(net.modal) == 1
        assert net.meta_segment == []
        sent = net.modal[0]
        assert str(sent.url) == MODAL_URL
        assert sent.headers["Authorization"] == "Bearer " + MODAL_TOKEN
        assert json.loads(sent.content) == {"image": to_data_url(IMAGE), "phrase": "book"}
        assert parse_boxes(text) == [
            Box(x1=10, y1=20, x2=110, y2=220, w=640, h=480, confidence=0.91),
            Box(x1=300, y1=40, x2=420, y2=160, w=640, h=480, confidence=0.42),
        ]
        assert MODAL_TOKEN not in repr(backend)
        assert MODAL_TOKEN not in str(backend)

    def test_modal_keeps_spark_chat_on_meta(self, monkeypatch, tmp_path, net):
        _modal_env(monkeypatch)
        backend = select_backend("meta", tmp_path)

        assert backend.call(_spark_request()) == {"phrases": ["book"]}
        assert len(net.meta_chat) == 1
        assert net.modal == []

    def test_default_segment_stays_on_meta(self, monkeypatch, tmp_path, net):
        monkeypatch.setenv("META_API_KEY", FAKE_KEY)
        monkeypatch.setenv("MEMRIPAL_MODAL_SEG_URL", MODAL_URL)
        monkeypatch.setenv("MODAL_SEG_TOKEN", MODAL_TOKEN)
        backend = select_backend("meta", tmp_path)

        text = backend.call(_segment_request())

        assert net.modal == []
        assert len(net.meta_segment) == 1
        assert text == META_SAM_TEXT


def _seg_provider_call_sites() -> list[str]:
    sites = []
    for path in sorted(SRC.glob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
            if name == "select_seg_provider":
                sites.append(path.name)
    return sites


# Covers: MEM-016
# Requirement: the provider toggle is read at exactly one call site, in backend.py (S2.5 plan:
# "one call site in backend.py"), so no other module can pick a different segmentation provider.
class TestSegProviderSingleCallSite:
    def test_exactly_one_call_site_in_backend(self):
        assert _seg_provider_call_sites() == ["backend.py"]
