"""S3e place context: rounded coords -> the top nearby Wikipedia places (MEM-025, ADR 0022).

Best effort and private: any upstream failure answers an empty list, and coords never reach a log record.
"""

import hashlib
import json
import logging
import math
import threading
from collections import OrderedDict
from pathlib import Path
from urllib.parse import quote

import httpx

WIKI_HOST = "en.wikipedia.org"
GEOSEARCH_URL = f"https://{WIKI_HOST}/w/api.php"
SUMMARY_URL = f"https://{WIKI_HOST}/api/rest_v1/page/summary/"
# Wikimedia's User-Agent policy blocks or throttles default client agents.
USER_AGENT = "MemriPal/0.6 (memory palace study app; place lookup)"
TIMEOUT_S = 2.0
RADIUS_M = 500
TOP_N = 3
MAX_EXTRACT_CHARS = 400
CACHE_SIZE = 128

_log = logging.getLogger(__name__)


class _DropWikipediaRequestLog(logging.Filter):
    """httpx logs every request URL at INFO; a GeoSearch URL carries the coords, so drop those records."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args if isinstance(record.args, tuple) else ()
        return not any(isinstance(a, httpx.URL) and a.host == WIKI_HOST for a in args)


logging.getLogger("httpx").addFilter(_DropWikipediaRequestLog())


def valid_coords(lat: object, lon: object) -> bool:
    """Finite in-range numbers; bool is an int subclass, so it is refused explicitly."""
    for value, limit in ((lat, 90), (lon, 180)):
        if isinstance(value, bool) or not isinstance(value, int | float):
            return False
        if not math.isfinite(value) or not -limit <= value <= limit:
            return False
    return True


def _clip(text: str) -> str:
    return text if len(text) <= MAX_EXTRACT_CHARS else text[: MAX_EXTRACT_CHARS - 3].rstrip() + "..."


class PlaceProvider:
    """Wikipedia GeoSearch + REST page summaries behind an in-process LRU keyed by coords."""

    def __init__(self, transport: httpx.BaseTransport | None = None) -> None:
        headers = {"User-Agent": USER_AGENT}
        self._client = httpx.Client(transport=transport, timeout=TIMEOUT_S, headers=headers)
        self._cache: OrderedDict[tuple[float, float], list[dict]] = OrderedDict()
        self._lock = threading.Lock()

    def lookup(self, lat: float, lon: float) -> list[dict]:
        key = (lat, lon)
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        try:
            places = self._fetch(lat, lon)
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            # Type name only: an exception message can quote the request URL, which carries the coords.
            _log.warning("place lookup failed: %s", type(exc).__name__)
            return []
        # Only successes are cached, so a transient 429 is retried on the next pick.
        with self._lock:
            self._cache[key] = places
            while len(self._cache) > CACHE_SIZE:
                self._cache.popitem(last=False)
        return places

    def _fetch(self, lat: float, lon: float) -> list[dict]:
        params = {
            "action": "query",
            "list": "geosearch",
            "gscoord": f"{lat}|{lon}",
            "gsradius": str(RADIUS_M),
            "gslimit": str(TOP_N),
            "format": "json",
        }
        resp = self._client.get(GEOSEARCH_URL, params=params)
        resp.raise_for_status()
        places = []
        for hit in resp.json()["query"]["geosearch"][:TOP_N]:
            title = str(hit["title"])
            summary = self._client.get(SUMMARY_URL + quote(title.replace(" ", "_"), safe=""))
            summary.raise_for_status()
            extract = str(summary.json()["extract"])
            distance_m = round(float(hit["dist"]))
            places.append({"title": title, "distance_m": distance_m, "extract": _clip(extract)})
        return places


def replay_path(root: Path, lat: float, lon: float) -> Path:
    """Replay file for one coords pair, hashed so the name is fixed-shape."""
    digest = hashlib.sha256(f"{lat}|{lon}".encode("ascii")).hexdigest()
    return Path(root) / "place" / f"{digest}.json"


class FixturePlaceProvider:
    """Fixture mode: replays recorded /place answers (MEM-025 demo); never touches the network."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def lookup(self, lat: float, lon: float) -> list[dict]:
        path = replay_path(self.root, lat, lon)
        return json.loads(path.read_bytes())["places"] if path.is_file() else []
