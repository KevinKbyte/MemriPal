# Covers: MEM-101
# Requirement: every MEM id is defined exactly once across the memripal spec cache. A definition
# is a `## MEM-NNN ...` heading (3+ digits; only the heading's first id counts). Body references
# such as `**Superseded by MEM-005**`, `Amends MEM-005`, inline `(MEM-005)`, and non-`## ` lines
# (`### MEM-005`, `- MEM-005`) are not definitions. `scripts/spec_ids.py`'s
# `duplicate_mem_errors(paths)` returns one error per id defined more than once, naming the id
# and every `<file name>:<line number>` that defines it, in ascending id order; a clean tree or
# an empty path list yields []. The real spec cache is clean.
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "spec_ids.py"
CACHE = ROOT / ".claude" / "spec-cache" / "memripal" / "references"


def _load():
    spec = importlib.util.spec_from_file_location("spec_ids_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write(path: Path, lines: list[str]) -> Path:
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_duplicate_within_one_file_is_one_error_naming_both_lines(tmp_path):
    spec = _write(
        tmp_path / "spec.md",
        [
            "# Spec",  # 1
            "",  # 2
            "## MEM-010 First definition",  # 3
            "Body.",  # 4
            "",  # 5
            "## MEM-011 Other",  # 6
            "",  # 7
            "## MEM-010 Second definition",  # 8
        ],
    )
    errors = _load().duplicate_mem_errors([spec])
    assert len(errors) == 1
    assert "MEM-010" in errors[0]
    assert "spec.md:3" in errors[0]
    assert "spec.md:8" in errors[0]
    assert "MEM-011" not in errors[0]


def test_duplicate_across_two_files_names_both_files(tmp_path):
    first = _write(tmp_path / "spec.md", ["# Spec", "## MEM-020 Alpha"])
    second = _write(tmp_path / "spec-2.md", ["# Spec 2", "", "## MEM-021 Beta", "## MEM-020 Alpha again"])
    errors = _load().duplicate_mem_errors([first, second])
    assert len(errors) == 1
    assert "MEM-020" in errors[0]
    assert "spec.md:2" in errors[0]
    assert "spec-2.md:4" in errors[0]


def test_three_definitions_are_all_listed_in_one_error(tmp_path):
    first = _write(tmp_path / "spec.md", ["## MEM-030 A", "## MEM-030 B"])
    second = _write(tmp_path / "spec-2.md", ["## MEM-030 C"])
    errors = _load().duplicate_mem_errors([first, second])
    assert len(errors) == 1
    for location in ("spec.md:1", "spec.md:2", "spec-2.md:1"):
        assert location in errors[0]


def test_errors_are_in_ascending_id_order(tmp_path):
    spec = _write(
        tmp_path / "spec.md",
        ["## MEM-200 Z", "## MEM-099 Y", "## MEM-200 Z2", "## MEM-099 Y2", "## MEM-1000 X", "## MEM-1000 X2"],
    )
    errors = _load().duplicate_mem_errors([spec])
    assert len(errors) == 3
    assert "MEM-099" in errors[0]
    assert "MEM-200" in errors[1]
    assert "MEM-1000" in errors[2]


def test_references_and_non_h2_lines_are_not_definitions(tmp_path):
    spec = _write(
        tmp_path / "spec.md",
        [
            "# Spec",
            "## MEM-005 The only definition",
            "**Superseded by MEM-005**",
            "Amends MEM-005.",
            "See the earlier rule (MEM-005) for context.",
            "### MEM-005 sub-heading",
            "- MEM-005 bullet",
            "#### MEM-005",
            "##MEM-005 no space",
            " ## MEM-005 indented",
        ],
    )
    assert _load().duplicate_mem_errors([spec]) == []


def test_only_the_first_id_in_a_heading_counts(tmp_path):
    spec = _write(
        tmp_path / "spec.md",
        ["## MEM-003 Original", "", "## MEM-007 Foo (supersedes MEM-003)"],
    )
    assert _load().duplicate_mem_errors([spec]) == []


def test_ids_need_at_least_three_digits(tmp_path):
    spec = _write(tmp_path / "spec.md", ["## MEM-12 short", "## MEM-12 short again"])
    assert _load().duplicate_mem_errors([spec]) == []


def test_clean_tree_with_distinct_ids_has_no_errors(tmp_path):
    first = _write(tmp_path / "spec.md", ["## MEM-001 A", "## MEM-002 B"])
    second = _write(tmp_path / "spec-2.md", ["## MEM-003 C", "## MEM-004 D"])
    assert _load().duplicate_mem_errors([first, second]) == []


def test_empty_path_list_has_no_errors():
    assert _load().duplicate_mem_errors([]) == []


def test_real_spec_cache_defines_every_mem_id_once():
    paths = sorted(CACHE.glob("spec*.md"))
    assert paths, f"no spec*.md under {CACHE}"
    assert _load().duplicate_mem_errors(paths) == []
