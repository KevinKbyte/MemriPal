"""E2E checks after the main flow (signing, history, delete, 360px, public host) plus the run order."""

import json
import re

from e2e_steps import (
    s_demo,
    s_drop,
    s_generate,
    s_history_on_load,
    s_live_board,
    s_load,
    s_override,
    s_reorder,
    s_replay,
    s_saved,
    s_scenes,
    s_walk,
)
from e2e_support import STATUS_READY_JS, hscroll, instrument, open_page, step, texts, wait_history_rows

HEX64 = re.compile(r"^[0-9a-f]{64}$")
SCENES_KEYS = ["box", "image", "record", "sig"]


def _collect_sigs(o, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == "sig":
                out.append(v)
            else:
                _collect_sigs(v, out)
    elif isinstance(o, list):
        for v in o:
            _collect_sigs(v, out)


@step("(d) signed associate/scenes")
def s_signed(ctx, page):
    sigs = []
    statuses = []
    for a in ctx.net["assoc"]:
        statuses.append(a["status"])
        _collect_sigs(a.get("body"), sigs)
    valid = [s for s in sigs if isinstance(s, str) and HEX64.match(s)]
    bodies = ctx.net["scenes"]
    key_ok = all(isinstance(b, dict) and sorted(b.keys()) == SCENES_KEYS for b in bodies)
    match = all(isinstance(b, dict) and b.get("sig") in valid for b in bodies)
    keysets = sorted({tuple(sorted(b.keys())) if isinstance(b, dict) else ("raw",) for b in bodies})
    ctx.rec(
        "(d) signed associate/scenes",
        len(valid) > 0 and len(bodies) > 0 and key_ok and match,
        f"assoc_responses={len(ctx.net['assoc'])} statuses={sorted(set(statuses))} sigs={len(sigs)} "
        f"valid_64hex={len(valid)} scenes_requests={len(bodies)} keysets={keysets} "
        f"all_sig_in_assoc_sigs={match}",
    )
    if not bodies:
        return
    b = bodies[0]
    tam = json.loads(json.dumps(b))
    rc = tam["record"]
    if isinstance(rc, dict):
        k = next((k for k, v in rc.items() if isinstance(v, str)), None)
        if k:
            rc[k] = rc[k] + " tampered"
        else:
            rc["_x"] = "tampered"
    else:
        tam["record"] = str(rc) + "tampered"
    r1 = page.request.post(ctx.base + "/scenes", data=tam)
    t1 = r1.text()
    r2 = page.request.post(ctx.base + "/scenes", data={k: v for k, v in b.items() if k != "sig"})
    t2 = r2.text()
    r0 = page.request.post(ctx.base + "/scenes", data=b)
    ctx.rec(
        "(d) tampered record -> 403 bad_signature",
        r1.status == 403 and "bad_signature" in t1,
        f"status={r1.status} body={t1[:200]}",
    )
    ctx.rec("(d) missing sig -> 400", r2.status == 400, f"status={r2.status} body={t2[:200]}")
    ctx.rec("(d) untampered replay control", r0.status == 200, f"status={r0.status} body={r0.text()[:120]}")


@step("(c) fresh context 0 runs -> history hidden")
def s_empty(ctx, browser):
    bctx = browser.new_context(viewport={"width": 1100, "height": 900})
    try:
        page = bctx.new_page()
        instrument(ctx, page, "empty")
        open_page(page, ctx.base + "/")
        page.wait_for_timeout(1000)
        hidden = page.eval_on_selector("#history", "e => e.hidden") and not page.is_visible("#history")
        ctx.shot(page, "21_empty_history_hidden")
        ctx.rec("(c) fresh context 0 runs -> history hidden", hidden, f"history_hidden={hidden}")
    finally:
        bctx.close()


@step("11 reload -> history before and after Load demo")
def s_reload(ctx, page, before_rows):
    # MEM-033: stored runs list on open, before (and without) Load demo. A past run's said-vs-palace
    # shows only via the history View button (step 10b), never in #recall-results without a recall run.
    page.reload()
    page.wait_for_function(STATUS_READY_JS)
    wait_history_rows(page)
    hist_vis = page.is_visible("#history")
    rows_before_demo = texts(page, "#rehearsals li > span")
    recall_hidden = page.eval_on_selector("#recall", "e => e.hidden")
    ctx.shot(page, "12_after_reload")
    page.check("#auto")
    page.click("#load-demo")
    page.wait_for_selector("#recall:not([hidden])", timeout=180000)
    wait_history_rows(page)
    rows_after_demo = texts(page, "#rehearsals li > span")
    recall_vis = page.is_visible("#recall")
    ctx.shot(page, "13_history_after_reload")
    before_ok = rows_before_demo == before_rows
    after_ok = rows_after_demo == before_rows
    ok = hist_vis and before_ok and after_ok and recall_vis
    ctx.rec(
        "11 reload -> history before and after Load demo",
        ok,
        f"history_visible_before_demo={hist_vis} rows_before_demo_match={before_ok} "
        f"recall_hidden_after_reload={recall_hidden} rows_after_demo_match={after_ok} "
        f"recall_visible_after_demo={recall_vis} rows={rows_after_demo}",
    )


def _wait_rows(page, n):
    page.wait_for_function(f"document.querySelectorAll('#rehearsals li').length === {n}", timeout=5000)


@step("12 rehearsal delete confirm + undo")
def s_delete(ctx, page):
    # A typed second run needs a mic; replay again to have 2 rows.
    page.click("#recall-replay")
    page.wait_for_function("document.querySelectorAll('#rehearsals li').length >= 2", timeout=90000)
    before = texts(page, "#rehearsals li > span")
    ctx.dialog["accept"] = False
    page.locator("#rehearsals li").first.locator("button[data-action=delete-rehearsal]").click()
    page.wait_for_timeout(500)
    after_dismiss = texts(page, "#rehearsals li > span")
    undo_after_dismiss = page.is_visible("#rehearsal-undo")
    ctx.dialog["accept"] = True
    page.locator("#rehearsals li").first.locator("button[data-action=delete-rehearsal]").click()
    _wait_rows(page, len(before) - 1)
    after_del = texts(page, "#rehearsals li > span")
    undo_vis = page.is_visible("#rehearsal-undo")
    ctx.shot(page, "14_rehearsal_deleted")
    page.click("#rehearsal-undo")
    _wait_rows(page, len(before))
    restored = texts(page, "#rehearsals li > span")
    undo_hidden = not page.is_visible("#rehearsal-undo")
    ctx.shot(page, "15_rehearsal_undone")
    kept = after_dismiss == before
    deleted_first = after_del == before[1:]
    ok = kept and not undo_after_dismiss and deleted_first and undo_vis and restored == before and undo_hidden
    ctx.rec(
        "12 rehearsal delete confirm + undo",
        ok,
        f"dialogs={ctx.dialog['seen']} dismiss_kept={kept} "
        f"undo_after_dismiss={undo_after_dismiss} deleted_first={deleted_first} "
        f"undo_shown={undo_vis} restored_identical={restored == before} undo_rehidden={undo_hidden}",
    )


@step("13 360px no horizontal scroll")
def s_narrow(ctx, browser):
    bctx = browser.new_context(viewport={"width": 360, "height": 780})
    try:
        page = bctx.new_page()
        instrument(ctx, page, "360")
        open_page(page, ctx.base + "/")
        m = {"initial": hscroll(page)}
        ctx.shot(page, "16_360_initial")
        page.click("#load-demo")
        page.wait_for_selector("#route-review:not([hidden])", timeout=60000)
        page.locator("#route li").nth(0).locator("button[data-action=drop]").click()
        m["route_pending_drop"] = hscroll(page)
        ctx.shot(page, "17_360_route_review")
        page.locator("#route li").nth(0).locator("button[data-action=cancel-drop]").click()
        page.click("#generate")
        page.wait_for_selector("#walk:not([hidden])", timeout=180000)
        m["walk"] = hscroll(page)
        ctx.shot(page, "18_360_walk")
        page.click("#recall-replay")
        page.wait_for_selector("#recall-results ol.said-vs-palace", timeout=90000)
        m["end_screen"] = hscroll(page)
        ctx.shot(page, "19_360_end_screen")
        wide = {k: v for k, v in m.items() if v["sw"] > v["cw"]}
        ctx.rec("13 360px no horizontal scroll", not wide, f"metrics={m}")
    finally:
        bctx.close()


@step("14 public banner on non-localhost Host")
def s_public(ctx, browser):
    bctx = browser.new_context(viewport={"width": 1100, "height": 900})
    try:
        page = bctx.new_page()
        instrument(ctx, page, "public")
        open_page(page, ctx.public_url)
        vis = page.is_visible("#public-banner")
        txt = page.text_content("#public-banner")
        status = page.text_content("#status")
        ctx.shot(page, "20_public_banner")
        # Load demo still works on the public host (fixture mode, no passcode).
        page.check("#auto")
        page.click("#load-demo")
        page.wait_for_selector("#walk:not([hidden])", timeout=180000)
        walk_ok = page.is_visible("#walk")
        ctx.rec(
            "14 public banner on non-localhost Host",
            vis and walk_ok,
            f"banner_visible={vis} text={txt!r} status={status!r} demo_on_public_host_walk={walk_ok}",
        )
    finally:
        bctx.close()


def run_all(ctx, browser):
    """The full step sequence; order matters (later steps reuse the main context's stored runs)."""
    bctx = browser.new_context(viewport={"width": 1100, "height": 900})
    try:
        page = bctx.new_page()
        instrument(ctx, page, "main")
        s_load(ctx, page)
        labels = s_demo(ctx, page)
        if labels:
            s_reorder(ctx, page, labels)
            s_drop(ctx, page, labels)
        s_generate(ctx, page)
        s_scenes(ctx, page)
        s_walk(ctx, page)
        s_replay(ctx, page)
        s_live_board(ctx, page)
        override = s_override(ctx, page)
        rows = s_saved(ctx, page)
        if override:
            s_history_on_load(ctx, page, *override)
        s_signed(ctx, page)
        s_empty(ctx, browser)
        s_reload(ctx, page, rows)
        s_delete(ctx, page)
    finally:
        bctx.close()
    s_narrow(ctx, browser)
    s_public(ctx, browser)
