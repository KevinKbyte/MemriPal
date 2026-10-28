# Covers: MEM-035
# Requirement: the deployed web app is installable (web manifest with served icons), registers no
# service worker (D13), and carries a hidden public-URL banner "live needs passcode / try Load demo".
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import pytest
from fastapi.testclient import TestClient

from memripal.app import create_app

REPO = Path(__file__).resolve().parents[1]
STATIC = REPO / "static"
INDEX = STATIC / "index.html"
# The app refuses non-loopback Host headers (MEM-015 host guard).
LOOPBACK_URL = "http://127.0.0.1"
BANNER_TEXT = "live needs passcode / try Load demo"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    monkeypatch.delenv("MEMRIPAL_MODE", raising=False)
    monkeypatch.delenv("META_API_KEY", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


@pytest.fixture
def client():
    return TestClient(create_app(), base_url=LOOPBACK_URL)


class _Page(HTMLParser):
    """Collects <link> attrs and the attrs + text of the element with id=public-banner."""

    def __init__(self):
        super().__init__()
        self.links: list[dict] = []
        self.banner_attrs: dict | None = None
        self.banner_text: list[str] = []
        self._depth = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "link":
            self.links.append(a)
        if self._depth:
            self._depth += 1
        elif a.get("id") == "public-banner":
            self.banner_attrs = a
            self._depth = 1

    def handle_endtag(self, tag):
        if self._depth:
            self._depth -= 1

    def handle_data(self, data):
        if self._depth:
            self.banner_text.append(data)


def _page() -> _Page:
    page = _Page()
    page.feed(INDEX.read_text(encoding="utf-8"))
    return page


def _manifest_path() -> str:
    hrefs = [ln.get("href") for ln in _page().links if "manifest" in (ln.get("rel") or "").split()]
    assert hrefs and hrefs[0], 'index.html has no <link rel="manifest" href=...>'
    return urlsplit(urljoin(LOOPBACK_URL + "/", hrefs[0])).path


def _content_type(resp) -> str:
    return resp.headers.get("content-type", "").split(";", 1)[0].strip().lower()


# Requirement: index.html links a web manifest that the server serves with a JSON content type.
def test_manifest_link_is_served_as_json(client):
    resp = client.get(_manifest_path())
    assert resp.status_code == 200, f"GET {_manifest_path()} -> {resp.status_code}"
    assert _content_type(resp) in {"application/manifest+json", "application/json"}, _content_type(resp)


# Requirement: the manifest makes the app installable standalone at "/" with icons that all resolve.
def test_manifest_fields_and_icons_served(client):
    path = _manifest_path()
    resp = client.get(path)
    assert resp.status_code == 200
    manifest = resp.json()
    assert manifest.get("name")
    assert manifest.get("short_name")
    assert manifest.get("start_url") == "/"
    assert manifest.get("display") == "standalone"
    icons = manifest.get("icons")
    assert isinstance(icons, list) and icons, "manifest has no icons"
    for icon in icons:
        src = urlsplit(urljoin(LOOPBACK_URL + path, icon["src"])).path
        assert client.get(src).status_code == 200, f"icon {icon['src']} not served"


# Requirement: no service worker is registered anywhere in the frontend (D13).
def test_no_service_worker_in_frontend():
    files = [p for p in STATIC.glob("*.js") if not p.name.endswith(".test.mjs")] + [INDEX]
    hits = [p.name for p in files if "serviceWorker" in p.read_text(encoding="utf-8")]
    assert not hits, f"serviceWorker referenced in: {hits}"


# Requirement: index.html carries a hidden public-URL banner telling visitors live needs a passcode.
def test_public_banner_present_and_hidden():
    page = _page()
    assert page.banner_attrs is not None, 'index.html has no element id="public-banner"'
    assert "hidden" in page.banner_attrs, "#public-banner is not hidden by default"
    text = " ".join("".join(page.banner_text).split())
    assert BANNER_TEXT in text, f"#public-banner text is {text!r}"
