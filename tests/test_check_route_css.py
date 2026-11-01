# Covers: MEM-067
# Requirement: scripts/check_route_css.py mechanically checks the route design CSS against the
# design prompt's hard constraints: check(css, contract) returns the sorted unique problem
# strings (non-ASCII, unknown var() tokens outside comments, custom property definitions,
# hex/functional/named colours, url/@font-face/@import, banned properties, display rules whose
# last compound lacks :not([hidden]) except pseudo-elements, unknown ids, classes absent from the
# contract's backticked spans or literal text, bare element selectors outside ELEMENT_OK);
# main(argv) takes one or more css paths then the contract (last arg), checks the css files
# concatenated in the given order, prints FAIL lines plus "<n> problem(s)" (exit 1) or "OK"
# (exit 0), and exits 2 with a usage line on stderr for fewer than 2 args.
import importlib.util
import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "check_route_css.py"
ROUTE_DIR = REPO_ROOT / "docs" / "design" / "route"
ROUTE_CONTRACT = ROUTE_DIR / "route-contract.md"

ELEMENT_OK = ["a", "circle", "text", "li", "ol", "dt", "dd", "legend", "summary", "img", "input"]
BANNED_PROPS = ["transform", "filter", "contain", "perspective", "will-change", "backdrop-filter"]


def _load():
    spec = importlib.util.spec_from_file_location("check_route_css_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(css, contract=""):
    return _load().check(css, contract)


class TestCheckClean:
    def test_clean_rule_returns_empty_list(self):
        assert check("#status:not([hidden]) { display: block; color: var(--ink); }\n") == []

    def test_empty_css_returns_empty_list(self):
        assert check("") == []

    def test_contract_class_with_allowed_tokens_is_clean(self):
        css = ".btn { color: var(--on-primary); background: var(--primary); }\n"
        assert check(css, "Buttons use `btn toggle`.") == []

    def test_rule_inside_media_query_is_clean(self):
        css = "@media (min-width: 600px) {\n  #status { color: var(--ink); }\n}\n"
        assert check(css) == []


class TestCheckRules:
    def test_non_ascii_character(self):
        assert check("/* caf\u00e9 */\n") == ["non-ASCII character"]

    def test_unknown_token(self):
        assert check("#status { color: var(--brand); }\n") == ["token --brand"]

    def test_unknown_token_inside_comment_is_ignored(self):
        assert check("/* var(--brand) */\n#status { color: var(--ink); }\n") == []

    def test_defines_custom_property(self):
        assert check("#status {\n  --brand: 1px;\n}\n") == ["defines a custom property"]

    def test_hex_colour(self):
        assert check("#status { color: #fff; }\n") == ["hex colour"]

    @pytest.mark.parametrize(
        "value",
        [
            "rgb(0 0 0)",
            "rgba(0, 0, 0, 1)",
            "hsl(0 0% 0%)",
            "hsla(0, 0%, 0%, 1)",
            "oklch(0 0 0)",
            "lab(0 0 0)",
            "lch(0 0 0)",
        ],
    )
    def test_functional_colour(self, value):
        assert check(f"#status {{ color: {value}; }}\n") == ["functional colour"]

    @pytest.mark.parametrize("name", ["white", "black", "transparent", "red", "blue"])
    def test_named_colour(self, name):
        assert check(f"#status {{ color: {name}; }}\n") == ["named colour"]

    @pytest.mark.parametrize(
        "css",
        [
            "#status { background: url(a.png); }\n",
            "@font-face { font-family: x; }\n",
            '@import "a.css";\n',
        ],
    )
    def test_url_font_face_import(self, css):
        assert check(css) == ["url/@font-face/@import"]

    @pytest.mark.parametrize("prop", BANNED_PROPS)
    def test_banned_property(self, prop):
        assert check(f"#status {{ {prop}: none; }}\n") == [f"banned property {prop} in #status"]

    def test_display_without_not_hidden(self):
        assert check("#status { display: block; }\n") == ["display without :not([hidden]): #status"]

    def test_display_flags_only_the_unguarded_selector_in_a_list(self):
        css = "#status, #meta-notice:not([hidden]) { display: grid; }\n"
        assert check(css) == ["display without :not([hidden]): #status"]

    def test_display_guard_must_be_on_the_last_compound(self):
        css = "#status:not([hidden]) li { display: block; }\n"
        assert check(css) == ["display without :not([hidden]): #status:not([hidden]) li"]

    def test_display_on_pseudo_element_is_exempt(self):
        assert check("#status::before { display: block; }\n") == []

    def test_unknown_id(self):
        assert check("#nope { color: var(--ink); }\n") == ["unknown id #nope"]

    def test_class_missing_from_contract(self):
        assert check(".ghost { color: var(--ink); }\n") == ["class .ghost missing from contract"]

    def test_bare_element_selector(self):
        assert check("div { color: var(--ink); }\n") == ["bare element selector div in div"]

    def test_bare_element_after_id(self):
        assert check("#status span { color: var(--ink); }\n") == [
            "bare element selector span in #status span"
        ]

    @pytest.mark.parametrize("element", ELEMENT_OK)
    def test_element_ok_is_exempt(self, element):
        assert check(f"#loci {element} {{ color: var(--ink); }}\n") == []


class TestContractClassMatching:
    @pytest.mark.parametrize(
        "contract",
        [
            "Use `btn ghost` here.",
            "Use `h2.ghost` here.",
            "Use `row#ghost` here.",
            "Use `#status>ghost` here.",
            "Use `btn,ghost` here.",
            "Use `btn;ghost` here.",
            "Plain prose naming .ghost outside backticks.",
        ],
    )
    def test_class_named_in_contract_is_accepted(self, contract):
        assert check(".ghost { color: var(--ink); }\n", contract) == []

    @pytest.mark.parametrize(
        "contract",
        [
            "",
            "Use `ghostly` here.",
            "The word ghost without a dot or backticks.",
        ],
    )
    def test_class_not_named_in_contract_is_reported(self, contract):
        assert check(".ghost { color: var(--ink); }\n", contract) == ["class .ghost missing from contract"]


class TestCheckOutputShape:
    def test_duplicate_problems_are_reported_once(self):
        css = ".ghost { color: var(--brand); background: var(--brand); }\n.ghost { color: var(--ink); }\n"
        assert check(css) == ["class .ghost missing from contract", "token --brand"]

    def test_problems_are_sorted(self):
        css = "#nope { transform: none; }\n.ghost { color: var(--brand); }\n"
        assert check(css) == [
            "banned property transform in #nope",
            "class .ghost missing from contract",
            "token --brand",
            "unknown id #nope",
        ]

    def test_returns_a_list(self):
        assert isinstance(check("#nope { color: var(--ink); }\n"), list)


def _write(tmp_path, css, contract):
    css_path = tmp_path / "route.css"
    contract_path = tmp_path / "route-contract.md"
    css_path.write_bytes(css.encode("utf-8"))
    contract_path.write_bytes(contract.encode("utf-8"))
    return [str(css_path), str(contract_path)]


class TestMain:
    @pytest.mark.parametrize("argv", [[], ["route.css"]])
    def test_wrong_arg_count_exits_2_with_usage(self, argv, capsys):
        try:
            code = _load().main(argv)
        except SystemExit as exc:  # argparse-style exit is an equally valid exit 2
            code = exc.code
        assert code == 2
        assert "usage" in capsys.readouterr().err.lower()

    def test_problems_print_fail_lines_and_count_exit_1(self, tmp_path, capsys):
        argv = _write(tmp_path, "#nope { color: var(--brand); }\n", "")
        assert _load().main(argv) == 1
        assert capsys.readouterr().out.splitlines() == [
            "FAIL token --brand",
            "FAIL unknown id #nope",
            "2 problem(s)",
        ]

    def test_clean_prints_ok_exit_0(self, tmp_path, capsys):
        argv = _write(tmp_path, "#status { color: var(--ink); }\n", "")
        assert _load().main(argv) == 0
        assert capsys.readouterr().out.splitlines() == ["OK"]

    def test_reads_css_as_utf8(self, tmp_path, capsys):
        argv = _write(tmp_path, "/* \u0441 */\n#status { color: var(--ink); }\n", "")
        assert _load().main(argv) == 1
        assert capsys.readouterr().out.splitlines() == ["FAIL non-ASCII character", "1 problem(s)"]

    def test_reads_contract_as_utf8(self, tmp_path, capsys):
        argv = _write(tmp_path, ".ghost { color: var(--ink); }\n", "\u0441 uses `ghost` \u2014 ok\n")
        assert _load().main(argv) == 0
        assert capsys.readouterr().out.splitlines() == ["OK"]

    def test_several_css_files_are_all_checked(self, tmp_path, capsys):
        sheets = []
        for name, css in [
            ("a.css", "#status { color: var(--ink); }\n"),
            ("b.css", "#loci { color: var(--brand); }\n"),
            ("c.css", "#nope { color: var(--ink); }\n"),
        ]:
            path = tmp_path / name
            path.write_bytes(css.encode("utf-8"))
            sheets.append(str(path))
        contract = tmp_path / "route-contract.md"
        contract.write_bytes(b"")
        assert _load().main([*sheets, str(contract)]) == 1
        assert capsys.readouterr().out.splitlines() == [
            "FAIL token --brand",
            "FAIL unknown id #nope",
            "2 problem(s)",
        ]

    def test_contract_is_the_last_arg_not_a_css_file(self, tmp_path, capsys):
        first, second, contract = tmp_path / "a.css", tmp_path / "b.css", tmp_path / "contract.md"
        first.write_bytes(b"#status { color: var(--ink); }\n")
        second.write_bytes(b".ghost { color: var(--ink); }\n")
        contract.write_bytes(b"Use `ghost` here.\n")
        assert _load().main([str(first), str(second), str(contract)]) == 0
        assert capsys.readouterr().out.splitlines() == ["OK"]


# Covers: MEM-072
# Requirement: every hand-authored (git-tracked) docs/design/route/ file with suffix .css or .html
# is under 500 lines, and the shipped route CSS set (the stylesheets preview.html links whose href
# is relative and stays inside docs/design/route/, in link order) passes check_route_css against
# route-contract.md.
LINE_CAP = 500
STYLESHEET = re.compile(r"<link\s+rel=\"stylesheet\"\s+href=\"([^\"]+)\"")


def _tracked_route_design_files():
    out = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "ls-files", "-z", "--", "docs/design/route"],
        capture_output=True,
        encoding="utf-8",
        check=True,
        timeout=60,
    ).stdout
    return [REPO_ROOT / p for p in out.split("\0") if p.endswith((".css", ".html"))]


def _shipped_route_css():
    preview = (ROUTE_DIR / "preview.html").read_text(encoding="utf-8")
    hrefs = STYLESHEET.findall(preview)
    return [ROUTE_DIR / h for h in hrefs if not re.match(r"(\.\./|/|[a-z][a-z0-9+.-]*:)", h, re.I)]


class TestShippedRouteDesign:
    def test_route_design_css_and_html_files_are_under_500_lines(self):
        files = _tracked_route_design_files()
        assert files, "no tracked .css/.html under docs/design/route"
        counts = {f.name: len(f.read_text(encoding="utf-8").splitlines()) for f in files}
        too_long = {name: n for name, n in counts.items() if n >= LINE_CAP}
        assert too_long == {}, f"files at or over {LINE_CAP} lines: {too_long}"

    def test_shipped_route_css_passes_against_its_contract(self, capsys):
        sheets = _shipped_route_css()
        assert sheets, "preview.html links no route stylesheet"
        assert _load().main([*map(str, sheets), str(ROUTE_CONTRACT)]) == 0
        assert capsys.readouterr().out.splitlines() == ["OK"]
