"""Cut the Kendall Square map extract out of a Protomaps planet PMTiles archive (MEM-074, item 22).

Usage: uv run python scripts/build_map_extract.py --source https://build.protomaps.com/<YYYYMMDD>.pmtiles
       --out static/map/kendall.pmtiles
Reads only the header, directories and BBOX tiles via HTTP Range requests (never the whole planet), and
writes a PMTiles v3 archive of the z12-14 tiles intersecting BBOX, payloads copied byte-for-byte.
"""

import argparse
import math
import sys
from pathlib import Path

import httpx
from pmtiles.reader import Reader
from pmtiles.tile import zxy_to_tileid
from pmtiles.writer import Writer

# Kendall Square, Cambridge MA: (min_lon, min_lat, max_lon, max_lat).
BBOX = (-71.1083, 42.3494, -71.0719, 42.3764)
# Source metadata keys worth carrying into the extract; the planet's other keys describe the planet build.
KEPT_METADATA = ("vector_layers", "attribution")


def _lon_to_x(lon, z):
    return int((lon + 180.0) / 360.0 * (1 << z))


def _lat_to_y(lat, z):
    rad = math.radians(lat)
    return int((1.0 - math.log(math.tan(rad) + 1.0 / math.cos(rad)) / math.pi) / 2.0 * (1 << z))


def _e7(deg):
    return round(deg * 10_000_000)


def _bbox_tile_ids(bbox, minzoom, maxzoom):
    min_lon, min_lat, max_lon, max_lat = bbox
    ids = []
    for z in range(minzoom, maxzoom + 1):
        # Tile y grows southward, so the north edge (max_lat) gives the smallest y.
        for x in range(_lon_to_x(min_lon, z), _lon_to_x(max_lon, z) + 1):
            for y in range(_lat_to_y(max_lat, z), _lat_to_y(min_lat, z) + 1):
                ids.append((zxy_to_tileid(z, x, y), z, x, y))
    return sorted(ids)


def extract(get_bytes, out_file, bbox=BBOX, minzoom=12, maxzoom=14):
    """Write the source tiles at minzoom..maxzoom intersecting bbox to out_file as PMTiles v3."""
    reader = Reader(get_bytes)
    header = reader.header()
    metadata = reader.metadata()
    writer = Writer(out_file)
    # Writer clusters by tile id, so tiles go in ascending id order.
    for tile_id, z, x, y in _bbox_tile_ids(bbox, minzoom, maxzoom):
        data = reader.get(z, x, y)
        if data:
            writer.write_tile(tile_id, data)
    writer.finalize(
        {
            "tile_type": header["tile_type"],
            "tile_compression": header["tile_compression"],
            "min_lon_e7": _e7(bbox[0]),
            "min_lat_e7": _e7(bbox[1]),
            "max_lon_e7": _e7(bbox[2]),
            "max_lat_e7": _e7(bbox[3]),
        },
        {key: metadata[key] for key in KEPT_METADATA if key in metadata},
    )


def http_source(client, url):
    """A pmtiles get_bytes over HTTP Range requests; Reader.get re-reads directories, so reads are cached."""
    cache = {}

    def get_bytes(offset, length):
        key = (offset, length)
        if key not in cache:
            resp = client.get(url, headers={"Range": f"bytes={offset}-{offset + length - 1}"})
            resp.raise_for_status()
            # A 200 means the server ignored Range and is sending the whole planet; refuse it.
            if resp.status_code != 206:
                raise RuntimeError(f"{url}: server ignored the Range request (HTTP {resp.status_code})")
            cache[key] = resp.content
        return cache[key]

    return get_bytes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", required=True, help="planet PMTiles URL (https)")
    parser.add_argument("--out", required=True, type=Path, help="output .pmtiles path")
    args = parser.parse_args(argv)
    if not args.source.startswith("https://"):
        parser.error("--source must be an https:// URL")
    with httpx.Client(follow_redirects=True, timeout=60.0) as client, args.out.open("wb") as out_file:
        extract(http_source(client, args.source), out_file)
    print(f"wrote {args.out} ({args.out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
