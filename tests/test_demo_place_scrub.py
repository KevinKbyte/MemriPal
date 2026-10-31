# Covers: MEM-047
# Requirement: the offline demo place carries neutral text, never war-site text.
# The demo place title is the placeholder "Demo route" (B10 replaces it with the
# chosen public place), and no demo place title or recorded extract the fixture
# generator owns matches a deterministic war-term denylist. Across README.md,
# docs/, static/, src/, scripts/ and .claude/spec-cache/ (CHANGELOG history and
# fixtures/ excluded) `git grep -i -E "round top|gettysburg|battle"` finds nothing.
import importlib.util
import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "make_synthetic_fixtures.py"

# Deterministic war-term denylist: whole words/phrases, case-insensitive.
WAR_TERMS = (
    "war",
    "wars",
    "civil war",
    "battle",
    "battles",
    "battlefield",
    "gettysburg",
    "round top",
    "confederate",
    "union army",
    "troops",
    "assault",
    "siege",
    "massacre",
    "combat",
    "infantry",
    "artillery",
)
WAR_RE = re.compile(r"\b(?:" + "|".join(re.escape(t) for t in WAR_TERMS) + r")\b", re.IGNORECASE)

SCRUB_PATTERN = "round top|gettysburg|battle"
SCRUB_SCOPE = ["README.md", "docs", "static", "src", "scripts", ".claude/spec-cache"]
# The plan that states criterion (1) quotes the pattern itself; it is the criterion, not demo text.
SCRUB_EXCLUDE = [
    ":(exclude)fixtures",
    ":(exclude,glob)**/CHANGELOG*",
    ":(exclude)docs/plans/2026-10-31-map-to-palace.md",
]


def _war_hits(text):
    return [m.group(0) for m in WAR_RE.finditer(text)]


@pytest.fixture(scope="module")
def generator():
    spec = importlib.util.spec_from_file_location("msf_demo_place_scrub", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_denylist_flags_the_old_war_site_text():
    assert _war_hits("Little Round Top") == ["Round Top"]
    assert _war_hits("the second day of the Battle of Gettysburg") == ["Battle", "Gettysburg"]
    assert _war_hits("American Civil War") == ["Civil War"]
    assert _war_hits("Demo route") == []
    assert _war_hits("Taneytown Road, warm hardware store") == []


def test_demo_place_title_is_the_neutral_placeholder(generator):
    title, _distance = generator.PLACE_HITS[0]
    assert title == "Demo route"


def test_demo_place_titles_pass_the_war_term_denylist(generator):
    hits = {title: _war_hits(title) for title, _distance in generator.PLACE_HITS}
    assert {t: h for t, h in hits.items() if h} == {}


def test_demo_place_extracts_pass_the_war_term_denylist(generator):
    hits = {title: _war_hits(text) for title, text in generator.PLACE_EXTRACTS.items()}
    assert {t: h for t, h in hits.items() if h} == {}


def test_every_demo_place_hit_has_an_extract(generator):
    titles = [title for title, _distance in generator.PLACE_HITS]
    assert titles
    assert set(titles) <= set(generator.PLACE_EXTRACTS)


def test_no_war_site_text_in_scrub_scope():
    result = subprocess.run(
        ["git", "grep", "-n", "-i", "-E", SCRUB_PATTERN, "--", *SCRUB_SCOPE, *SCRUB_EXCLUDE],
        cwd=str(REPO),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    # git grep: exit 1 = no match, 0 = matches, anything else = grep itself failed.
    assert result.returncode in (0, 1), result.stderr
    assert result.stdout.splitlines() == []
