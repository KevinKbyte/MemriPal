"""Contract (MEM-021): `memripal.associate` validates one Spark association record per item.

- `CHANNELS`: the 8 KAVE COGS channel keys, in order.
- `ASSOCIATION_SCHEMA`: strict flat json_schema {item, locus, <8 channels>, scene_prompt_details, walk_cue,
  reencode_hint, question, answer}; every property a required string; additionalProperties false.
- `validate_association(value, item, locus) -> str | None`: None when valid, else a short non-empty reason.
  Rules, compared after whitespace/punctuation/case normalization: (1) all 8 channels non-empty; (2) the
  item appears in >= 1 channel; (3) the locus short label appears in >= 1 channel; (4) echoed `item` and
  `locus` match the request. D16: `question` and `answer` are required and non-empty. Untrusted-reply
  hardening: a non-dict, a missing or unknown field, a non-string value, or an oversized reply is rejected
  here (length caps live in the validator: backend `_schema_valid` refuses keywords like maxLength).
- `associate(backend, processed, item, locus)` refuses an empty or > MAX_ITEM_LEN (100) char item and an
  empty locus with ValueError before any backend call.
"""

import copy
import importlib

import pytest

from memripal.imaging import Processed

CHANNELS = (
    "kinesthetic",
    "auditory",
    "visual",
    "emotional",
    "conceptual",
    "olfactory",
    "gustatory",
    "spatial",
)
EXTRA_TEXT = ("scene_prompt_details", "walk_cue", "reencode_hint", "question", "answer")
ITEM = "milk carton"
LOCUS = "left book"
IMAGE = b"\xff\xd8\xff\xe0fake-processed-jpeg-bytes\xff\xd9"
PROCESSED = Processed(jpeg=IMAGE, width=1000, height=800, sha="0" * 64)


@pytest.fixture
def assoc():
    # Imported per test, so a missing module fails each test rather than erroring collection.
    return importlib.import_module("memripal.associate")


def good_record(item=ITEM, locus=LOCUS, **over):
    """Valid record: item named in kinesthetic only, locus label in spatial only."""
    rec = {
        "item": item,
        "locus": locus,
        "kinesthetic": f"You grip a freezing {item} with both hands.",
        "auditory": "It glugs and sloshes like a drum.",
        "visual": "A towering white carton glows.",
        "emotional": "You feel giddy and a little scared.",
        "conceptual": "Calcium builds strong bones.",
        "olfactory": "Sour cream smell fills the air.",
        "gustatory": "Cold and sweet on your tongue.",
        "spatial": f"It balances on top of the {locus}.",
        "scene_prompt_details": "giant carton, dramatic light",
        "walk_cue": "Look up at the shelf.",
        "reencode_hint": "Picture the drum sound.",
        "question": "Why does cold storage keep it fresh longer?",
        "answer": "Low temperature slows bacterial growth.",
    }
    rec.update(over)
    return rec


def without_text(rec, needle):
    """Copy of rec with `needle` scrubbed from every text field except the echoed item/locus."""
    out = copy.deepcopy(rec)
    for k, v in out.items():
        if k not in ("item", "locus"):
            out[k] = v.replace(needle, "thing")
    return out


class CountingBackend:
    mode = "fake"

    def __init__(self):
        self.calls = 0

    def call(self, req):
        self.calls += 1
        return good_record()


# Covers: MEM-021
# Requirement: Spark is asked for the flat strict association schema: item, locus, 8 KAVE COGS channels,
# scene/walk/re-encode text and the D16 why/apply question + answer, all required strings, nothing else.
class TestAssociationSchema:
    def test_channels_are_the_eight_kave_cogs_channels(self, assoc):
        assert tuple(assoc.CHANNELS) == CHANNELS

    def test_schema_is_flat_strict_and_all_required_strings(self, assoc):
        schema = assoc.ASSOCIATION_SCHEMA
        expected = {"item", "locus", *CHANNELS, *EXTRA_TEXT}
        assert schema["type"] == "object"
        assert set(schema["properties"]) == expected
        assert set(schema["required"]) == expected
        assert schema["additionalProperties"] is False
        assert all(p == {"type": "string"} for p in schema["properties"].values())

    def test_good_record_is_valid(self, assoc):
        assert assoc.validate_association(good_record(), ITEM, LOCUS) is None


# Covers: MEM-021
# Requirement: rule 1 - every one of the 8 channels must carry text; an empty, blank or punctuation-only
# channel is invalid and the reason names that channel.
class TestRuleChannelsNonEmpty:
    def test_all_channels_filled_passes(self, assoc):
        assert assoc.validate_association(good_record(), ITEM, LOCUS) is None

    @pytest.mark.parametrize("blank", ["", "   ", "-"], ids=["empty", "spaces", "punct-only"])
    def test_one_blank_channel_fails_and_names_it(self, assoc, blank):
        reason = assoc.validate_association(good_record(olfactory=blank), ITEM, LOCUS)
        assert isinstance(reason, str) and reason
        assert "olfactory" in reason


# Covers: MEM-021
# Requirement: rule 2 - the item text appears in at least one channel, matched after case, whitespace and
# punctuation normalization; a record never naming the item is invalid.
class TestRuleItemInChannel:
    def test_item_with_case_spacing_and_punctuation_noise_passes(self, assoc):
        rec = good_record(kinesthetic="You grip the freezing MILK   CARTON, hard!")
        assert assoc.validate_association(rec, ITEM, LOCUS) is None

    def test_item_absent_from_every_channel_fails(self, assoc):
        rec = without_text(good_record(), ITEM)
        reason = assoc.validate_association(rec, ITEM, LOCUS)
        assert isinstance(reason, str) and reason


# Covers: MEM-021
# Requirement: rule 3 - the locus short label appears in at least one channel (normalized); a record that
# only echoes it in the `locus` field is invalid.
class TestRuleLocusPresent:
    def test_label_with_case_and_punctuation_noise_passes(self, assoc):
        rec = good_record(spatial="It balances on the Left  Book!")
        assert assoc.validate_association(rec, ITEM, LOCUS) is None

    def test_label_absent_from_every_channel_fails(self, assoc):
        rec = without_text(good_record(), LOCUS)
        reason = assoc.validate_association(rec, ITEM, LOCUS)
        assert isinstance(reason, str) and reason


# Covers: MEM-021
# Requirement: rule 4 - the echoed `item` and `locus` must match the requested pair (normalized), so a
# record for another item or another locus is never accepted.
class TestRuleEchoMatches:
    def test_echo_differing_only_by_case_passes(self, assoc):
        rec = good_record(item="Milk Carton", locus="Left Book")
        assert assoc.validate_association(rec, ITEM, LOCUS) is None

    def test_echoed_locus_mismatch_fails(self, assoc):
        rec = good_record()  # channels still name the requested locus; only the echo differs
        rec["locus"] = "right book"
        reason = assoc.validate_association(rec, ITEM, LOCUS)
        assert isinstance(reason, str) and reason

    def test_echoed_item_mismatch_fails(self, assoc):
        rec = good_record()
        rec["item"] = "eggs"
        reason = assoc.validate_association(rec, ITEM, LOCUS)
        assert isinstance(reason, str) and reason


# Covers: MEM-021
# Requirement: D16 - every point carries a non-empty why/apply question and model answer from the same
# association call; a record missing either, or with either blank, is invalid.
class TestD16QuestionAnswer:
    @pytest.mark.parametrize("field", ["question", "answer"])
    def test_missing_field_fails(self, assoc, field):
        rec = good_record()
        del rec[field]
        assert assoc.validate_association(rec, ITEM, LOCUS)

    @pytest.mark.parametrize("field", ["question", "answer"])
    def test_blank_field_fails(self, assoc, field):
        assert assoc.validate_association(good_record(**{field: "  "}), ITEM, LOCUS)


# Covers: MEM-021
# Requirement: a model reply is untrusted - a non-object, an unknown or missing field, a non-string value or
# an oversized reply is rejected by the validator (fixture replay skips the backend schema check), while a
# realistic full-length record still passes.
class TestUntrustedRecordShape:
    @pytest.mark.parametrize(
        "value",
        [None, [], "milk carton", 42, [good_record()]],
        ids=["none", "list", "string", "int", "wrapped-list"],
    )
    def test_non_object_reply_fails(self, assoc, value):
        assert assoc.validate_association(value, ITEM, LOCUS)

    def test_unknown_field_fails(self, assoc):
        rec = good_record(onload="<img src=x onerror=alert(1)>")
        assert assoc.validate_association(rec, ITEM, LOCUS)

    @pytest.mark.parametrize("field", ["visual", "question", "walk_cue", "item"])
    def test_missing_field_fails(self, assoc, field):
        rec = good_record()
        del rec[field]
        assert assoc.validate_association(rec, ITEM, LOCUS)

    @pytest.mark.parametrize(
        "value",
        [7, None, True, ["milk carton"], {"text": "milk carton"}],
        ids=["int", "null", "bool", "list", "dict"],
    )
    def test_non_string_channel_fails(self, assoc, value):
        assert assoc.validate_association(good_record(auditory=value), ITEM, LOCUS)

    def test_oversized_channel_fails(self, assoc):
        huge = f"the {ITEM} on the {LOCUS} " + "A" * 64 * 1024
        assert assoc.validate_association(good_record(visual=huge), ITEM, LOCUS)

    def test_oversized_scene_details_fails(self, assoc):
        huge = "dramatic light " * 8 * 1024
        assert assoc.validate_association(good_record(scene_prompt_details=huge), ITEM, LOCUS)

    def test_realistic_full_length_record_passes(self, assoc):
        pad = " It is vivid and strange." * 10  # ~250 chars per field
        rec = {k: (v if k in ("item", "locus") else v + pad) for k, v in good_record().items()}
        assert assoc.validate_association(rec, ITEM, LOCUS) is None


# Covers: MEM-021
# Requirement: associate() re-checks its inputs: an item over 100 chars, an empty/blank item or an empty
# locus is refused with ValueError before any model call; an item of exactly 100 chars is accepted.
class TestInputCaps:
    def test_max_item_len_is_100(self, assoc):
        assert assoc.MAX_ITEM_LEN == 100

    @pytest.mark.parametrize(
        "item,locus",
        [("x" * 101, LOCUS), ("", LOCUS), ("   ", LOCUS), (ITEM, ""), (ITEM, "  ")],
        ids=["item-101", "item-empty", "item-blank", "locus-empty", "locus-blank"],
    )
    def test_bad_input_raises_before_any_call(self, assoc, item, locus):
        backend = CountingBackend()
        with pytest.raises(ValueError):
            assoc.associate(backend, PROCESSED, item, locus)
        assert backend.calls == 0

    def test_item_of_exactly_100_chars_reaches_the_backend(self, assoc):
        backend = CountingBackend()
        assoc.associate(backend, PROCESSED, "x" * 100, LOCUS)
        assert backend.calls >= 1
