"""POST /recall/audio input and upstream checks (MEM-032, plan D4): one WAV clip in, transcript text out.

Pure functions only: the audio stays in memory and nothing here logs or persists it.
"""

import base64
import json

from memripal.meta_client import _check_wav_format
from memripal.split import MAX_LABEL_CHARS, MAX_POINTS

# D4 server cap per chunk, in decoded audio bytes.
MAX_CHUNK_BYTES = 1024 * 1024
# A ~8 s clip transcribes to a few hundred chars; anything past this is not speech worth relaying.
MAX_TRANSCRIPT_CHARS = 2000
# Base64 of a max-size clip plus room for 12 labels even when JSON-escaped as \uXXXX.
RELAY_BODY_CAP = 4 * -(-MAX_CHUNK_BYTES // 3) + 16 * 1024
BODY_KEYS = {"audio", "keywords"}
# MEM-145: the opt-in Spark grade flag, a JSON bool only.
GRADE_KEY = "grade"


def parse_body(raw: bytes) -> tuple[str, list[str], bool] | None:
    """(audio base64, keywords, grade) when the body is {audio, keywords} plus an optional bool grade, within
    label caps; else None."""
    try:
        body = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(body, dict) or set(body) - {GRADE_KEY} != BODY_KEYS:
        return None
    grade = body.get(GRADE_KEY, False)
    if not isinstance(grade, bool):
        return None
    audio, keywords = body["audio"], body["keywords"]
    if not isinstance(audio, str) or not isinstance(keywords, list) or len(keywords) > MAX_POINTS:
        return None
    if not all(isinstance(k, str) and len(k) <= MAX_LABEL_CHARS for k in keywords):
        return None
    return audio, keywords, grade


def decode_audio(audio: str) -> bytes | None:
    try:
        # validate=True rejects any non-alphabet char, so a "data:...;base64," prefix fails here.
        return base64.b64decode(audio, validate=True)
    except ValueError:  # binascii.Error, or a non-ASCII str
        return None


def is_relayable_wav(data: bytes) -> bool:
    """RIFF/WAVE mono 16-bit at 16|24 kHz, judged from the header (webm/opus and other containers fail)."""
    try:
        _check_wav_format(data)
    except ValueError:
        return False
    return True


def transcript_or_none(body: bytes) -> str | None:
    """The upstream "transcript" string, or None for any other reply shape."""
    try:
        data = json.loads(body)
    except ValueError:
        return None
    text = data.get("transcript") if isinstance(data, dict) else None
    return text if isinstance(text, str) else None
