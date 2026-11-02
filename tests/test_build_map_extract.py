# Covers: MEM-074
# Requirement: scripts/build_map_extract.py cuts the Kendall Square map extract out of a planet PMTiles
# archive. extract(get_bytes, out_file, bbox=BBOX, minzoom=12, maxzoom=14) reads the source through a
# pmtiles Reader byte-range source and writes a PMTiles v3 archive holding exactly the source tiles at
# z12-14 whose slippy-map tile intersects BBOX (-71.1083, 42.3494, -71.0719, 42.3764), payloads copied
# byte-for-byte, a BBOX tile absent from the source silently skipped; the output header carries
# min_zoom 12, max_zoom 14, bounds equal to BBOX (e7 ints) and the source's tile_compression and
# tile_type. The committed static/map/kendall.pmtiles is that extract and stays <= 3 MiB.
import importlib.util
import io
import math
from pathlib import Path

import pytest
from pmtiles.reader import MemorySource, Reader, all_tiles
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "build_map_extract.py"
ARTIFACT = REPO_ROOT / "static" / "map" / "kendall.pmtiles"

EXPECTED_BBOX = (-71.1083, 42.3494, -71.0719, 42.3764)
MAX_ARTIFACT_BYTES = 3 * 1024 * 1024
SOURCE_ZOOMS = range(10, 16)
TARGET_ZOOMS = range(12, 15)
MARGIN = 2


def _load():
    assert SCRIPT.exists(), f"missing {SCRIPT.relative_to(REPO_ROOT)}"
    spec = importlib.util.spec_from_file_location("build_map_extract_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _lon_to_x(lon, z):
    return int((lon + 180.0) / 360.0 * (1 << z))


def _lat_to_y(lat, z):
    rad = math.radians(lat)
    return int((1.0 - math.log(math.tan(rad) + 1.0 / math.cos(rad)) / math.pi) / 2.0 * (1 << z))


def _bbox_tiles(z, bbox=EXPECTED_BBOX):
    min_lon, min_lat, max_lon, max_lat = bbox
    x0, x1 = _lon_to_x(min_lon, z), _lon_to_x(max_lon, z)
    y0, y1 = _lat_to_y(max_lat, z), _lat_to_y(min_lat, z)
    return {(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)}


def _e7(deg):
    return round(deg * 10_000_000)


def _payload(z, x, y):
    return f"tile {z}/{x}/{y}".encode()


def _planet_tiles(omit=()):
    """Tiles at z10-15: every BBOX tile, a MARGIN ring of non-BBOX neighbours, and far-away corners."""
    tiles = set()
    for z in SOURCE_ZOOMS:
        inside = _bbox_tiles(z)
        xs = [x for _, x, _ in inside]
        ys = [y for _, _, y in inside]
        for x in range(min(xs) - MARGIN, max(xs) + MARGIN + 1):
            for y in range(min(ys) - MARGIN, max(ys) + MARGIN + 1):
                tiles.add((z, x, y))
        last = (1 << z) - 1
        tiles.update({(z, 0, 0), (z, last, last), (z, 0, last)})
    return {t: _payload(*t) for t in tiles if t not in set(omit)}


def _build_planet(tiles, tile_type, tile_compression):
    buf = io.BytesIO()
    writer = Writer(buf)
    for z, x, y in sorted(tiles, key=lambda t: zxy_to_tileid(*t)):
        writer.write_tile(zxy_to_tileid(z, x, y), tiles[(z, x, y)])
    writer.finalize(
        {
            "tile_type": tile_type,
            "tile_compression": tile_compression,
            "min_lon_e7": _e7(-180.0),
            "min_lat_e7": _e7(-85.0),
            "max_lon_e7": _e7(180.0),
            "max_lat_e7": _e7(85.0),
            "center_zoom": 10,
            "center_lon_e7": _e7(EXPECTED_BBOX[0]),
            "center_lat_e7": _e7(EXPECTED_BBOX[1]),
        },
        {"name": "synthetic planet"},
    )
    return buf.getvalue()


def _run_extract(module, planet_bytes, tmp_path):
    out_path = tmp_path / "extract.pmtiles"
    with out_path.open("wb") as out_file:
        module.extract(MemorySource(planet_bytes), out_file)
    return out_path.read_bytes()


def _expected(planet_tiles):
    wanted = set().union(*(_bbox_tiles(z) for z in TARGET_ZOOMS))
    return {t: planet_tiles[t] for t in wanted if t in planet_tiles}


def _read_all(archive_bytes):
    return {tuple(zxy): bytes(data) for zxy, data in all_tiles(MemorySource(archive_bytes))}


def _assert_bounds_equal_bbox(header):
    got = (header["min_lon_e7"], header["min_lat_e7"], header["max_lon_e7"], header["max_lat_e7"])
    want = tuple(_e7(v) for v in EXPECTED_BBOX)
    # 1 e7 unit (~1 cm) of slack absorbs float->int rounding vs truncation; anything more is wrong bounds.
    assert all(abs(g - w) <= 1 for g, w in zip(got, want, strict=True)), f"bounds {got} != BBOX {want}"


class TestBuildMapExtract:
    def test_bbox_constant_is_kendall_square(self):
        assert tuple(_load().BBOX) == EXPECTED_BBOX

    @pytest.mark.parametrize(
        ("tile_type", "tile_compression"),
        [(TileType.MVT, Compression.GZIP), (TileType.PNG, Compression.NONE)],
    )
    def test_extract_keeps_exactly_bbox_tiles_z12_to_z14_byte_identical(
        self, tmp_path, tile_type, tile_compression
    ):
        planet_tiles = _planet_tiles()
        planet = _build_planet(planet_tiles, tile_type, tile_compression)

        out = _run_extract(_load(), planet, tmp_path)

        got = _read_all(out)
        expected = _expected(planet_tiles)
        assert set(got) == set(expected), (
            f"missing {sorted(set(expected) - set(got))}, extra {sorted(set(got) - set(expected))}"
        )
        for zxy, data in expected.items():
            assert got[zxy] == data, f"payload differs for {zxy}"

    @pytest.mark.parametrize(
        ("tile_type", "tile_compression"),
        [(TileType.MVT, Compression.GZIP), (TileType.PNG, Compression.NONE)],
    )
    def test_extract_header_zooms_bounds_and_tile_format(self, tmp_path, tile_type, tile_compression):
        planet = _build_planet(_planet_tiles(), tile_type, tile_compression)

        header = Reader(MemorySource(_run_extract(_load(), planet, tmp_path))).header()

        assert header["min_zoom"] == 12
        assert header["max_zoom"] == 14
        _assert_bounds_equal_bbox(header)
        assert header["tile_type"] == tile_type
        assert header["tile_compression"] == tile_compression

    def test_bbox_tile_missing_from_source_is_skipped(self, tmp_path):
        missing = sorted(_bbox_tiles(13))[0]
        planet_tiles = _planet_tiles(omit=[missing])
        planet = _build_planet(planet_tiles, TileType.MVT, Compression.GZIP)

        out = _run_extract(_load(), planet, tmp_path)

        got = _read_all(out)
        assert missing not in got
        assert set(got) == set(_expected(planet_tiles))


class TestCommittedKendallExtract:
    def test_artifact_exists_and_fits_size_budget(self):
        assert ARTIFACT.exists(), f"missing {ARTIFACT.relative_to(REPO_ROOT)}"
        size = ARTIFACT.stat().st_size
        assert 0 < size <= MAX_ARTIFACT_BYTES, f"{size} bytes exceeds {MAX_ARTIFACT_BYTES}"

    def test_artifact_is_pmtiles_v3_with_kendall_bounds_and_zooms(self):
        assert ARTIFACT.exists(), f"missing {ARTIFACT.relative_to(REPO_ROOT)}"
        data = ARTIFACT.read_bytes()
        assert data[:8] == b"PMTiles\x03"
        header = Reader(MemorySource(data)).header()
        assert header["min_zoom"] == 12
        assert header["max_zoom"] == 14
        _assert_bounds_equal_bbox(header)
        assert header["tile_type"] == TileType.MVT
