"""Build the offline Kendall walk graph + named-POI table from ONE Overpass query (MEM-084, ADR 0046, 0053).

Usage: uv run python scripts/build_walk_graph.py [--graph-out PATH] [--pois-out PATH]
Writes static/data/kendall_walk_graph.json ({"nodes": [[lat, lng]], "edges": [[i, j, length_m]]}, walkable
highway ways only, undirected) and static/data/kendall_pois.json (named nodes with street addresses).
Public Overpass intermittently answers 502/504, so the single POST is retried.
"""

import argparse
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
GRAPH_PATH = REPO_ROOT / "static" / "data" / "kendall_walk_graph.json"
POIS_PATH = REPO_ROOT / "static" / "data" / "kendall_pois.json"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# Kendall/MIT T to 100 Binney St with a few hundred metres of margin: (south, west, north, east).
BBOX = (42.3580, -71.0930, 42.3700, -71.0750)
QUERY = """[out:json][timeout:120];
(
  way["highway"]({s},{w},{n},{e});
  way["building"]["addr:housenumber"]({s},{w},{n},{e});
  node["name"]({s},{w},{n},{e});
);
(._;>;);
out body qt;
""".format(s=BBOX[0], w=BBOX[1], n=BBOX[2], e=BBOX[3])

# highway values that are not walkable (or not yet real ways).
EXCLUDED_HIGHWAYS = {"motorway", "motorway_link", "construction", "proposed"}
EARTH_RADIUS_M = 6371008.8
DP = 5


def _haversine_m(a, b):
    lat1, lng1 = map(math.radians, a)
    lat2, lng2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def _walkable(tags):
    return "highway" in tags and tags["highway"] not in EXCLUDED_HIGHWAYS and tags.get("foot") != "no"


def _build_graph(ways, coords):
    # Keyed by the rounded coord, not the OSM id: two OSM nodes equal at 5 dp would be duplicate vertices.
    index = {}
    nodes = []
    edges = {}
    for way in ways:
        if not _walkable(way.get("tags", {})):
            continue
        ids = [i for i in way["nodes"] if i in coords]
        for a, b in zip(ids, ids[1:], strict=False):
            ends = []
            for node_id in (a, b):
                point = coords[node_id]
                if point not in index:
                    index[point] = len(nodes)
                    nodes.append(list(point))
                ends.append(index[point])
            i, j = sorted(ends)
            if i != j:
                edges[(i, j)] = round(_haversine_m(nodes[i], nodes[j]), 1)
    return {"nodes": nodes, "edges": [[i, j, length] for (i, j), length in edges.items()]}


def _inside(point, ring):
    """Even-odd ray cast of (lat, lng) against a closed ring of (lat, lng)."""
    lat, lng = point
    hit = False
    for (lat1, lng1), (lat2, lng2) in zip(ring, ring[1:], strict=False):
        if (lng1 > lng) != (lng2 > lng) and lat < lat1 + (lng - lng1) * (lat2 - lat1) / (lng2 - lng1):
            hit = not hit
    return hit


def _addressed_buildings(ways, raw):
    buildings = []
    for way in ways:
        tags = way.get("tags", {})
        if "building" not in tags or not (tags.get("addr:housenumber") and tags.get("addr:street")):
            continue
        ring = [raw[i] for i in way["nodes"] if i in raw]
        if len(ring) >= 4 and ring[0] == ring[-1]:
            lats, lngs = zip(*ring, strict=True)
            box = (min(lats), min(lngs), max(lats), max(lngs))
            buildings.append((box, ring, tags["addr:housenumber"], tags["addr:street"]))
    return buildings


def _address(tags, point, buildings):
    """(address, street): own full address, else the enclosing building's, else (None, own street or None)."""
    if tags.get("addr:housenumber") and tags.get("addr:street"):
        return f"{tags['addr:housenumber']} {tags['addr:street']}", tags["addr:street"]
    lat, lng = point
    for (s, w, n, e), ring, number, street in buildings:
        if s <= lat <= n and w <= lng <= e and _inside(point, ring):
            return f"{number} {street}", street
    return None, tags.get("addr:street")


def build(overpass_json):
    """Pure: an Overpass JSON response -> (graph, pois)."""
    elements = overpass_json["elements"]
    node_elements = [e for e in elements if e["type"] == "node"]
    ways = [e for e in elements if e["type"] == "way"]
    raw = {e["id"]: (e["lat"], e["lon"]) for e in node_elements}
    coords = {i: (round(lat, DP), round(lng, DP)) for i, (lat, lng) in raw.items()}
    graph = _build_graph(ways, coords)
    buildings = _addressed_buildings(ways, raw)
    pois = []
    for e in node_elements:
        tags = e.get("tags", {})
        if not tags.get("name"):
            continue
        address, street = _address(tags, raw[e["id"]], buildings)
        lat, lng = coords[e["id"]]
        pois.append(
            {
                "osm_id": f"node/{e['id']}",
                "name": tags["name"],
                "lat": lat,
                "lng": lng,
                "address": address,
                "street": street,
            }
        )
    return graph, pois


def urllib_http(url, data):
    """POST data to url, return the body; HTTP and network errors raise OSError subclasses."""
    request = urllib.request.Request(url, data=data, headers={"User-Agent": "memripal-build-walk-graph/1"})
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


def fetch(http, attempts=4, sleep=time.sleep):
    """ONE Overpass POST through http(url, data) -> bytes, retried on OSError; re-raises after `attempts`."""
    data = urllib.parse.urlencode({"data": QUERY}).encode("utf-8")
    for attempt in range(1, attempts + 1):
        try:
            return json.loads(http(OVERPASS_URL, data))
        except OSError:
            if attempt == attempts:
                raise
            sleep(10 * attempt)


def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")


def main(argv=None, http=urllib_http):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--graph-out", type=Path, default=GRAPH_PATH)
    parser.add_argument("--pois-out", type=Path, default=POIS_PATH)
    args = parser.parse_args(argv)
    graph, pois = build(fetch(http))
    _write(args.graph_out, graph)
    _write(args.pois_out, pois)
    print(f"wrote {args.graph_out} ({len(graph['nodes'])} nodes, {len(graph['edges'])} edges)")
    print(f"wrote {args.pois_out} ({len(pois)} POIs)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
