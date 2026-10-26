"""One-shot live probe of the Meta Model API against the plan's 5 checks (MEM-008)."""

import importlib.util
import json
import time
from collections.abc import Callable
from dataclasses import asdict
from io import BytesIO

from PIL import Image

from memripal.meta_client import (
    CallResult,
    MetaClient,
    chat_content_json,
    image_bytes,
    responses_text,
    to_data_url,
    transcript_text,
)
from memripal.probe_metrics import Box, crop_for_edit, drift_outside_bbox, keep_loci, parse_boxes, scaled_to

MIN_LOCI = 10
ITEM = "toothbrush"

PHRASE_SCHEMA = {
    "type": "object",
    "properties": {"phrases": {"type": "array", "items": {"type": "string"}}},
    "required": ["phrases"],
    "additionalProperties": False,
}
ASSOC_SCHEMA = {
    "type": "object",
    "properties": {k: {"type": "string"} for k in ("item", "locus", "scene")},
    "required": ["item", "locus", "scene"],
    "additionalProperties": False,
}

PHRASE_PROMPT = (
    "List 20-25 short, concrete noun phrases (1-3 words each), one per distinct physical object or "
    "place clearly visible in this photo. Prefer large, separate, easy-to-point-at things."
)


def _reask_prompt(exclude: list[str]) -> str:
    listed = "\n".join(f"- {p}" for p in exclude)
    return (
        PHRASE_PROMPT
        + " Do NOT repeat any of these already-found objects; name different ones:\n"
        + listed
    )


def _assoc_prompt(locus: str) -> str:
    return (
        f"Memory palace: place the item '{ITEM}' at the locus '{locus}' in a vivid, absurd, "
        "memorable one-sentence scene. Return item, locus and scene."
    )


def _edit_prompt(locus: str) -> str:
    return f"add a giant {ITEM} at the {locus}; keep everything else exactly as is"


def _safe(fn: Callable, *args):
    """Live responses may be malformed; a probe records the gap instead of aborting the run."""
    try:
        return fn(*args)
    except (
        ValueError, KeyError, IndexError, TypeError, AttributeError, OSError, Image.DecompressionBombError
    ):
        return None


def _dims(data: bytes) -> list[int]:
    with Image.open(BytesIO(data)) as img:
        return [img.width, img.height]


def _duration_ms(body: bytes):
    return json.loads(body)["audioDurationMs"]


def run_probe(
    client: MetaClient,
    photo_jpeg: bytes,
    *,
    clock: Callable[[], float] = time.perf_counter,
    on_image: Callable[[str, bytes], None] | None = None,
    audio_wav: bytes | None = None,
) -> dict:
    """Run the probe; `on_image(name, bytes)` receives edited images so the report stays bytes-free."""
    start = clock()
    calls: list[dict] = []

    def record(kind: str, result: CallResult) -> CallResult:
        calls.append(
            {
                "kind": kind,
                "ok": result.ok,
                "status": result.status,
                "attempts": result.attempts,
                "latency_s": result.latency_s,
                "error": result.error,
            }
        )
        return result

    photo_url = to_data_url(photo_jpeg)
    img_w, img_h = _dims(photo_jpeg)
    phrases: list[str] = []
    per_phrase: dict[str, list[Box]] = {}

    def ask_phrases(kind: str, prompt: str) -> list[str] | None:
        res = record(kind, client.chat_json(
            prompt=prompt, schema=PHRASE_SCHEMA, schema_name="phrases", image_data_url=photo_url
        ))
        data = _safe(chat_content_json, res.body) if res.ok else None
        got = data.get("phrases") if isinstance(data, dict) else None
        if not isinstance(got, list) or not all(isinstance(p, str) for p in got):
            return None
        return got

    def segment_new(new: list[str]) -> None:
        for raw in new:
            phrase = raw.strip()
            if not phrase or phrase in per_phrase:
                continue
            phrases.append(phrase)
            res = record("sam", client.segment(image_data_url=photo_url, phrase=phrase))
            text = _safe(responses_text, res.body) if res.ok else None
            per_phrase[phrase] = parse_boxes(text) if isinstance(text, str) else []

    def kept_now() -> list[tuple[str, Box]]:
        scaled = {p: [scaled_to(b, img_w, img_h) for b in bs] for p, bs in per_phrase.items()}
        return keep_loci(scaled, img_w, img_h)

    first = ask_phrases("spark_phrases", PHRASE_PROMPT)
    schema_image_ok = first is not None
    segment_new(first or [])
    kept = kept_now()

    reask_used = False
    if schema_image_ok and len(kept) < MIN_LOCI:
        reask_used = True
        more = ask_phrases("spark_reask", _reask_prompt([p for p, _ in kept]))
        segment_new(more or [])
        kept = kept_now()

    association = None
    association_skipped = None
    tier1: dict | None = None
    tier2: dict | None = None
    drift = None
    if kept:
        locus, box = kept[0]
        res = record("spark_association", client.chat_json(
            prompt=_assoc_prompt(locus), schema=ASSOC_SCHEMA, schema_name="association"
        ))
        association = _safe(chat_content_json, res.body) if res.ok else None

        res = record("image_edit_tier1", client.image_edit(
            image_data_url=photo_url, prompt=_edit_prompt(locus)
        ))
        edited = _safe(image_bytes, res.body) if res.ok else None
        dims = _safe(_dims, edited) if edited else None
        if dims is not None:
            drift = _safe(drift_outside_bbox, photo_jpeg, edited, box)
            if on_image is not None:
                on_image("tier1", edited)
        tier1 = {"dims": dims, "latency_s": res.latency_s, "drift": drift}

        crop = _safe(crop_for_edit, photo_jpeg, box)
        if crop is None:
            tier2 = {"dims": None, "input_dims": None, "latency_s": None}
        else:
            res = record("image_edit_tier2", client.image_edit(
                image_data_url=to_data_url(crop), prompt=_edit_prompt(locus)
            ))
            edited2 = _safe(image_bytes, res.body) if res.ok else None
            dims2 = _safe(_dims, edited2) if edited2 else None
            if dims2 is not None and on_image is not None:
                on_image("tier2", edited2)
            tier2 = {"dims": dims2, "input_dims": _safe(_dims, crop), "latency_s": res.latency_s}
    else:
        association_skipped = "no kept loci"

    output_dims = (tier1 or {}).get("dims") or (tier2 or {}).get("dims")
    checks = {
        "schema_image_ok": schema_image_ok,
        "parser_installs": importlib.util.find_spec("meta_sam_parser") is not None,
        "score_present": any(b.confidence is not None for bs in per_phrase.values() for b in bs),
        "image_output_dims": output_dims,
        "drift_metric": drift,
    }
    extra: dict = {}
    if audio_wav is not None:
        try:
            res = record("asr", client.transcribe(audio_wav))
        except ValueError as exc:
            # Rejected locally (empty/oversize clip): nothing was sent, so there is no status.
            asr = {
                "transcript": None, "audioDurationMs": None, "latency_s": None, "status": None,
                "error": str(exc),
            }
        else:
            text = _safe(transcript_text, res.body) if res.ok else None
            duration = _safe(_duration_ms, res.body) if res.ok else None
            asr = {
                "transcript": text if isinstance(text, str) else None,
                "audioDurationMs": duration if isinstance(duration, int | float) else None,
                "latency_s": res.latency_s,
                "status": res.status,
                "error": res.error,
            }
        checks["asr_ok"] = asr["status"] == 200 and asr["error"] is None
        checks["asr_transcript_nonempty"] = bool(asr["transcript"])
        checks["asr_has_duration"] = asr["audioDurationMs"] is not None
        extra["asr"] = asr

    return {
        "phrases": phrases,
        "kept_loci": [{"phrase": p, "box": asdict(b)} for p, b in kept],
        "kept_count": len(kept),
        "reask_used": reask_used,
        "checks": checks,
        **extra,
        "association": association,
        "association_skipped": association_skipped,
        "tier1": tier1,
        "tier2": tier2,
        "calls": calls,
        "elapsed_s": clock() - start,
    }
