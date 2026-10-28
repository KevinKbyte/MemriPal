"""Drive the MemriPal UI end to end in a real Chrome against a fixture-mode server it starts itself.

Usage: uv run --with playwright python scripts/e2e_drive.py [--out DIR] [--base-url URL]
Writes results.json, server.log and step screenshots to --out (default: a fresh dir under the system temp
dir). Exits 0 only when all EXPECTED_STEPS steps pass, 1 on any failure, 2 when the server never got ready.
The browser steps live in scripts/e2e_steps.py; everything here is browser-free.
"""

import argparse
import contextlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from urllib.parse import urlsplit

REPO_ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"
# Step 14 needs a non-localhost Host the app still accepts; Chrome maps it to 127.0.0.1.
PUBLIC_HOST = "memripal-e2e.test"
EXPECTED_STEPS = 21
READY_TIMEOUT_S = 30.0

Result = tuple[str, str, str]  # (step name, "PASS" | "FAIL", detail)


def default_out_dir() -> Path:
    return Path(tempfile.gettempdir()) / "memripal-e2e" / time.strftime("%Y%m%d-%H%M%S")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="e2e_drive.py", description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=None, help="output dir (default: under the temp dir)")
    parser.add_argument("--base-url", default=None, help="drive an already-running server; skip starting one")
    args = parser.parse_args(argv)
    if args.base_url is not None:
        parts = urlsplit(args.base_url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            parser.error(f"--base-url must be an http(s) URL, got {args.base_url!r}")
        args.base_url = args.base_url.rstrip("/")
    if args.out is None:
        args.out = default_out_dir()
    return args


def pick_free_port(host: str = HOST) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def server_env(base: Mapping[str, str]) -> dict[str, str]:
    """`base` minus every MEMRIPAL_* var (a stray passcode or live mode would break the run), plus
    fixture mode and the public test host."""
    env = {k: v for k, v in base.items() if not k.startswith("MEMRIPAL_")}
    env["MEMRIPAL_MODE"] = "fixture"
    env["MEMRIPAL_ALLOWED_HOSTS"] = PUBLIC_HOST
    return env


def server_command(port: int, python: str = sys.executable) -> list[str]:
    return [python, "-m", "uvicorn", "memripal.app:app", "--host", HOST, "--port", str(port)]


def public_url(base_url: str, host: str = PUBLIC_HOST) -> str:
    parts = urlsplit(base_url)
    netloc = f"{host}:{parts.port}" if parts.port else host
    return f"{parts.scheme}://{netloc}/"


def wait_until_ready(
    probe: Callable[[], bool],
    alive: Callable[[], bool],
    timeout: float = READY_TIMEOUT_S,
    interval: float = 0.2,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """True once `probe()` succeeds; False if `alive()` turns False or `timeout` seconds pass first."""
    deadline = clock() + timeout
    while alive():
        if probe():
            return True
        if clock() >= deadline:
            return False
        sleep(interval)
    return False


def summarize(results: list[Result]) -> dict[str, int]:
    passed = sum(1 for _, verdict, _ in results if verdict == "PASS")
    return {"passed": passed, "failed": len(results) - passed, "total": len(results)}


def exit_code(results: list[Result], expected: int = EXPECTED_STEPS) -> int:
    """0 only when exactly `expected` steps ran and all passed; a skipped step counts as a failure."""
    s = summarize(results)
    return 0 if s["failed"] == 0 and s["total"] == expected else 1


def _healthy(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1) as resp:
            return resp.status == 200
    except OSError:
        return False


@contextlib.contextmanager
def serve(out: Path) -> Iterator[str | None]:
    """Start the fixture-mode app on a free port; yield its base URL (None if it never got ready).
    The server is always terminated on exit."""
    port = pick_free_port()
    base = f"http://{HOST}:{port}"
    with open(out / "server.log", "w", encoding="utf-8", errors="replace") as log:
        proc = subprocess.Popen(
            server_command(port),
            cwd=REPO_ROOT,
            env=server_env(os.environ),
            stdout=log,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
        )
        try:
            ready = wait_until_ready(lambda: _healthy(base + "/healthz"), lambda: proc.poll() is None)
            yield base if ready else None
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


def run_steps(base: str, out: Path) -> list[Result]:
    # Lazy imports: this module (and its pure helpers) must load where playwright is absent.
    from e2e_checks import run_all
    from e2e_support import Ctx
    from playwright.sync_api import sync_playwright

    ctx = Ctx(base=base, out=out, public_url=public_url(base))
    with sync_playwright() as p:
        resolver = f"--host-resolver-rules=MAP {PUBLIC_HOST} {HOST}"
        browser = p.chromium.launch(channel="chrome", args=[resolver])
        try:
            run_all(ctx, browser)
        finally:
            browser.close()
    payload = {"summary": summarize(ctx.results), "results": ctx.results, "events": ctx.events}
    (out / "results.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print("EVENTS:")
    for e in ctx.events:
        print(" ", e)
    return ctx.results


def main(argv: list[str], run: Callable[[str, Path], list[Result]] = run_steps) -> int:
    args = parse_args(argv)
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    if args.base_url:
        results = run(args.base_url, out)
    else:
        with serve(out) as base:
            if base is None:
                print(f"server did not become ready; see {out / 'server.log'}", file=sys.stderr)
                return 2
            results = run(base, out)
    s = summarize(results)
    print(f"{s['passed']}/{s['total']} PASS (expected {EXPECTED_STEPS}); output in {out}")
    return exit_code(results)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
