"""The /static mount, with the map asset types Python's mimetypes table lacks (MEM-078, ADR 0041)."""

import mimetypes
from pathlib import Path

from fastapi.staticfiles import StaticFiles

# StaticFiles guesses Content-Type from this table; without the entry the extract would go out as a
# guessed application/octet-stream.
mimetypes.add_type("application/vnd.pmtiles", ".pmtiles")


def static_files(directory: Path) -> StaticFiles:
    return StaticFiles(directory=directory)
