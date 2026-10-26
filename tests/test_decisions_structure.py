# Requirement: every architectural decision is recorded as an ADR in
# docs/decisions/NNNN-slug.md (repo CLAUDE.md "Architecture decisions"). Each ADR
# carries Status: and Date: lines and the sections Context, Options considered,
# Decision, Why this over the others, Consequences, in that order; Options
# considered lists at least two options, each with a Pros: and a Cons: line (the
# only exceptions are ADRs explicitly marked "Alternatives not formally
# evaluated"); every ADR is linked from docs/decisions/README.md, every README
# link resolves to an existing file, and ADR numbers are unique and contiguous
# from 0001.
import re
import shutil
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
DECISIONS = REPO / "docs" / "decisions"

HEADINGS = [
    "## Context",
    "## Options considered",
    "## Decision",
    "## Why this over the others",
    "## Consequences",
]
ADR_NAME = re.compile(r"^(\d{4})-[a-z0-9-]+\.md$")
LINK = re.compile(r"\]\(([^)\s]+)\)")
NO_ALTERNATIVES = "Alternatives not formally evaluated"
# ADRs whose decision was taken without a recorded comparison; each must say so
# with NO_ALTERNATIVES in its Options considered section.
SINGLE_OPTION_EXCEPTIONS = {"0005", "0009"}


def _adr_files(root):
    return sorted(p for p in root.glob("*.md") if ADR_NAME.match(p.name))


def _section(lines, heading):
    start = lines.index(heading) + 1
    end = next(
        (i for i in range(start, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )
    return lines[start:end]


def structure_errors(path):
    lines = path.read_text(encoding="utf-8").splitlines()
    errors = []
    for prefix in ("Status:", "Date:"):
        if not any(line.startswith(prefix) for line in lines):
            errors.append(f"{path.name}: missing {prefix} line")
    found = [line for line in lines if line in HEADINGS]
    if found != HEADINGS:
        errors.append(f"{path.name}: headings {found} != {HEADINGS}")
        return errors
    body = _section(lines, "## Options considered")
    options = []
    for line in body:
        if line.startswith("- "):
            options.append([line])
        elif options:
            options[-1].append(line)
    number = ADR_NAME.match(path.name).group(1)
    min_options = 2
    if number in SINGLE_OPTION_EXCEPTIONS and NO_ALTERNATIVES in "\n".join(body):
        min_options = 1
    if len(options) < min_options:
        errors.append(f"{path.name}: {len(options)} option(s), need >= {min_options}")
    for option in options:
        stripped = [line.strip() for line in option]
        for label in ("Pros:", "Cons:"):
            if not any(line.startswith(label) for line in stripped):
                errors.append(f"{path.name}: option {option[0]!r} has no {label} line")
    return errors


def index_errors(root):
    readme = root / "README.md"
    targets = LINK.findall(readme.read_text(encoding="utf-8"))
    errors = [f"README link {t} does not resolve" for t in targets if not (root / t).is_file()]
    linked = {Path(t).name for t in targets}
    errors += [f"{p.name} not linked from README" for p in _adr_files(root) if p.name not in linked]
    return errors


def numbering_errors(root):
    numbers = [int(ADR_NAME.match(p.name).group(1)) for p in _adr_files(root)]
    if len(numbers) != len(set(numbers)):
        return [f"duplicate ADR numbers: {sorted(numbers)}"]
    if sorted(numbers) != list(range(1, len(numbers) + 1)):
        return [f"ADR numbers not contiguous from 1: {sorted(numbers)}"]
    return []


def test_decisions_dir_has_adrs():
    assert _adr_files(DECISIONS)


@pytest.mark.parametrize("adr", _adr_files(DECISIONS), ids=lambda p: p.name)
def test_adr_structure(adr):
    assert structure_errors(adr) == []


def test_readme_links_every_adr_and_resolves():
    assert index_errors(DECISIONS) == []


def test_adr_numbers_unique_and_contiguous():
    assert numbering_errors(DECISIONS) == []


GOOD_ADR = """# 0001: Example

Status: Accepted
Date: 2026-10-26

## Context

Why.

## Options considered

- A.
  Pros: fast.
  Cons: costly.
- B.
  Pros: cheap.
  Cons: slow.

## Decision

A.

## Why this over the others

Speed.

## Consequences

- Cost.
"""


@pytest.fixture
def adr_dir(tmp_path):
    (tmp_path / "0001-example.md").write_text(GOOD_ADR, encoding="utf-8")
    (tmp_path / "README.md").write_text("- [0001](0001-example.md) Example.\n", encoding="utf-8")
    return tmp_path


def test_well_formed_fixture_passes(adr_dir):
    adr = adr_dir / "0001-example.md"
    assert structure_errors(adr) == []
    assert index_errors(adr_dir) == []
    assert numbering_errors(adr_dir) == []


@pytest.mark.parametrize(
    "old,new",
    [
        ("## Consequences\n", ""),
        ("Status: Accepted\n", ""),
        ("Date: 2026-10-26\n", ""),
    ],
    ids=["missing-heading", "missing-status", "missing-date"],
)
def test_missing_field_fails(adr_dir, old, new):
    adr = adr_dir / "0001-example.md"
    adr.write_text(GOOD_ADR.replace(old, new), encoding="utf-8")
    assert structure_errors(adr)


def test_headings_out_of_order_fail(adr_dir):
    adr = adr_dir / "0001-example.md"
    swapped = GOOD_ADR.replace("## Decision\n", "## TMP\n")
    swapped = swapped.replace("## Context\n", "## Decision\n").replace("## TMP\n", "## Context\n")
    adr.write_text(swapped, encoding="utf-8")
    assert structure_errors(adr)


def test_single_option_fails(adr_dir):
    adr = adr_dir / "0001-example.md"
    adr.write_text(GOOD_ADR.replace("- B.\n  Pros: cheap.\n  Cons: slow.\n", ""), encoding="utf-8")
    assert structure_errors(adr)


def test_single_option_marker_without_exception_fails(adr_dir):
    adr = adr_dir / "0001-example.md"
    text = GOOD_ADR.replace("- B.\n  Pros: cheap.\n  Cons: slow.\n", "")
    text = text.replace("## Options considered\n", f"## Options considered\n\n{NO_ALTERNATIVES}.\n")
    adr.write_text(text, encoding="utf-8")
    assert structure_errors(adr)


@pytest.mark.parametrize("label", ["Pros:", "Cons:"])
def test_option_missing_pros_or_cons_fails(adr_dir, label):
    adr = adr_dir / "0001-example.md"
    line = "  Pros: cheap.\n" if label == "Pros:" else "  Cons: slow.\n"
    adr.write_text(GOOD_ADR.replace(line, ""), encoding="utf-8")
    assert any(label in e for e in structure_errors(adr))


def test_unlinked_adr_fails(adr_dir):
    (adr_dir / "0002-other.md").write_text(GOOD_ADR, encoding="utf-8")
    assert any("0002-other.md not linked" in e for e in index_errors(adr_dir))


def test_dangling_readme_link_fails(adr_dir):
    readme = adr_dir / "README.md"
    readme.write_text(readme.read_text(encoding="utf-8") + "- [0009](0009-gone.md)\n", encoding="utf-8")
    assert any("0009-gone.md does not resolve" in e for e in index_errors(adr_dir))


def test_numbering_gap_fails(adr_dir):
    shutil.copy(adr_dir / "0001-example.md", adr_dir / "0003-gap.md")
    assert numbering_errors(adr_dir)


def test_duplicate_number_fails(adr_dir):
    shutil.copy(adr_dir / "0001-example.md", adr_dir / "0001-dup.md")
    assert any("duplicate" in e for e in numbering_errors(adr_dir))
