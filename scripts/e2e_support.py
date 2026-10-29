"""Run context, step recorder and page helpers shared by scripts/e2e_steps.py. Validation only."""

import functools
import traceback
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Ctx:
    base: str
    out: Path
    public_url: str
    results: list[tuple[str, str, str]] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    net: dict = field(default_factory=lambda: {"assoc": [], "scenes": [], "all": []})
    dialog: dict = field(default_factory=lambda: {"accept": True, "seen": []})

    def rec(self, name, ok, detail=""):
        verdict = "PASS" if ok else "FAIL"
        self.results.append((name, verdict, str(detail)))
        print(f"[{verdict}] {name}: {detail}", flush=True)

    def shot(self, page, name):
        page.screenshot(path=str(self.out / f"{name}.png"), full_page=True)


def step(name):
    """Wrap a step(ctx, ...) so an exception is recorded as a FAIL under `name` and the run continues."""

    def deco(fn):
        @functools.wraps(fn)
        def run(ctx, *a, **k):
            try:
                return fn(ctx, *a, **k)
            except Exception as exc:
                ctx.rec(name, False, f"EXC {type(exc).__name__}: {exc}")
                traceback.print_exc()
                return None

        return run

    return deco


def instrument(ctx, page, tag):
    def on_console(m):
        if m.type in ("error", "warning"):
            ctx.events.append(
                {"tag": tag, "kind": "console." + m.type, "text": m.text, "url": m.location.get("url", "")}
            )

    def on_failed(r):
        ctx.events.append({"tag": tag, "kind": "requestfailed", "text": f"{r.method} {r.url} {r.failure}"})

    def on_dialog(d):
        ctx.dialog["seen"].append(d.message)
        if ctx.dialog["accept"]:
            d.accept()
        else:
            d.dismiss()

    def on_req(r):
        ctx.net["all"].append(r.url)
        if r.url.endswith("/scenes") and r.method == "POST":
            try:
                ctx.net["scenes"].append(r.post_data_json)
            except Exception:
                ctx.net["scenes"].append({"_raw": (r.post_data or "")[:200]})

    def on_resp(r):
        if r.status >= 400:
            ctx.events.append({"tag": tag, "kind": f"http{r.status}", "text": f"{r.request.method} {r.url}"})
        if r.url.endswith("/associate") and r.request.method == "POST":
            try:
                ctx.net["assoc"].append({"status": r.status, "body": r.json()})
            except Exception as exc:
                ctx.net["assoc"].append({"status": r.status, "err": str(exc)})

    page.on("console", on_console)
    page.on("pageerror", lambda e: ctx.events.append({"tag": tag, "kind": "pageerror", "text": str(e)}))
    page.on("requestfailed", on_failed)
    page.on("dialog", on_dialog)
    page.on("request", on_req)
    page.on("response", on_resp)


def texts(page, sel):
    return page.eval_on_selector_all(sel, "els => els.map(e => e.textContent)")


def hscroll(page):
    return page.evaluate(
        "() => ({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,"
        " bsw: document.body.scrollWidth})"
    )


def route_labels(page):
    return texts(page, "#route li > span:first-child")


# Waits use locators, which poll in Playwright's isolated world: an eval'd JS-string predicate
# raises EvalError under the page CSP (MEM-042, no 'unsafe-eval').
def wait_status_ready(page):
    # Lazy import: this module must load where playwright is absent.
    from playwright.sync_api import expect

    expect(page.locator("#status")).not_to_have_text("Checking backend...", timeout=30000)


def open_page(page, url):
    page.goto(url)
    wait_status_ready(page)


def wait_history_rows(page):
    page.locator("#rehearsals li").first.wait_for(timeout=15000)
