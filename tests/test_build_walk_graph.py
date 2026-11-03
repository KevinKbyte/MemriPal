# Covers: MEM-084
# Requirement: scripts/build_walk_graph.py turns ONE Overpass bbox response into the committed offline
# walk graph + named-POI table (ADR 0046, 0053). Pure build(overpass_json) -> (graph, pois):
# graph = {"nodes": [[lat, lng], ...], "edges": [[i, j, length_m], ...]} built from walkable highway ways
# only (motorway and foot=no excluded; non-highway ways such as buildings never routable), one shared
# node per OSM node so ways join at junctions, each way segment once (undirected), coords at 5 dp,
# length_m the haversine metres between the segment ends. pois = [{"osm_id": "node/<id>", "name", "lat",
# "lng", "address", "street"}] for named nodes only (unnamed dropped, named streets are not POIs), 5 dp;
# address = "<addr:housenumber> <addr:street>" from the node's own tags, else from the building way that
# encloses it, else null; street = the addr:street that supplied it, or the node's own addr:street, or
# null. fetch(http, attempts=N, sleep=...) POSTs once to OVERPASS_URL through the injectable
# http(url, data: bytes) -> body bytes, retries a raised OSError, and re-raises after N failed attempts.
# main(argv, http=...) fetches, builds and writes GRAPH_PATH (static/data/kendall_walk_graph.json) and
# POIS_PATH (static/data/kendall_pois.json), overridable with --graph-out / --pois-out; returns 0.
import importlib.util
import json
import math
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "build_walk_graph.py"
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "overpass_walk_small.json"

WALKABLE_NODE_IDS = {1, 2, 3, 4, 5, 6}
WALKABLE_SEGMENTS = {(1, 2), (2, 3), (2, 4), (4, 5), (5, 6)}
NON_WALKABLE_NODE_IDS = {20, 21, 22, 23, 30, 31, 32, 33}
EARTH_RADIUS_M = 6371008.8


def _load():
    assert SCRIPT.exists(), f"missing {SCRIPT.relative_to(REPO_ROOT)}"
    spec = importlib.util.spec_from_file_location("build_walk_graph_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _nodes_by_id():
    return {e["id"]: (e["lat"], e["lon"]) for e in _fixture()["elements"] if e["type"] == "node"}


def _haversine_m(a, b):
    lat1, lng1 = map(math.radians, a)
    lat2, lng2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def _r5(pair):
    return (round(pair[0], 5), round(pair[1], 5))


@pytest.fixture
def mod():
    return _load()


@pytest.fixture
def built(mod):
    return mod.build(_fixture())


def _pois_by_id(pois):
    return {p["osm_id"]: p for p in pois}


def _edge_pairs(graph):
    """Unordered pairs of 5-dp node coords for every edge."""
    nodes = [tuple(n) for n in graph["nodes"]]
    return [frozenset((nodes[i], nodes[j])) for i, j, _ in graph["edges"]]


class TestGraphShape:
    def test_graph_has_nodes_and_edges_lists(self, built):
        graph, _ = built
        assert set(graph) == {"nodes", "edges"}
        assert all(len(n) == 2 for n in graph["nodes"])
        assert all(len(e) == 3 for e in graph["edges"])

    def test_nodes_are_exactly_the_walkable_way_nodes_at_5dp(self, built):
        graph, _ = built
        by_id = _nodes_by_id()
        expected = {_r5(by_id[i]) for i in WALKABLE_NODE_IDS}
        got = [tuple(n) for n in graph["nodes"]]
        assert len(got) == len(set(got)), "a shared OSM node must appear once (junctions join ways)"
        assert set(got) == expected

    def test_node_coords_are_rounded_to_5dp(self, built):
        graph, _ = built
        for lat, lng in graph["nodes"]:
            assert lat == round(lat, 5)
            assert lng == round(lng, 5)

    def test_each_way_segment_is_one_undirected_edge(self, built):
        graph, _ = built
        by_id = _nodes_by_id()
        n = len(graph["nodes"])
        for i, j, _ in graph["edges"]:
            assert 0 <= i < n and 0 <= j < n and i != j
        pairs = _edge_pairs(graph)
        assert len(pairs) == len(set(pairs)), "edges are undirected: no segment stored twice"
        expected = {frozenset((_r5(by_id[a]), _r5(by_id[b]))) for a, b in WALKABLE_SEGMENTS}
        assert set(pairs) == expected

    def test_edge_length_is_haversine_metres(self, built):
        graph, _ = built
        nodes = graph["nodes"]
        for i, j, length_m in graph["edges"]:
            assert length_m == pytest.approx(_haversine_m(nodes[i], nodes[j]), abs=0.6)
            assert length_m > 0

    def test_non_walkable_ways_are_excluded(self, built):
        graph, _ = built
        by_id = _nodes_by_id()
        coords = {tuple(n) for n in graph["nodes"]}
        for node_id in NON_WALKABLE_NODE_IDS:
            assert _r5(by_id[node_id]) not in coords, f"node {node_id} is on a non-walkable way"

    def test_poi_nodes_are_not_graph_nodes(self, built):
        graph, pois = built
        coords = {tuple(n) for n in graph["nodes"]}
        for poi in pois:
            assert (poi["lat"], poi["lng"]) not in coords


class TestPois:
    def test_only_named_nodes_become_pois(self, built):
        _, pois = built
        assert set(_pois_by_id(pois)) == {"node/40", "node/41", "node/43", "node/44"}

    def test_unnamed_node_is_dropped(self, built):
        _, pois = built
        assert "node/42" not in _pois_by_id(pois)
        assert all(p["name"] for p in pois)

    def test_named_street_way_is_not_a_poi(self, built):
        _, pois = built
        assert not any(p["osm_id"].startswith("way/") for p in pois)

    def test_poi_record_shape_and_5dp_coords(self, built):
        _, pois = built
        by_id = _nodes_by_id()
        for poi in pois:
            assert set(poi) == {"osm_id", "name", "lat", "lng", "address", "street"}
            node_id = int(poi["osm_id"].split("/")[1])
            assert (poi["lat"], poi["lng"]) == _r5(by_id[node_id])

    def test_own_addr_tags_give_address_and_street(self, built):
        _, pois = built
        station = _pois_by_id(pois)["node/40"]
        assert station["name"] == "Kendall/MIT"
        assert station["address"] == "300 Main Street"
        assert station["street"] == "Main Street"

    def test_address_inherited_from_enclosing_building(self, built):
        _, pois = built
        cafe = _pois_by_id(pois)["node/41"]
        assert cafe["name"] == "Cafe Inside"
        assert cafe["address"] == "285 Third Street"
        assert cafe["street"] == "Third Street"

    def test_no_addr_anywhere_gives_nulls(self, built):
        _, pois = built
        kiosk = _pois_by_id(pois)["node/43"]
        assert kiosk["address"] is None
        assert kiosk["street"] is None

    def test_street_without_housenumber_never_claims_a_number(self, built):
        _, pois = built
        books = _pois_by_id(pois)["node/44"]
        assert books["address"] is None
        assert books["street"] == "Binney Street"


class _FakeHttp:
    def __init__(self, failures, body):
        self.failures = failures
        self.body = body
        self.calls = []

    def __call__(self, url, data):
        self.calls.append((url, data))
        if len(self.calls) <= self.failures:
            raise OSError("HTTP Error 502: Bad Gateway")
        return self.body


def _body():
    return json.dumps(_fixture()).encode("utf-8")


class TestFetch:
    def test_single_post_to_overpass_on_success(self, mod):
        http = _FakeHttp(failures=0, body=_body())
        result = mod.fetch(http, attempts=3, sleep=lambda _s: None)
        assert result == _fixture()
        assert len(http.calls) == 1
        url, data = http.calls[0]
        assert url == mod.OVERPASS_URL
        assert isinstance(data, bytes) and data

    def test_retries_once_then_succeeds(self, mod):
        http = _FakeHttp(failures=1, body=_body())
        result = mod.fetch(http, attempts=3, sleep=lambda _s: None)
        assert result == _fixture()
        assert len(http.calls) == 2

    def test_gives_up_after_n_attempts(self, mod):
        http = _FakeHttp(failures=99, body=_body())
        with pytest.raises(OSError, match="502"):
            mod.fetch(http, attempts=3, sleep=lambda _s: None)
        assert len(http.calls) == 3


class TestMain:
    def test_default_output_paths(self, mod):
        assert Path(mod.GRAPH_PATH).resolve() == REPO_ROOT / "static" / "data" / "kendall_walk_graph.json"
        assert Path(mod.POIS_PATH).resolve() == REPO_ROOT / "static" / "data" / "kendall_pois.json"

    def test_main_writes_graph_and_pois_json(self, mod, tmp_path):
        graph_out = tmp_path / "graph.json"
        pois_out = tmp_path / "pois.json"
        http = _FakeHttp(failures=0, body=_body())
        rc = mod.main(["--graph-out", str(graph_out), "--pois-out", str(pois_out)], http=http)
        assert rc == 0
        assert len(http.calls) == 1
        expected_graph, expected_pois = mod.build(_fixture())
        assert json.loads(graph_out.read_text(encoding="utf-8")) == expected_graph
        assert json.loads(pois_out.read_text(encoding="utf-8")) == expected_pois
