"""Station core for POST /station (MEM-049): fail-closed blur, pixelation, Spark name + profile, one box."""

import hashlib
import json
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from io import BytesIO

from PIL import Image

from memripal.backend import (
    NO_PHOTO_CACHE,
    PROMPT_ARGS,
    BackendCallFailed,
    BackendReplyInvalid,
    ModelBackend,
    ModelRequest,
)
from memripal.imaging import JPEG_QUALITY, Processed
from memripal.loci import (
    MAX_PHRASE_LEN,
    MAX_SAM_TEXT_BYTES,
    SAM_MODEL,
    SPARK_GEN_PARAMS,
    SPARK_MODEL,
    _segment,
    sanitize_box,
    select_loci,
)
from memripal.probe_metrics import _TOKEN, Box, _parse_token

BLUR_PHRASES = ("person", "license plate")
MAX_BLOCKS = 8
MAX_NAME_WORDS = 3
# Equal to the used-names cap: a name the server returns must be sendable back as a used name.
MAX_NAME_CHARS = 40
MAX_USED_NAMES = 7
# 7 names x 40 chars, each char at worst a 6-byte \uXXXX escape, plus JSON punctuation.
MAX_USED_NAMES_HEADER = 2048
MAX_PROFILE_CHARS = 400
SPARK_ATTEMPTS = 2
# Things that move between walks: a phrase naming one can never be the station box (MEM-079).
MOVABLE_NOUNS = frozenset(
    {"person", "people", "man", "woman", "child", "dog", "car", "bus", "bike", "scooter"}
    | {"truck", "chair", "table", "cart", "bag", "umbrella", "cone"}
)
REPLY_FIELDS = ("station_name", "landmark_phrase", "visual", "spatial", "conceptual")
STATION_SCHEMA = {
    "type": "object",
    "properties": {field: {"type": "string"} for field in REPLY_FIELDS},
    "required": list(REPLY_FIELDS),
    "additionalProperties": False,
}


class BlurFailed(RuntimeError):
    """A blur-phase SAM call failed or its reply did not parse strictly; no photo may go on to Spark."""


class BadReply(RuntimeError):
    """Spark broke the reply contract on every allowed attempt."""


@dataclass(frozen=True)
class StationResult:
    photo: Processed
    name: str
    profile: dict
    box: Box | None


def station_prompt(used_names: list[str]) -> str:
    return (
        "This photo is one station on a walking route. Name the most memorable FIXED structure in it "
        "(fixed structures only: arch, door, statue, tree, sign, bench, bridge, mural). "
        "Never describe people. Never copy text from signs, house numbers or street names. "
        "Return JSON with: station_name (at most 3 words, no digits), landmark_phrase (a short noun "
        "phrase locating that structure in the photo), visual, spatial and conceptual (one sentence each "
        "about it). Do not reuse any of these names, or the last word of any of them: "
        f"{json.dumps(used_names)}."
    )


def _clean_text(value: object, cap: int) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    # Cf too: bidi overrides and zero-width chars can spoof a name that looks clean.
    return 0 < len(text) <= cap and not any(unicodedata.category(c) in ("Cc", "Cf") for c in text)


def _short_name(value: object) -> bool:
    return _clean_text(value, MAX_NAME_CHARS) and len(value.split()) <= MAX_NAME_WORDS


def valid_station_name(name: object) -> bool:
    """Shape only (non-empty, <= 3 words, no digits); uniqueness is the client's check at save (B5)."""
    return _short_name(name) and not any(c.isdigit() for c in name)


def parse_used_names(header: str | None) -> list[str] | None:
    """The X-Memripal-Used-Names header as a validated list; absent == []; None when invalid."""
    if header is None:
        return []
    if len(header) > MAX_USED_NAMES_HEADER or not header.isascii():
        return None
    try:
        names = json.loads(header)
    except ValueError:
        return None
    if not isinstance(names, list) or len(names) > MAX_USED_NAMES or not all(map(_short_name, names)):
        return None
    return [name.strip() for name in names]


def pixelate(img: Image.Image, boxes: list[Box]) -> Image.Image:
    """A new RGB image with each box cut into <= MAX_BLOCKS blocks across its long side (NEAREST)."""
    out = img.convert("RGB")
    for b in boxes:
        w, h = b.x2 - b.x1, b.y2 - b.y1
        long_side = max(w, h)
        size = (max(1, round(w * MAX_BLOCKS / long_side)), max(1, round(h * MAX_BLOCKS / long_side)))
        small = out.crop((b.x1, b.y1, b.x2, b.y2)).resize(size, Image.Resampling.NEAREST)
        out.paste(small.resize((w, h), Image.Resampling.NEAREST), (b.x1, b.y1))
    return out


def strict_boxes(text: object, img_w: int, img_h: int) -> list[Box]:
    """Every box in a blur reply, or BlurFailed; only an empty/whitespace body means "none found".

    Unlike loci._segment, nothing is dropped silently: a box we cannot read is a face we cannot blur.
    """
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_SAM_TEXT_BYTES:
        raise BlurFailed("blur reply not text or over cap")
    if not text.strip():
        return []
    tokens = list(_TOKEN.finditer(text))
    # A token opener the regex did not match (e.g. truncated) would otherwise vanish unparsed.
    if not tokens or text.count("<|") != len(tokens):
        raise BlurFailed("blur reply has unparsed text")
    boxes = []
    for match in tokens:
        parsed = _parse_token(match.group(1))
        box = sanitize_box(parsed, img_w, img_h) if parsed is not None else None
        if box is None:
            raise BlurFailed("blur box rejected")
        boxes.append(box)
    return boxes


def _blur_segment(backend: ModelBackend, processed: Processed, phrase: str) -> list[Box]:
    req = ModelRequest(
        method="segment",
        image_jpeg=processed.jpeg,
        subject=phrase,
        attempt=0,
        model=SAM_MODEL,
        prompt_template_id="sam-phrase",
        # The raw photo must never land in the live cache (D3).
        gen_params={NO_PHOTO_CACHE: True},
        schema=None,
    )
    try:
        text = backend.call(req)
    except BackendCallFailed as exc:
        raise BlurFailed("blur call failed") from exc
    return strict_boxes(text, processed.width, processed.height)


def blur_boxes(backend: ModelBackend, processed: Processed) -> list[Box]:
    with ThreadPoolExecutor(max_workers=len(BLUR_PHRASES)) as pool:
        futures = [pool.submit(_blur_segment, backend, processed, p) for p in BLUR_PHRASES]
        return [box for fut in futures for box in fut.result()]


def pixelated_photo(processed: Processed, boxes: list[Box]) -> Processed:
    with Image.open(BytesIO(processed.jpeg)) as im:
        out = pixelate(im, boxes)
    out.info = {}
    buf = BytesIO()
    out.save(buf, "JPEG", quality=JPEG_QUALITY)
    jpeg = buf.getvalue()
    return Processed(jpeg=jpeg, width=out.width, height=out.height, sha=hashlib.sha256(jpeg).hexdigest())


def movable_phrase(phrase: str) -> bool:
    """True when any word of the phrase is a MOVABLE_NOUNS entry, singular or plural, any case."""
    words = "".join(c if c.isalpha() else " " for c in phrase.lower()).split()
    return any({w, w.removesuffix("s"), w.removesuffix("es")} & MOVABLE_NOUNS for w in words)


def _checked_reply(reply: object) -> tuple[str, str, dict] | None:
    if not isinstance(reply, dict) or set(reply) != set(REPLY_FIELDS):
        return None
    name, phrase = reply["station_name"], reply["landmark_phrase"]
    if not valid_station_name(name) or not _clean_text(phrase, MAX_PHRASE_LEN) or movable_phrase(phrase):
        return None
    profile = {k: reply[k] for k in ("visual", "spatial", "conceptual")}
    if not all(_clean_text(v, MAX_PROFILE_CHARS) for v in profile.values()):
        return None
    return name.strip(), phrase.strip(), {k: v.strip() for k, v in profile.items()}


def name_station(backend: ModelBackend, photo: Processed, used_names: list[str]) -> tuple[str, str, dict]:
    for attempt in range(SPARK_ATTEMPTS):
        req = ModelRequest(
            method="spark_json",
            image_jpeg=photo.jpeg,
            subject="station",
            attempt=attempt,
            model=SPARK_MODEL,
            prompt_template_id="station",
            gen_params={**SPARK_GEN_PARAMS, PROMPT_ARGS: {"used_names": list(used_names)}},
            schema=STATION_SCHEMA,
        )
        # A malformed/schema-invalid reply is a reply-contract failure like a bad shape: regenerate.
        # Transport failures (plain BackendCallFailed) propagate unretried.
        try:
            checked = _checked_reply(backend.call(req))
        except BackendReplyInvalid:
            checked = None
        if checked is not None:
            return checked
    raise BadReply("station reply invalid after regenerate")


def landmark_box(backend: ModelBackend, photo: Processed, phrase: str) -> Box | None:
    boxes = _segment(backend, photo, phrase)
    selected = select_loci({phrase: boxes}, photo.width, photo.height, min_loci=1, max_loci=1)
    return selected[0][1] if selected else None


def run_station(backend: ModelBackend, processed: Processed, used_names: list[str]) -> StationResult:
    """Blur gate -> pixelate -> Spark on the pixelated photo -> landmark box; raises BlurFailed / BadReply."""
    photo = pixelated_photo(processed, blur_boxes(backend, processed))
    name, phrase, profile = name_station(backend, photo, used_names)
    return StationResult(photo=photo, name=name, profile=profile, box=landmark_box(backend, photo, phrase))
