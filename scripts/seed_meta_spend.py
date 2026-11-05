"""Seed the Firestore Meta spend counter (MEM-136, ADR 0079; docs/runbooks/deploy-gcp.md).

Usage: uv run python scripts/seed_meta_spend.py --usd <current spend> [--doc PATH] [--project P]
Sets spent_usd = max(existing, N): never lowers the counter, refuses to overwrite invalid data. An
unseeded counter refuses every Meta call. Uses the caller's Application Default Credentials.
"""

import argparse
import math
import os

from memripal import meta_spend_guard


def _usd(value: str) -> float:
    try:
        usd = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number: {value!r}") from None
    if not math.isfinite(usd) or usd < 0:
        raise argparse.ArgumentTypeError(f"must be a finite number >= 0, got {value!r}")
    return usd


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed the Firestore Meta spend counter (never lowers it).")
    parser.add_argument("--usd", type=_usd, required=True, help="current Meta spend in USD (dashboard)")
    default_doc = os.environ.get(meta_spend_guard.SPEND_DOC_ENV, "").strip()
    parser.add_argument(
        "--doc",
        default=default_doc or meta_spend_guard.DEFAULT_SPEND_DOC,
        help="Firestore doc path (default: $MEMRIPAL_META_SPEND_FIRESTORE_DOC or memripal/meta-spend)",
    )
    parser.add_argument("--project", default=None, help="GCP project (default: the client's own resolution)")
    args = parser.parse_args(argv)

    transact = meta_spend_guard.firestore_transact(args.doc, project=args.project)
    stored = meta_spend_guard.seed_spend(transact, args.usd)
    print(f"{args.doc}: spent_usd = {stored:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
