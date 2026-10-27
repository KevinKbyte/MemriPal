# Covers: MEM-020
"""Contract for src/memripal/textnorm.py (MEM-020, ADR 0019).

`normalize(s: str) -> str` is the ONE text normalizer shared by POST /split (source_quote
exact-substring check, D15) and the later S3 association validator:
- case fold via str.casefold() (so "Strasse" and "Stra\\u00dfe" normalize equal);
- every Unicode punctuation character (unicodedata category P*) becomes a word separator
  (replaced by a space, never glued: "a,b" -> "a b", "don't" -> "don t");
- any run of whitespace (incl. tabs, newlines, NBSP) collapses to one ASCII space;
- leading/trailing whitespace stripped; digits kept;
- idempotent: normalize(normalize(s)) == normalize(s).
"""

import pytest

from memripal.textnorm import normalize

SAMPLES = [
    "",
    "   ",
    "Hello World",
    "  Hello,   WORLD!!  ",
    "a,b;c",
    "well -- said",
    "don't stop",
    "\u201cQuoted\u201d text",
    "Stra\u00dfe",
    "line one\nline two\r\n\tline three",
    "a\u00a0b",
    "Room 101, floor 3.",
    "?!...",
]


# Requirement: normalize() folds case, turns punctuation into word breaks, collapses whitespace
# and strips the ends, so two texts that differ only in case, punctuation or spacing compare equal.
class TestNormalize:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Hello World", "hello world"),
            ("HELLO", "hello"),
            ("Stra\u00dfe", "strasse"),
        ],
        ids=["mixed-case", "upper", "casefold-sharp-s"],
    )
    def test_case_is_folded(self, raw, expected):
        assert normalize(raw) == expected

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("  hello   world  ", "hello world"),
            ("hello\tworld\n", "hello world"),
            ("line one\nline two\r\n\tline three", "line one line two line three"),
            ("a\u00a0b", "a b"),
        ],
        ids=["spaces", "tab-newline", "crlf-mixed", "nbsp"],
    )
    def test_whitespace_runs_collapse_to_one_space_and_ends_are_stripped(self, raw, expected):
        assert normalize(raw) == expected

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Hello, world!", "hello world"),
            ("a,b;c", "a b c"),
            ("well -- said", "well said"),
            ("don't stop", "don t stop"),
            ("\u201cQuoted\u201d text", "quoted text"),
            ("Room 101, floor 3.", "room 101 floor 3"),
        ],
        ids=["comma-bang", "glued-separators", "dashes", "apostrophe", "curly-quotes", "digits-kept"],
    )
    def test_punctuation_becomes_a_word_break(self, raw, expected):
        assert normalize(raw) == expected

    @pytest.mark.parametrize("raw", ["", "   ", "?!...", "\n\t"], ids=["empty", "blank", "punct-only", "ws"])
    def test_empty_blank_or_punctuation_only_normalizes_to_empty(self, raw):
        assert normalize(raw) == ""

    @pytest.mark.parametrize("raw", SAMPLES)
    def test_is_idempotent(self, raw):
        once = normalize(raw)
        assert isinstance(once, str)
        assert normalize(once) == once

    def test_variants_differing_only_in_case_punctuation_spacing_are_equal(self):
        assert normalize("Our budget,  DOUBLED this year!") == normalize("our budget doubled this year")

    def test_normalized_quote_is_found_inside_normalized_notes(self):
        notes = "Thank you all. First -- our budget DOUBLED,\nthis year!"
        assert normalize("our budget doubled this year") in normalize(notes)
