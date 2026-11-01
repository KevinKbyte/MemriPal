"""Gate a branch touching docs/design/**: re-shoot the design at the tip and check it (MEM-070, ADR-0036).

Usage: uv run --no-project --with playwright --with axe-playwright-python python scripts/design_gate.py \
         --repo <repo> --base <rev> [--tip <rev>] --outdir <dir> --approvals <file> [--evidence <png>]...
A branch whose diff (merge-base..tip) touches no docs/design/** path passes without shooting. Otherwise the
gate renders the preview at the tip (shots kept under <outdir>/tip) and at the merge-base (to find changed
shots), then prints one "FAIL <problem>" line per problem and "OK" (exit 0) or "<n> problem(s)" (exit 1).
Exits 2 on bad usage. Changed shots need an approval recorded by scripts/approve_design.py for this tip and
shot hash; the run manifest it reads is <outdir>/design-gate-run.json.
"""

import argparse
import hashlib
import importlib.util
import io
import json
import posixpath
import re
import subprocess
import sys
import tarfile
import tempfile
from collections.abc import Callable
from functools import partial
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_route_css  # noqa: E402
import screenshot_design  # noqa: E402

DESIGN_PREFIX = "docs/design/"
ROUTE_DIR = "docs/design/route/"
CONTRACT_PATH = "docs/design/route/route-contract.md"
PREVIEW_PATH = "docs/design/route/preview.html"
MAP_SHELL_PAGE = "map-shell.html"
MAP_SCREENS = ("closed", "open", "landmark", "hidden")
# preview.html links ../../../static/*.css, so the render tree needs static/ beside docs/design/.
RENDER_PATHS = ["docs/design", "static"]
PHONE_WIDTH = 375
AXE_RULES = ("color-contrast", "target-size")
MANIFEST = "design-gate-run.json"
FILE_EXTS = "css|js|mjs|ts|html|md|py|svg|png|jpg|json|txt|sh"

Shooter = Callable[[str, str], dict]

_NAME = r"([A-Za-z_][\w-]*)"


def touches_design(paths: list[str]) -> bool:
    return any(p.startswith(DESIGN_PREFIX) for p in paths)


def _names(selector_text: str) -> tuple[set[str], set[str]]:
    return set(re.findall(r"#" + _NAME, selector_text)), set(re.findall(r"\." + _NAME, selector_text))


def css_selector_names(css: str) -> tuple[set[str], set[str]]:
    body = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    ids: set[str] = set()
    classes: set[str] = set()
    # A prelude is the text before a "{"; declaration text is always followed by "}" instead, so values
    # (e.g. color: #fff) never reach the selector scan. @media preludes are skipped; their rules are not.
    for m in re.finditer(r"([^{}]*)\{", body):
        prelude = m.group(1).strip()
        if prelude.startswith("@"):
            continue
        prelude = re.sub(r"\[[^\]]*\]", " ", prelude)
        prelude = re.sub(r"::[\w-]+(\([^)]*\))?", " ", prelude)
        i, c = _names(prelude)
        ids |= i
        classes |= c
    return ids, classes


def contract_names(contract: str) -> tuple[set[str], set[str]]:
    ids: set[str] = set()
    classes: set[str] = set()
    for span in re.findall(r"`([^`]*)`", contract):
        # Paths, URLs, markup and file names (route.css) name no selector.
        if "/" in span or re.search(r"\.(?:" + FILE_EXTS + r")\b", span):
            continue
        i, c = _names(re.sub(r"\[[^\]]*\]", " ", span))
        ids |= i
        classes |= c
    return ids, classes


def _git_ok(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, encoding="utf-8", errors="replace", timeout=120
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout


def _commit(repo: Path, rev: str) -> str:
    return _git_ok(repo, "rev-parse", "--verify", "--end-of-options", rev + "^{commit}").strip()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def gate_plan(route_dir_url: str) -> list[screenshot_design.Shot]:
    """screenshot_design's preview plan, then the map-first home's screens per width and theme."""
    plan = screenshot_design.shot_plan(
        route_dir_url + "/" + Path(PREVIEW_PATH).name,
        screenshot_design.DEFAULT_SCREENS,
        screenshot_design.DEFAULT_WIDTHS,
        screenshot_design.DEFAULT_THEMES,
    )
    return plan + [
        screenshot_design.Shot(
            f"{route_dir_url}/{MAP_SHELL_PAGE}?s={s}" + ("&theme=dark" if t == "dark" else ""),
            f"s{s}_{name}_{t}.png",
            viewport,
        )
        for name, viewport in screenshot_design.DEFAULT_WIDTHS
        for t in screenshot_design.DEFAULT_THEMES
        for s in MAP_SCREENS
    ]


def real_shoot(repo: Path, rev: str, outdir: str) -> dict:
    """Render the route pages at `rev` per gate_plan; collect overflow, axe and DOM names."""
    # Lazy imports: the gate must import (and be tested) where playwright is absent.
    from playwright.sync_api import sync_playwright

    spec = importlib.util.find_spec("axe_playwright_python")
    if spec is None or spec.origin is None:
        return {"errors": ["axe-core unavailable: run with --with axe-playwright-python"], "shots": []}
    axe_js = (Path(spec.origin).parent / "axe.min.js").read_text(encoding="utf-8")

    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    # Binary tar stream, so no text encoding here.
    archive = subprocess.run(
        ["git", "-C", str(repo), "archive", "--format=tar", rev, "--", *RENDER_PATHS],
        capture_output=True,
        timeout=120,
    )
    if archive.returncode != 0:
        detail = archive.stderr.decode("utf-8", "replace").strip()
        return {"errors": [f"git archive {rev}: {detail}"], "shots": []}
    errors: list[str] = []
    shots: list[dict] = []
    with tempfile.TemporaryDirectory() as tree:
        with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as tar:
            tar.extractall(tree, filter="data")
        route_dir = Path(tree) / ROUTE_DIR
        plan = gate_plan(route_dir.as_uri())

        def page(shot) -> str:
            return shot.url.split("?", 1)[0].rsplit("/", 1)[1]

        # A page absent at `rev` (e.g. a merge-base older than preview-2.html) skips only its own shots.
        absent = {page(s) for s in plan if not (route_dir / page(s)).is_file()}
        errors += [f"{ROUTE_DIR}{name} absent at {rev}" for name in sorted(absent)]
        plan = [s for s in plan if page(s) not in absent]
        if not plan:
            return {"errors": errors, "shots": []}
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", args=["--disable-gpu"])
            try:
                # Shots must settle (ADR 0036 amendment 2026-11-01): lm-float animates infinitely otherwise.
                page = browser.new_page(reduced_motion="reduce")
                page.on("pageerror", lambda exc: errors.append(str(exc)))
                page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
                for shot in plan:
                    page.set_viewport_size({"width": shot.viewport[0], "height": shot.viewport[1]})
                    page.goto(shot.url, wait_until="networkidle")
                    page.wait_for_timeout(screenshot_design.SETTLE_MS)
                    page.screenshot(path=str(out / shot.filename), full_page=True)
                    page.add_script_tag(content=axe_js)
                    shots.append(
                        {
                            "filename": shot.filename,
                            "viewport": list(shot.viewport),
                            "scroll_width": page.evaluate("document.documentElement.scrollWidth"),
                            "axe": page.evaluate(
                                "async r => (await axe.run(document, {runOnly: {type: 'rule', values: r}}))"
                                ".violations.map(v => v.id)",
                                list(AXE_RULES),
                            ),
                            "ids": page.evaluate("[...document.querySelectorAll('[id]')].map(e => e.id)"),
                            "classes": page.evaluate(
                                "[...new Set([...document.querySelectorAll('[class]')]"
                                ".flatMap(e => [...e.classList]))]"
                            ),
                        }
                    )
            finally:
                browser.close()
    return {"errors": errors, "shots": shots}


def load_approvals(path: Path) -> set[tuple[str, str, str]]:
    """{(tip, shot, sha256)}; a missing file is no approvals. Raises ValueError when unreadable."""
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {(a["tip"], a["shot"], a["sha256"]) for a in data["approvals"]}
    except (ValueError, KeyError, TypeError) as exc:
        raise ValueError(f"approvals file {path.name} unreadable ({type(exc).__name__})") from exc


def _parse(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="design_gate.py")
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--base", required=True)
    parser.add_argument("--tip", default="HEAD")
    parser.add_argument("--outdir", required=True, type=Path)
    parser.add_argument("--approvals", required=True, type=Path)
    parser.add_argument("--evidence", action="append", default=[], type=Path)
    args = parser.parse_args(argv)  # bad usage: SystemExit(2)
    if not args.repo.is_dir():
        parser.error(f"--repo {args.repo} is not a directory")
    for flag in ("base", "tip"):
        rev = getattr(args, flag)
        # A rev starting with "-" would be read by git as an option.
        if not rev or rev.startswith("-") or any(c.isspace() or ord(c) < 32 for c in rev):
            parser.error(f"--{flag} {rev!r} is not a valid revision")
    if args.outdir.exists() and not args.outdir.is_dir():
        parser.error(f"--outdir {args.outdir} is not a directory")
    if args.approvals.is_dir():
        parser.error(f"--approvals {args.approvals} is a directory")
    return args


def _render_problems(render: dict, tip_dir: Path) -> tuple[list[str], dict[str, str]]:
    """Problems in the tip render itself, plus {filename: sha256} of every shot on disk."""
    problems = [f"render error: {e}" for e in render.get("errors", [])]
    shots = render.get("shots", [])
    if not shots:
        problems.append("no shots rendered at tip")
    hashes: dict[str, str] = {}
    for shot in shots:
        name = shot["filename"]
        path = tip_dir / name
        if Path(name).name != name or not path.is_file():
            problems.append(f"shot {name} missing from {tip_dir}")
            continue
        hashes[name] = _sha256(path)
        if shot["viewport"][0] == PHONE_WIDTH and shot["scroll_width"] > PHONE_WIDTH:
            problems.append(f"overflow: {name} scroll width {shot['scroll_width']} > {PHONE_WIDTH}")
        for rule in shot.get("axe", []):
            if rule in AXE_RULES:
                problems.append(f"axe {rule}: {name}")
    return problems, hashes


def linked_route_css(preview_html: str) -> list[str]:
    """Repo paths of the stylesheets preview.html links that stay inside ROUTE_DIR, in link order."""
    paths = []
    for tag in re.findall(r"<link\b[^>]*>", preview_html, flags=re.I):
        href = re.search(r"\bhref\s*=\s*[\"']([^\"']+)[\"']", tag, flags=re.I)
        if not href or not re.search(r"\brel\s*=\s*[\"']?stylesheet\b", tag, flags=re.I):
            continue
        # Rooted (/x) and scheme (https:) hrefs, and any that normalise out of the dir, are not route CSS.
        path = posixpath.normpath(ROUTE_DIR + href.group(1))
        if not re.match(r"(/|[a-z][a-z0-9+.-]*:)", href.group(1), flags=re.I) and path.startswith(ROUTE_DIR):
            paths.append(path)
    return paths


def _route_css(repo: Path, tip: str) -> tuple[str, list[str]]:
    """The tip's route CSS (preview.html's in-dir sheets, concatenated) plus a problem per missing sheet."""
    sheets: list[str] = []
    problems: list[str] = []
    for path in linked_route_css(_git_ok(repo, "show", f"{tip}:{PREVIEW_PATH}")):
        try:
            sheets.append(_git_ok(repo, "show", f"{tip}:{path}"))
        except RuntimeError:
            problems.append(f"{path} linked from {PREVIEW_PATH} but missing at tip {tip[:12]}")
    return "\n".join(sheets), problems


def _name_problems(repo: Path, tip: str, render: dict) -> list[str]:
    try:
        css, problems = _route_css(repo, tip)
        contract = _git_ok(repo, "show", f"{tip}:{CONTRACT_PATH}")
    except RuntimeError as exc:
        return [f"route css/contract unreadable at tip: {exc}"]
    problems += [f"route css: {e}" for e in check_route_css.check(css, contract)]
    css_ids, css_classes = css_selector_names(css)
    doc_ids, doc_classes = contract_names(contract)
    dom_ids = {i for s in render.get("shots", []) for i in s.get("ids", [])}
    dom_classes = {c for s in render.get("shots", []) for c in s.get("classes", [])}
    problems += [f"#{i} not in rendered DOM" for i in sorted((css_ids | doc_ids) - dom_ids)]
    problems += [f".{c} not in rendered DOM" for c in sorted((css_classes | doc_classes) - dom_classes)]
    return problems


def _evidence_problems(evidence: list[Path], tip: str, hashes: dict[str, str]) -> list[str]:
    produced = set(hashes.values())
    problems = []
    for path in evidence:
        if not path.is_file():
            problems.append(f"evidence {path.name} missing")
        elif path.suffix.lower() != ".png" or _sha256(path) not in produced:
            problems.append(f"evidence {path.name} is not a shot this gate rendered at tip {tip[:12]}")
    return problems


def _changed_shots(hashes: dict[str, str], base_render: dict, base_dir: Path) -> dict[str, str]:
    base_names = {s["filename"] for s in base_render.get("shots", [])}
    return {
        name: digest
        for name, digest in hashes.items()
        if name not in base_names or not (base_dir / name).is_file() or _sha256(base_dir / name) != digest
    }


def main(argv: list[str], shoot: Shooter | None = None) -> int:
    args = _parse(argv)
    repo = args.repo.resolve()
    try:
        tip = _commit(repo, args.tip)
        merge_base = _git_ok(repo, "merge-base", _commit(repo, args.base), tip).strip()
        changed_paths = _git_ok(repo, "diff", "--name-only", "-z", merge_base, tip, "--").split("\0")
    except RuntimeError as exc:
        print(f"design_gate: {exc}", file=sys.stderr)
        return 2
    if not touches_design([p for p in changed_paths if p]):
        print("OK")
        return 0

    shoot = shoot or partial(real_shoot, repo)
    tip_dir = args.outdir / "tip"
    render = shoot(tip, str(tip_dir))
    problems, hashes = _render_problems(render, tip_dir)
    # The base render only feeds the changed-shot comparison, so it lives in a throwaway dir.
    with tempfile.TemporaryDirectory() as base_dir:
        changed = _changed_shots(hashes, shoot(merge_base, base_dir), Path(base_dir))
    problems += _name_problems(repo, tip, render)
    problems += _evidence_problems(args.evidence, tip, hashes)

    args.outdir.mkdir(parents=True, exist_ok=True)
    (args.outdir / MANIFEST).write_text(
        json.dumps({"tip": tip, "changed": changed}, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    try:
        approvals = load_approvals(args.approvals)
    except ValueError as exc:
        problems.append(f"{exc}; treating as no approvals")
        approvals = set()
    problems += [
        f"{name} changed at tip {tip[:12]} without an approval (scripts/approve_design.py {args.outdir})"
        for name, digest in sorted(changed.items())
        if (tip, name, digest) not in approvals
    ]

    for p in problems:
        print("FAIL", p)
    print("OK" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
