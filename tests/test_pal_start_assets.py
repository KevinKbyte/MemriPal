# Covers: MEM-082
# Requirement: the start screen shows Pal, the corgi mascot. static/assets ships two Pal SVGs copied
# byte-for-byte from the pal-design source: pal-idle.svg blinks forever (SMIL <animate> with
# repeatCount="indefinite" on both upper lids #lidL and #lidR) and pal-still.svg is the same pose with
# no animation at all (no <animate>, no <set>), for prefers-reduced-motion. Both are served as SVG
# images. Every SVG under static/ is inert: no <script>, no <style> element, no style= attribute, no
# on*= event handler attribute, no <foreignObject>, and no external href (http:, https: or //);
# same-document href="#id" references stay allowed.
import hashlib
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from memripal.app import create_app

REPO = Path(__file__).resolve().parents[1]
STATIC = REPO / "static"
ASSETS = STATIC / "assets"
IDLE = ASSETS / "pal-idle.svg"
STILL = ASSETS / "pal-still.svg"
LOOPBACK_URL = "http://127.0.0.1"

# sha256 of dog-mascot pal-design public/pal/pal-idle.svg and pal-still.svg (LF line endings), so the
# copy is pinned byte-for-byte without reading across repos.
IDLE_SHA256 = "0d8124b4172a6873956ad540cf25d36b38afc2f6008971ff952ee6071b99cd7b"
STILL_SHA256 = "000bc5397efe5d6b1187247500850de97e87d11197727538f56d9e46022518d6"

# Inert-SVG lint: (label, pattern) pairs, case-insensitive.
FORBIDDEN = [
    ("<script", re.compile(r"<\s*script\b", re.I)),
    ("<style", re.compile(r"<\s*style\b", re.I)),
    ("style= attribute", re.compile(r"\sstyle\s*=", re.I)),
    ("on*= event handler", re.compile(r"\son[a-z]+\s*=", re.I)),
    ("foreignObject", re.compile(r"foreignObject", re.I)),
    ("external href", re.compile(r"""href\s*=\s*["']?\s*(?:https?:|//)""", re.I)),
]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    monkeypatch.delenv("MEMRIPAL_MODE", raising=False)
    monkeypatch.delenv("META_API_KEY", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


def _text(path: Path) -> str:
    assert path.is_file(), f"{path.relative_to(REPO).as_posix()} missing"
    return path.read_text(encoding="utf-8")


def _sha256_lf(path: Path) -> str:
    assert path.is_file(), f"{path.relative_to(REPO).as_posix()} missing"
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def _element(svg: str, element_id: str) -> str:
    """The element with id=element_id through its closing tag (the lid paths are not nested)."""
    m = re.search(rf'<(\w+)\b[^>]*\bid="{re.escape(element_id)}"[^>]*?(/?)>', svg)
    assert m, f'no element id="{element_id}"'
    if m.group(2) == "/":
        return m.group(0)
    end = svg.find(f"</{m.group(1)}>", m.end())
    assert end >= 0, f'id="{element_id}" is never closed'
    return svg[m.start() : end]


def _content_type(resp) -> str:
    return resp.headers.get("content-type", "").split(";", 1)[0].strip().lower()


# Covers: MEM-082
# Requirement: both Pal SVGs are byte-identical copies of the pal-design source files.
@pytest.mark.parametrize(
    ("path", "digest"), [(IDLE, IDLE_SHA256), (STILL, STILL_SHA256)], ids=["idle", "still"]
)
def test_pal_svg_is_byte_copy_of_design_source(path, digest):
    assert _sha256_lf(path) == digest, f"{path.name} differs from the pal-design source"


# Covers: MEM-082
# Requirement: pal-idle.svg blinks forever: each upper lid (#lidL, #lidR) carries an <animate> that
# repeats indefinitely.
@pytest.mark.parametrize("lid", ["lidL", "lidR"])
def test_idle_lids_blink_indefinitely(lid):
    body = _element(_text(IDLE), lid)
    animates = re.findall(r"<animate\b[^>]*>", body)
    assert animates, f"#{lid} has no <animate>"
    forever = [a for a in animates if 'repeatCount="indefinite"' in a]
    assert forever, f'#{lid} <animate> lacks repeatCount="indefinite"'


# Covers: MEM-082
# Requirement: pal-still.svg is Pal with no animation: no <animate> and no <set> anywhere, but the
# same lids are present.
def test_still_has_no_animation():
    svg = _text(STILL)
    assert not re.search(r"<\s*animate", svg, re.I), "pal-still.svg contains <animate"
    assert not re.search(r"<\s*set\b", svg, re.I), "pal-still.svg contains <set"
    for lid in ("lidL", "lidR"):
        _element(svg, lid)


# Covers: MEM-082
# Requirement: both Pal SVGs are served 200 as image/svg+xml.
@pytest.mark.parametrize("name", ["pal-idle.svg", "pal-still.svg"])
def test_pal_svg_served_as_svg(name):
    resp = TestClient(create_app(), base_url=LOOPBACK_URL).get(f"/static/assets/{name}")
    assert resp.status_code == 200, f"GET /static/assets/{name} -> {resp.status_code}"
    assert _content_type(resp) == "image/svg+xml", _content_type(resp)


def _static_svgs() -> list[Path]:
    return sorted(STATIC.rglob("*.svg"))


# Covers: MEM-082
# Requirement: the inert-SVG lint covers the two Pal SVGs (so it cannot pass vacuously).
def test_svg_lint_covers_pal_svgs():
    names = {p.relative_to(STATIC).as_posix() for p in _static_svgs()}
    assert {"assets/pal-idle.svg", "assets/pal-still.svg"} <= names, sorted(names)


# Covers: MEM-082
# Requirement: every SVG under static/ is inert: no script, no style element or attribute, no event
# handler attribute, no foreignObject, no external href.
@pytest.mark.parametrize("path", _static_svgs(), ids=lambda p: p.relative_to(STATIC).as_posix())
def test_static_svg_is_inert(path):
    svg = _text(path)
    hits = [label for label, pattern in FORBIDDEN if pattern.search(svg)]
    assert hits == [], f"{path.relative_to(STATIC).as_posix()} has {hits}"


# Covers: MEM-082
# Requirement: the lint rejects each forbidden construct and accepts a same-document href="#id".
@pytest.mark.parametrize(
    ("snippet", "label"),
    [
        ("<svg><script>alert(1)</script></svg>", "<script"),
        ("<svg><style>*{}</style></svg>", "<style"),
        ('<svg><rect style="fill:red"/></svg>', "style= attribute"),
        ('<svg><rect onclick="x()"/></svg>', "on*= event handler"),
        ('<svg onload="x()"></svg>', "on*= event handler"),
        ("<svg><foreignObject/></svg>", "foreignObject"),
        ('<svg><use href="https://evil.example/a.svg#x"/></svg>', "external href"),
        ('<svg><use xlink:href="http://evil.example/a.svg#x"/></svg>', "external href"),
        ('<svg><image href="//evil.example/a.png"/></svg>', "external href"),
    ],
)
def test_svg_lint_rejects(snippet, label):
    assert [lab for lab, pattern in FORBIDDEN if pattern.search(snippet)] == [label]


# Covers: MEM-082
# Requirement: same-document references (href="#id", url(#id)) are not external and stay allowed.
def test_svg_lint_allows_same_document_href():
    snippet = '<svg><clipPath id="c"><use href="#head-shape"/></clipPath><rect clip-path="url(#c)"/></svg>'
    assert [lab for lab, pattern in FORBIDDEN if pattern.search(snippet)] == []
