# Covers: MEM-040
# Requirement: the generated assets are wired into the page. The web manifest lists the PNG install
# icons (192 and 512, each declaring its real pixel size) after the existing SVG icon, every icon and
# the empty-state picture are served as images, index.html shows one decorative empty-state picture
# directly above the photo canvas, and its style can never override the hidden attribute. MEM-082
# supersedes MEM-040's empty-state.webp picture: the empty state is now Pal, /static/assets/pal-idle.svg
# (served as SVG; the Pal files themselves are pinned in tests/test_pal_start_assets.py). MEM-044 P1
# links the painterly theme last; it is served as CSS and can never override hidden either.
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from memripal.app import create_app

REPO = Path(__file__).resolve().parents[1]
STATIC = REPO / "static"
INDEX = STATIC / "index.html"
MANIFEST = STATIC / "manifest.webmanifest"
STYLE = STATIC / "style.css"
# The app refuses non-loopback Host headers (MEM-015 host guard).
LOOPBACK_URL = "http://127.0.0.1"
# MEM-082 supersedes the MEM-040 pin "/static/assets/empty-state.webp": the start screen shows Pal.
EMPTY_STATE_SRC = "/static/assets/pal-idle.svg"

SVG_ICON = {"src": "/static/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"}
PNG_ICONS = [
    {"src": "/static/assets/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
    {"src": "/static/assets/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
]
THEME = STATIC / "theme-painterly.css"
THEME_SRC = "/static/theme-painterly.css"
# The <link> tags of index.html: the 3 MEM-040 links (the asset wiring added none), the MEM-095 tour
# stylesheet, then the MEM-044 P1 painterly theme as the LAST rel=stylesheet, so it cascades over both.
LINKS = [
    {"rel": "stylesheet", "href": "/static/style.css"},
    {"rel": "manifest", "href": "/static/manifest.webmanifest"},
    {"rel": "icon", "href": "/static/icon.svg", "type": "image/svg+xml"},
    {"rel": "stylesheet", "href": "/static/tour.css"},
    {"rel": "stylesheet", "href": THEME_SRC},
]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    monkeypatch.delenv("MEMRIPAL_MODE", raising=False)
    monkeypatch.delenv("META_API_KEY", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


@pytest.fixture
def client():
    return TestClient(create_app(), base_url=LOOPBACK_URL)


def _manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def _icon_path(src: str) -> str:
    return urlsplit(urljoin(LOOPBACK_URL + "/static/manifest.webmanifest", src)).path


def _content_type(resp) -> str:
    return resp.headers.get("content-type", "").split(";", 1)[0].strip().lower()


class _Events(HTMLParser):
    """Start/end tag events in document order; a void or self-closed tag is one start event."""

    def __init__(self):
        super().__init__()
        self.events: list[tuple[str, str, dict]] = []

    def handle_starttag(self, tag, attrs):
        self.events.append(("start", tag, dict(attrs)))

    def handle_startendtag(self, tag, attrs):
        self.events.append(("start", tag, dict(attrs)))

    def handle_endtag(self, tag):
        self.events.append(("end", tag, {}))


def _events() -> list[tuple[str, str, dict]]:
    parser = _Events()
    parser.feed(INDEX.read_text(encoding="utf-8"))
    return parser.events


def _empty_state_index(events) -> int:
    hits = [i for i, (kind, _, a) in enumerate(events) if kind == "start" and a.get("id") == "empty-state"]
    assert len(hits) == 1, f'index.html must contain exactly one element id="empty-state", found {len(hits)}'
    return hits[0]


def _css_rules(sheet: Path = STYLE) -> list[tuple[str, str]]:
    """(selector, body) pairs of a stylesheet (style.css by default), comments stripped; innermost blocks."""
    css = re.sub(r"/\*.*?\*/", "", sheet.read_text(encoding="utf-8"), flags=re.S)
    return [(" ".join(sel.split()), body) for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css)]


def _decls(body: str) -> dict[str, str]:
    out = {}
    for part in body.split(";"):
        if ":" in part:
            key, value = part.split(":", 1)
            out[key.strip().lower()] = " ".join(value.split()).lower()
    return out


def _empty_state_rules() -> list[tuple[str, str]]:
    return [(sel, body) for sel, body in _css_rules() if "#empty-state" in sel]


# Covers: MEM-040
# Requirement: the manifest keeps the SVG icon first, then lists the 192 and 512 PNG install icons.
def test_manifest_icons_are_svg_then_png_192_then_png_512():
    assert _manifest().get("icons") == [SVG_ICON, *PNG_ICONS]


# Covers: MEM-040
# Requirement: each PNG icon's declared sizes equals the real pixel size of the committed file.
@pytest.mark.parametrize("expected", PNG_ICONS, ids=lambda i: i["sizes"])
def test_png_icon_sizes_match_real_pixels(expected):
    icons = {i.get("src"): i for i in _manifest().get("icons", [])}
    assert expected["src"] in icons, f"manifest has no icon {expected['src']}"
    declared = icons[expected["src"]]
    assert declared.get("type") == "image/png"
    file = STATIC / _icon_path(declared["src"]).removeprefix("/static/")
    assert file.is_file(), f"{file} missing"
    with Image.open(file) as img:
        assert img.format == "PNG", f"{file.name} is {img.format}, not PNG"
        assert declared.get("sizes") == f"{img.width}x{img.height}"


# Covers: MEM-040
# Requirement: every manifest icon is served 200 as an image (tests/test_deploy_web.py rule).
def test_every_manifest_icon_served_as_image(client):
    icons = _manifest().get("icons", [])
    assert [i.get("src") for i in icons][1:] == [i["src"] for i in PNG_ICONS], "PNG icons not wired"
    for icon in icons:
        resp = client.get(_icon_path(icon["src"]))
        assert resp.status_code == 200, f"icon {icon['src']} -> {resp.status_code}"
        assert _content_type(resp).startswith("image/"), f"icon {icon['src']} served as {_content_type(resp)}"
        assert _content_type(resp) == icon["type"], (
            f"icon {icon['src']} type {icon['type']} vs served {_content_type(resp)}"
        )


# Covers: MEM-040, MEM-082
# Requirement: the empty-state picture is served 200 as an SVG image. MEM-082 supersedes the MEM-040
# pin that it is a WebP (empty-state.webp, RIFF/WEBP body): it is now Pal, pal-idle.svg.
def test_empty_state_picture_served_as_svg(client):
    resp = client.get(EMPTY_STATE_SRC)
    assert resp.status_code == 200, f"GET {EMPTY_STATE_SRC} -> {resp.status_code}"
    assert _content_type(resp) == "image/svg+xml", _content_type(resp)
    assert b"<svg" in resp.content[:200], "body is not an SVG document"


# Covers: MEM-040, MEM-082
# Requirement: index.html has one decorative empty-state <img> (empty alt, src the Pal idle SVG; MEM-082
# supersedes MEM-040's WebP src), shown on load (no hidden attribute).
def test_index_has_one_decorative_empty_state_img():
    events = _events()
    _, tag, attrs = events[_empty_state_index(events)]
    assert tag == "img", f"#empty-state is <{tag}>, not <img>"
    assert attrs.get("src") == EMPTY_STATE_SRC
    assert "alt" in attrs, "#empty-state has no alt attribute"
    assert attrs["alt"] in ("", None), f'#empty-state alt is {attrs["alt"]!r}, not ""'
    assert "hidden" not in attrs, "#empty-state must be visible on page load"


# Covers: MEM-040, MEM-114
# Requirement: the empty-state picture is followed by the MEM-114 slogan <p id="empty-slogan"> (text only,
# no nested tags) and then #scene-wrap, with nothing else between. MEM-114 amends MEM-040's pin that
# #scene-wrap was the tag right after the picture.
def test_empty_state_then_slogan_then_scene_wrap():
    events = _events()
    at = _empty_state_index(events)
    assert at + 3 < len(events), "index.html ends before #empty-state, slogan and #scene-wrap"
    kind, tag, attrs = events[at + 1]
    assert (kind, tag, attrs.get("id")) == ("start", "p", "empty-slogan"), (
        f"the tag right after #empty-state is {kind} <{tag}> id={attrs.get('id')!r}, not <p id=empty-slogan>"
    )
    after = events[at + 2][:2]
    assert after == ("end", "p"), f"#empty-slogan is not closed by </p> before {after}"
    kind, tag, attrs = events[at + 3]
    assert (kind, attrs.get("id")) == ("start", "scene-wrap"), (
        f"the tag after #empty-slogan is {kind} <{tag}> id={attrs.get('id')!r}, not #scene-wrap"
    )
    html = INDEX.read_text(encoding="utf-8")
    slogan = re.search(r'<p\b[^>]*\bid="empty-slogan"[^>]*>(.*?)</p>', html, re.S)
    assert slogan and slogan.group(1).strip(), "#empty-slogan has no text"


# Covers: MEM-040, MEM-044
# Requirement: index.html's <link> tags are the 3 MEM-040 links then the MEM-044 P1 painterly theme,
# which is the last rel=stylesheet link.
def test_index_links_end_with_painterly_theme():
    links = [a for kind, tag, a in _events() if kind == "start" and tag == "link"]
    assert links == LINKS
    sheets = [a.get("href") for a in links if a.get("rel") == "stylesheet"]
    assert sheets[-1:] == [THEME_SRC], f"last stylesheet is {sheets[-1:]}, not {THEME_SRC}"


APP_JS_SRC = "/static/app.js"
PAL_BUBBLE_SRC = "/static/pal_bubble.js"


# Covers: MEM-099
# Requirement: the Pal chat bubble is on every screen: index.html loads static/pal_bubble.js (which
# self-mounts and links its own stylesheet) with exactly one <script type="module"> placed after the
# /static/app.js module script; that one line is the only index.html edit MEM-099 makes.
def test_index_loads_pal_bubble_module_once_after_app_js():
    scripts = [a for kind, tag, a in _events() if kind == "start" and tag == "script"]
    srcs = [a.get("src") for a in scripts]
    bubble = [i for i, s in enumerate(srcs) if s == PAL_BUBBLE_SRC]
    assert len(bubble) == 1, f"index.html needs exactly one <script src={PAL_BUBBLE_SRC}>, scripts: {srcs}"
    tag = scripts[bubble[0]]
    assert tag.get("type") == "module", f"{PAL_BUBBLE_SRC} script is {tag}, not type=module"
    app = [i for i, s in enumerate(srcs) if s == APP_JS_SRC]
    assert len(app) == 1, f"index.html must keep exactly one <script src={APP_JS_SRC}>, scripts are {srcs}"
    assert bubble[0] > app[0], f"{PAL_BUBBLE_SRC} must come after {APP_JS_SRC}: {srcs}"


# Covers: MEM-044
# Requirement: the painterly theme stylesheet is served 200 as text/css.
def test_painterly_theme_served_as_css(client):
    resp = client.get(THEME_SRC)
    assert resp.status_code == 200, f"GET {THEME_SRC} -> {resp.status_code}"
    assert _content_type(resp) == "text/css", _content_type(resp)


# Covers: MEM-040
# Requirement: #empty-state is a centered block at most min(100%, 360px) wide with auto height.
def test_empty_state_css_is_centered_capped_block():
    rules = [_decls(body) for sel, body in _empty_state_rules() if sel == "#empty-state"]
    assert rules, "style.css has no #empty-state rule"
    decls = {k: v for d in rules for k, v in d.items()}
    assert decls.get("display") == "block", decls
    assert decls.get("max-width") == "min(100%, 360px)", decls
    assert decls.get("height") == "auto", decls
    margin = decls.get("margin", "").split()
    centered = (
        (len(margin) in (2, 3) and margin[1] == "auto")
        or margin == ["auto"]
        or (len(margin) == 4 and margin[1] == margin[3] == "auto")
        or decls.get("margin-inline") == "auto"
        or (decls.get("margin-left") == "auto" and decls.get("margin-right") == "auto")
    )
    assert centered, f"#empty-state is not horizontally centered by auto margins: {decls}"


# Covers: MEM-040
# Requirement: hidden always wins: no #empty-state rule uses !important, and the global
# `[hidden] { display: none !important; }` rule is kept, so a hidden #empty-state is display:none.
def test_hidden_wins_over_empty_state_display():
    rules = _empty_state_rules()
    assert rules, "style.css has no #empty-state rule"
    for sel, body in rules:
        assert "!important" not in body, f"{sel} uses !important"
        if "[hidden]" in sel:
            assert _decls(body).get("display", "none") == "none", f"{sel} shows a hidden #empty-state"
    hidden = [_decls(body) for sel, body in _css_rules() if sel == "[hidden]"]
    assert hidden, "style.css lost the global [hidden] rule"
    assert {"display": "none !important"} in hidden, f"[hidden] rule is {hidden}"


# Covers: MEM-044
# Requirement: hidden still wins with the MEM-044 P1 painterly theme linked after style.css: the theme
# uses no !important, so nothing it sets can beat `[hidden] { display: none !important; }`, and none of
# its [hidden] rules shows a hidden element.
def test_hidden_wins_over_painterly_theme():
    assert THEME.is_file(), f"{THEME} missing"
    rules = _css_rules(THEME)
    assert rules, f"{THEME.name} has no rules"
    for sel, body in rules:
        assert "!important" not in body, f"{THEME.name} {sel} uses !important"
        if "[hidden]" in sel:
            assert _decls(body).get("display", "none") == "none", f"{THEME.name} {sel} shows a hidden element"
    assert {"display": "none !important"} in [_decls(b) for s, b in _css_rules() if s == "[hidden]"]
