"""The one text normalizer for quote checks: POST /split and the S3 association validator (MEM-020)."""

import unicodedata


def normalize(s: str) -> str:
    """Casefold, turn every Unicode punctuation char into a space, collapse whitespace, strip the ends."""
    spaced = "".join(" " if unicodedata.category(ch).startswith("P") else ch for ch in s.casefold())
    # str.split() with no argument splits on any Unicode whitespace run (tab, CRLF, NBSP) and drops the ends.
    return " ".join(spaced.split())
