"""Mechanically check the route design CSS against the design prompt's hard constraints (MEM-067).

Usage: uv run python scripts/check_route_css.py <css>... <contract>
  e.g. uv run python scripts/check_route_css.py docs/design/route/route.css \
         docs/design/route/route-s1-s2.css docs/design/route/route-s3.css \
         docs/design/route/route-s4-s5.css docs/design/route/route-s6-s9.css \
         docs/design/route/route-contract.md
The css files are checked concatenated in the given order (preview.html's link order); the contract is
the last argument. Prints one "FAIL <problem>" line per problem, then "OK" (exit 0) or
"<n> problem(s)" (exit 1). Exits 2 on bad usage.
"""

import re
import sys

USAGE = "usage: check_route_css.py <css>... <contract>"

ALLOWED_TOKENS = set(
    "bg surface surface-2 ink muted line primary on-primary lamp lamp-ink lamp-soft ok ok-soft "
    "bad bad-soft on-bad focus shadow display body mono".split()
)
ALLOWED_IDS = set(
    """
public-banner status meta-notice photo passcode auto load-demo place-settings place-toggle
place-typed places upload-status empty-state scene-wrap scene loci assoc-status associations route-review
route route-undo generate scenes walk walk-step walk-prev walk-next recall recall-start recall-replay
recall-typed recall-submit recall-live recall-results history rehearsals rehearsal-undo history-view
hit-rates backup backup-export backup-import backup-status scene-overlay routes-home routes-list
routes-new routes-settings capture-session capture-safety capture-safety-ok capture-strip
capture-locate capture-finish capture-count station-card station-baseline-optin
station-baseline-status station-baseline station-baseline-img station-baseline-credit station-name
station-name-error station-profile station-taps tap-sound tap-smell tap-feel tap-mood tap-turn
station-save station-drop station-drop-confirm station-drop-cancel station-undo
finish-name finish-kind finish-save route-view route-map route-view-stations route-view-practice
route-view-baseline route-view-lists route-view-add-list route-view-in-use route-view-delete
route-view-delete-confirm route-view-delete-cancel route-view-undo list-panel list-name list-notes
list-split list-retire list-retire-confirm list-retire-cancel list-retire-undo recall-mode recall-map
history-intrusions route-edit route-live route-toast route-toast-text""".split()
)
BANNED_PROPS = ("transform", "filter", "contain", "perspective", "will-change", "backdrop-filter")
# SVG children of .route-map are the only element-type selectors allowed (circle/text/polyline written
# by the engineer); li/ol/dt/dd/legend/summary/img/input appear only under a contract class or id.
ELEMENT_OK = set("a circle text li ol dt dd legend summary img input".split())


def check(css: str, contract: str) -> list[str]:
    errs = []
    # Backticked class lists like `btn toggle` or `h2.screen-title` name each class they contain.
    contract_words = set()
    for span in re.findall(r"`([^`]*)`", contract):
        contract_words.update(re.split(r"[\s.#>,;]+", span))
    if any(ord(c) > 127 for c in css):
        errs.append("non-ASCII character")
    body = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    for m in re.finditer(r"var\(--([a-z0-9-]+)\)", body):
        if m.group(1) not in ALLOWED_TOKENS:
            errs.append(f"token --{m.group(1)}")
    if re.search(r"^\s*--[a-z]", body, re.M):
        errs.append("defines a custom property")
    # Selectors like #status also look like hex, so require a hex value inside a declaration.
    if re.search(
        r"#[0-9a-fA-F]{3,8}\b(?![\w-])", re.sub(r"[^{}]*\{", "{", body).replace("{", "")
    ) and re.search(r":\s*[^;{}]*#[0-9a-fA-F]{3,8}\s*[;}]", body):
        errs.append("hex colour")
    if re.search(r"\b(rgba?|hsla?|oklch|lab|lch)\(", body):
        errs.append("functional colour")
    if re.search(r":\s*[^;{}]*\b(white|black|transparent|red|blue)\b", body):
        errs.append("named colour")
    if "url(" in body or "@font-face" in body or "@import" in body:
        errs.append("url/@font-face/@import")
    for rule in re.finditer(r"([^{}]+)\{([^{}]*)\}", body):
        sel, decls = rule.group(1).strip(), rule.group(2)
        for prop in re.findall(r"(?:^|;)\s*([a-z-]+)\s*:", decls):
            if prop in BANNED_PROPS:
                errs.append(f"banned property {prop} in {sel}")
        if re.search(r"(?:^|;)\s*display\s*:", decls):
            for s in sel.split(","):
                s = s.strip()
                if "::" in s:
                    continue
                last = re.split(r"\s+|>", s)[-1]
                if ":not([hidden])" not in last:
                    errs.append(f"display without :not([hidden]): {s}")
        if sel.startswith("@"):
            continue
        for s in sel.split(","):
            s = re.sub(r"@media[^{]*", "", s).strip()
            for i in re.findall(r"#([a-zA-Z][\w-]*)", s):
                if i not in ALLOWED_IDS:
                    errs.append(f"unknown id #{i}")
            for c in re.findall(r"\.([a-zA-Z][\w-]*)", s):
                if c not in contract_words and f".{c}" not in contract:
                    errs.append(f"class .{c} missing from contract")
            stripped = re.sub(r"\[[^\]]*\]|\([^)]*\)|::?[\w-]+|#[\w-]+|\.[\w-]+", " ", s)
            for el in re.findall(r"\b([a-z][a-z0-9]*)\b", stripped):
                if el not in ELEMENT_OK:
                    errs.append(f"bare element selector {el} in {s}")
    return sorted(set(errs))


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(USAGE, file=sys.stderr)
        return 2
    *css_paths, contract_path = argv
    sheets = []
    for path in css_paths:
        with open(path, encoding="utf-8") as f:
            sheets.append(f.read())
    # Newline-joined so a sheet without a trailing newline cannot fuse with the next one's first rule.
    css = "\n".join(sheets)
    with open(contract_path, encoding="utf-8") as f:
        contract = f.read()
    errs = check(css, contract)
    for e in errs:
        print("FAIL", e)
    print("OK" if not errs else f"{len(errs)} problem(s)")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
