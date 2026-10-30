"""Generated test rooms for GET /demo/photo.jpg?room=<room_id> (MEM-043 D1, ADR 0029): test fixtures only.

The path is built only from an id that fullmatches ROOM_ID, so no file outside rooms_dir is reachable.
Bytes go out raw with the media type imaging.sniff reports: a re-encode would break the sha replay
(ADR 0016). Callers treat an empty ?room= as no param (Q23 default).
"""

import re
from pathlib import Path

from fastapi.responses import JSONResponse, Response

from memripal.imaging import sniff

ROOM_ID = re.compile(r"[a-z0-9-]{1,32}")


def room_photo(rooms_dir: Path, room: str) -> Response:
    path = rooms_dir / f"{room}.webp" if ROOM_ID.fullmatch(room) else None
    if path is None or not path.is_file():
        return JSONResponse({"error": "room_missing"}, status_code=404)
    data = path.read_bytes()
    return Response(data, media_type=f"image/{sniff(data)}")
