"""Mapillary street-photo baseline for one station, fetched server-side (MEM-053).

The client token rides only in the Authorization header (never a URL, never to the CDN); coords leave at
<= 4 dp and never reach a log record; the thumb is fetched https-only from the Mapillary CDN without
following redirects, byte-capped and re-encoded so no EXIF survives.
"""

import base64
import hashlib
import json
import logging
import math
from pathlib import Path
from urllib.parse import quote

import httpx

from memripal.imaging import ImageRejected, process_upload

TOKEN_ENV = "MEMRIPAL_MAPILLARY_TOKEN"
GRAPH_HOST = "graph.mapillary.com"
GRAPH_IMAGES_URL = f"https://{GRAPH_HOST}/images"
IMAGE_PAGE_URL = "https://www.mapillary.com/app/?pKey="
# Mapillary serves thumbs from Meta's CDN; the leading dot stops "evilfbcdn.net" matching.
CDN_HOST_SUFFIXES = (".fbcdn.net",)
# Mapillary has no per-image licence field: all its imagery is CC BY-SA 4.0.
LICENCE = "CC BY-SA 4.0"
RADIUS_M = 30
SEARCH_LIMIT = 20
MAX_IMAGE_BYTES = 2 * 1024 * 1024
TIMEOUT_S = 5.0
FIELDS = "id,thumb_1024_url,computed_geometry,geometry,creator,compass_angle,captured_at"
# Candidates offered to the client's picker (MEM-146); each costs one CDN fetch.
MAX_CANDIDATES = 4
EARTH_RADIUS_M = 6_371_008.8
JPEG_DATA_URL = "data:image/jpeg;base64,"
LEGACY_KEYS = ("image", "author", "image_url", "licence")
_FAILURES = (httpx.HTTPError, httpx.InvalidURL, ValueError, KeyError, TypeError)

_log = logging.getLogger(__name__)


class NoBaseline(Exception):
    """No usable image near the coords (route: 404 no_baseline)."""


class BaselineFailed(Exception):
    """Upstream or guard failure (route: 502 upstream)."""


class _DropGraphRequestLog(logging.Filter):
    """httpx logs every request URL at INFO; a Graph search URL carries the coords, so drop those records."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args if isinstance(record.args, tuple) else ()
        return not any(isinstance(a, httpx.URL) and a.host == GRAPH_HOST for a in args)


logging.getLogger("httpx").addFilter(_DropGraphRequestLog())


def _point(rec: dict) -> tuple[float, float] | None:
    """(lat, lon) of an image record, computed geometry preferred; None when malformed."""
    geom = rec.get("computed_geometry") or rec.get("geometry")
    pt = geom.get("coordinates") if isinstance(geom, dict) else None
    if not isinstance(pt, list) or len(pt) != 2:
        return None
    if any(isinstance(v, bool) or not isinstance(v, int | float) for v in pt):
        return None
    return float(pt[1]), float(pt[0])


def _distance_m(lat: float, lon: float, other: tuple[float, float]) -> float:
    # Equirectangular is exact enough at a 30 m radius.
    dy = math.radians(other[0] - lat)
    dx = math.radians(other[1] - lon) * math.cos(math.radians(lat))
    return EARTH_RADIUS_M * math.hypot(dx, dy)


def _author(rec: dict) -> str | None:
    """Contributor username, or None when blank: CC BY-SA needs a named creator in the credit block."""
    creator = rec.get("creator")
    name = creator.get("username") if isinstance(creator, dict) else None
    return name if isinstance(name, str) and name.strip() else None


def _number(value: object) -> float | int | None:
    return value if isinstance(value, int | float) and not isinstance(value, bool) else None


def _nearby(lat: float, lon: float, data: list) -> list[tuple[dict, tuple[float, float]]]:
    """Credited, well-formed records within RADIUS_M with their points, nearest first."""
    found = []
    for rec in data:
        if not isinstance(rec, dict) or not isinstance(rec.get("thumb_1024_url"), str):
            continue
        if _author(rec) is None:
            continue
        point = _point(rec)
        if point is None:
            continue
        d = _distance_m(lat, lon, point)
        if d <= RADIUS_M:
            found.append((d, rec, point))
    if not found:
        raise NoBaseline()
    found.sort(key=lambda item: item[0])
    return [(rec, point) for _, rec, point in found]


def _allowed_thumb(url: str) -> httpx.URL:
    parsed = httpx.URL(url)
    if parsed.scheme != "https" or not parsed.host.endswith(CDN_HOST_SUFFIXES):
        raise BaselineFailed()
    return parsed


class BaselineProvider:
    """Live mode: Graph API image search, then one guarded CDN thumb fetch."""

    def __init__(self, token: str, transport: httpx.BaseTransport | None = None) -> None:
        auth = {"Authorization": f"OAuth {token}"}
        self._graph = httpx.Client(transport=transport, timeout=TIMEOUT_S, headers=auth)
        # A separate client so the token can never ride along to the CDN.
        self._cdn = httpx.Client(transport=transport, timeout=TIMEOUT_S, follow_redirects=False)

    def lookup(self, lat: float, lon: float) -> dict:
        lat, lon = round(lat, 4), round(lon, 4)
        try:
            nearby = _nearby(lat, lon, self._search(lat, lon))
        except _FAILURES as exc:
            # Type name only: an exception message can quote the request URL, which carries the coords.
            _log.warning("baseline lookup failed: %s", type(exc).__name__)
            raise BaselineFailed() from exc
        candidates: list[dict] = []
        for rec, point in nearby:
            if len(candidates) == MAX_CANDIDATES:
                break
            try:
                candidates.append(self._candidate(rec, point))
            except (BaselineFailed, *_FAILURES) as exc:
                # One broken thumb must not sink the pull; only all of them failing does.
                _log.warning("baseline candidate skipped: %s", type(exc).__name__)
        if not candidates:
            raise BaselineFailed()
        first = candidates[0]
        return {**{key: first[key] for key in LEGACY_KEYS}, "candidates": candidates}

    def _candidate(self, rec: dict, point: tuple[float, float]) -> dict:
        jpeg = self._thumb(_allowed_thumb(rec["thumb_1024_url"]))
        captured = rec.get("captured_at")
        return {
            "image": JPEG_DATA_URL + base64.b64encode(jpeg).decode("ascii"),
            "author": _author(rec),
            "image_url": IMAGE_PAGE_URL + quote(str(rec["id"]), safe=""),
            "licence": LICENCE,
            "lat": point[0],
            "lon": point[1],
            "compass_angle": _number(rec.get("compass_angle")),
            "captured_at": captured if isinstance(captured, int) and not isinstance(captured, bool) else None,
        }

    def _search(self, lat: float, lon: float) -> list:
        params = {
            "fields": FIELDS,
            "lat": f"{lat:.4f}",
            "lng": f"{lon:.4f}",
            "radius": str(RADIUS_M),
            "limit": str(SEARCH_LIMIT),
        }
        resp = self._graph.get(GRAPH_IMAGES_URL, params=params)
        if resp.status_code != 200:
            _log.warning("baseline search failed: status %d", resp.status_code)
            raise BaselineFailed()
        data = resp.json()["data"]
        if not isinstance(data, list):
            raise BaselineFailed()
        return data

    def _thumb(self, url: httpx.URL) -> bytes:
        with self._cdn.stream("GET", url) as resp:
            # Any 3xx is a failure: following it could leave the allowlisted host.
            if resp.status_code != 200:
                raise BaselineFailed()
            body = bytearray()
            for chunk in resp.iter_bytes():
                body += chunk
                if len(body) > MAX_IMAGE_BYTES:
                    raise BaselineFailed()
        try:
            return process_upload(bytes(body)).jpeg
        except ImageRejected as exc:
            raise BaselineFailed() from exc


def replay_path(root: Path, lat: float, lon: float) -> Path:
    """Replay file for one coords pair, hashed so the name is fixed-shape."""
    digest = hashlib.sha256(f"{lat}|{lon}".encode("ascii")).hexdigest()
    return Path(root) / "baseline" / f"{digest}.json"


class FixtureBaselineProvider:
    """Fixture mode: replays recorded /baseline answers; never touches the network."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def lookup(self, lat: float, lon: float) -> dict:
        path = replay_path(self.root, lat, lon)
        if not path.is_file():
            raise NoBaseline()
        answer = json.loads(path.read_bytes())
        if not _valid_answer(answer):
            raise NoBaseline()
        return answer


def _valid_answer(answer: object) -> bool:
    """A replay must carry the full CC BY-SA credit, same shape as a live answer, or it is not replayed."""
    if not isinstance(answer, dict) or set(answer) != {"image", "author", "image_url", "licence"}:
        return False
    image, author, url = answer["image"], answer["author"], answer["image_url"]
    return (
        isinstance(image, str)
        and image.startswith(JPEG_DATA_URL)
        and isinstance(author, str)
        and bool(author.strip())
        and isinstance(url, str)
        and url.startswith(IMAGE_PAGE_URL)
        and len(url) > len(IMAGE_PAGE_URL)
        and answer["licence"] == LICENCE
    )
