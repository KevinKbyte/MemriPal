"""Record Kev's approval of the changed shots from one design_gate.py run (MEM-070, ADR-0036).

Usage: uv run python scripts/approve_design.py <gate-outdir> --approvals <file>
Reads <gate-outdir>/design-gate-run.json and appends one approval per changed shot (tip commit + sha256) to
<file>; earlier approvals stay. Human-run only (ask-listed). Exits 0 on success (a run with no changed shots
approves nothing), 2 on bad usage, a directory holding no gate run, or an unreadable approvals file.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

MANIFEST = "design-gate-run.json"  # written by design_gate.py


def _read_run(outdir: Path) -> tuple[str, dict[str, str]]:
    data = json.loads((outdir / MANIFEST).read_text(encoding="utf-8"))
    tip, changed = data["tip"], data["changed"]
    if not re.fullmatch(r"[0-9a-f]{40}([0-9a-f]{24})?", tip) or not isinstance(changed, dict):
        raise ValueError("malformed tip or changed list")
    for name, digest in changed.items():
        if Path(name).name != name or not re.fullmatch(r"[0-9a-f]{64}", str(digest)):
            raise ValueError(f"malformed shot entry {name!r}")
    return tip, changed


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="approve_design.py")
    parser.add_argument("outdir", type=Path)
    parser.add_argument("--approvals", required=True, type=Path)
    args = parser.parse_args(argv)  # bad usage: SystemExit(2)

    if not (args.outdir / MANIFEST).is_file():
        print(f"approve_design: no gate run in {args.outdir}", file=sys.stderr)
        return 2
    try:
        tip, changed = _read_run(args.outdir)
    except (ValueError, KeyError, TypeError) as exc:
        print(f"approve_design: unreadable gate run in {args.outdir}: {exc}", file=sys.stderr)
        return 2
    if not changed:
        print(f"no changed shots at {tip[:12]}; nothing to approve")
        return 0
    try:
        existing = json.loads(args.approvals.read_text(encoding="utf-8")) if args.approvals.exists() else {}
        approvals = list(existing.get("approvals", []))
    except (ValueError, AttributeError) as exc:
        # Never overwrite a file we cannot parse: it may hold approvals worth keeping.
        print(f"approve_design: unreadable {args.approvals}: {exc}", file=sys.stderr)
        return 2
    for name, digest in sorted(changed.items()):
        approvals.append({"tip": tip, "shot": name, "sha256": digest})
        print(f"approved {name} {digest[:12]} at {tip[:12]}")
    tmp = args.approvals.with_name(args.approvals.name + ".tmp")
    tmp.write_text(json.dumps({"approvals": approvals}, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, args.approvals)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
