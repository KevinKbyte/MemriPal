"""Main-flow browser steps (load, route, generate, walk, recall, history) for scripts/e2e_drive.py."""

import re

from e2e_support import open_page, route_labels, step, texts, wait_status_ready


@step("1 load page")
def s_load(ctx, page):
    open_page(page, ctx.base + ctx.home)
    status = page.text_content("#status")
    banner_hidden = page.eval_on_selector("#public-banner", "e => e.hidden")
    ctx.shot(page, "01_initial")
    ok = status == "Backend ok (fixture mode)" and banner_hidden
    ctx.rec("1 load page", ok, f"status={status!r} banner_hidden={banner_hidden}")


@step("2 load demo -> route review")
def s_demo(ctx, page):
    page.click("#load-demo")
    page.wait_for_selector("#route-review:not([hidden])", timeout=60000)
    labels = route_labels(page)
    ctx.shot(page, "02_route_review")
    upload = page.text_content("#upload-status")
    detail = f"upload-status={upload!r} loci={len(labels)} labels={labels}"
    ctx.rec("2 load demo -> route review", len(labels) > 0, detail)
    return labels


def _route_btn(page, i, action):
    return page.locator("#route li").nth(i).locator(f"button[data-action={action}]")


@step("3 route reorder")
def s_reorder(ctx, page, before):
    _route_btn(page, 0, "down").click()
    after = route_labels(page)
    ok_swap = after[0] == before[1] and after[1] == before[0]
    up0 = _route_btn(page, 0, "up").is_disabled()
    downlast = page.locator("#route li").last.locator("button[data-action=down]").is_disabled()
    # Move it back so the fixture pairings stay as recorded.
    _route_btn(page, 1, "up").click()
    back = route_labels(page)
    ok = ok_swap and up0 and downlast and back == before
    detail = f"swap={ok_swap} up0_disabled={up0} downLast_disabled={downlast} restored={back == before}"
    ctx.rec("3 route reorder", ok, detail)


@step("4 route drop+confirm+undo")
def s_drop(ctx, page, before):
    _route_btn(page, 1, "drop").click()
    pending = _route_btn(page, 1, "confirm-drop").count() == 1
    still = len(route_labels(page)) == len(before)
    ctx.shot(page, "03_route_drop_pending")
    _route_btn(page, 1, "cancel-drop").click()
    cancelled = route_labels(page) == before
    _route_btn(page, 1, "drop").click()
    _route_btn(page, 1, "confirm-drop").click()
    dropped_ok = route_labels(page) == before[:1] + before[2:]
    undo_vis = page.is_visible("#route-undo")
    ctx.shot(page, "04_route_dropped")
    page.click("#route-undo")
    restored = route_labels(page) == before
    undo_hidden = not page.is_visible("#route-undo")
    ok = pending and still and cancelled and dropped_ok and undo_vis and restored and undo_hidden
    detail = (
        f"pending_confirm={pending} not_dropped_before_confirm={still} cancel_ok={cancelled} "
        f"dropped_ok={dropped_ok} undo_shown={undo_vis} restored={restored} undo_rehidden={undo_hidden}"
    )
    ctx.rec("4 route drop+confirm+undo", ok, detail)


@step("5 generate associations")
def s_generate(ctx, page):
    page.click("#generate")
    page.wait_for_selector("#walk:not([hidden])", timeout=180000)
    status = page.text_content("#assoc-status")
    cards = page.locator("#associations > section").count()
    dts = page.locator("#associations section dl").first.locator("dt").count()
    paras = texts(page, "#associations section p")
    failed = [t for t in paras if t.startswith("Could not generate") or t == "Needs regeneration"]
    ctx.shot(page, "05_associations")
    ok = cards > 0 and not failed and dts == 8
    detail = f"assoc-status={status!r} cards={cards} dt_in_first={dts} failures={failed}"
    ctx.rec("5 generate associations", ok, detail)


@step("6 scenes + overlay zoom")
def s_scenes(ctx, page):
    secs = page.locator("#scenes > section").count()
    imgs = page.locator("#scenes .scene-frame img").count()
    unavailable = [t for t in texts(page, "#scenes p") if t.startswith("Scene unavailable")]
    rendering = [t for t in texts(page, "#scenes div") if t == "Rendering scene..."]
    ctx.shot(page, "06_scenes")
    overlay_ok = None
    transform = None
    if imgs:
        img = page.locator("#scenes .scene-frame img").first
        transform = img.evaluate("e => e.style.transform")
        img.click()
        vis = page.is_visible("#scene-overlay") and page.locator("#scene-overlay img").count() == 1
        ctx.shot(page, "07_overlay")
        page.keyboard.press("Escape")
        esc_closed = not page.is_visible("#scene-overlay")
        img.click()
        page.click("#scene-overlay", position={"x": 5, "y": 5})
        click_closed = not page.is_visible("#scene-overlay")
        overlay_ok = vis and esc_closed and click_closed
    ok = secs > 0 and not rendering and (imgs + len(unavailable) == secs) and overlay_ok is True
    detail = (
        f"sections={secs} tier1_imgs={imgs} tier3={len(unavailable)} reasons={sorted(set(unavailable))} "
        f"still_rendering={len(rendering)} first_transform={transform!r} overlay_open_esc_click={overlay_ok}"
    )
    ctx.rec("6 scenes + overlay zoom", ok, detail)


@step("7 walk view prev/next")
def s_walk(ctx, page):
    steps_seen = []
    prev_dis0 = page.is_disabled("#walk-prev")
    bad = []
    n = 0
    while True:
        n += 1
        head = page.text_content("#walk-step p")
        dts = texts(page, "#walk-step dt")
        dds = texts(page, "#walk-step dd")
        if len(dts) != 8 or any(not d.strip() for d in dds):
            bad.append((head, len(dts), sum(1 for d in dds if not d.strip())))
        steps_seen.append(head)
        if n == 1:
            ctx.shot(page, "08_walk_step1")
        if page.is_disabled("#walk-next") or n > 40:
            break
        page.click("#walk-next")
    ctx.shot(page, "09_walk_last")
    last_next_dis = page.is_disabled("#walk-next")
    page.click("#walk-prev")
    back = page.text_content("#walk-step p")
    walk_img = page.locator("#walk-step .scene-frame img").count()
    channels = texts(page, "#walk-step dt")
    ok = prev_dis0 and last_next_dis and not bad and len(steps_seen) > 1
    detail = (
        f"steps={len(steps_seen)} first={steps_seen[0]!r} last={steps_seen[-1]!r} "
        f"prev_disabled@1={prev_dis0} next_disabled@last={last_next_dis} after_prev={back!r} "
        f"bad_steps={bad} channels={channels} walk_scene_img={walk_img}"
    )
    ctx.rec("7 walk view prev/next", ok, detail)


@step("8 recall replay -> end screen")
def s_replay(ctx, page):
    vis = page.is_visible("#recall")
    page.click("#recall-replay")
    page.wait_for_selector("#recall-results ol.said-vs-palace", timeout=90000)
    label = texts(page, "#recall-results > p")
    got = page.locator("#recall-results li.said-got").count()
    missed = page.locator("#recall-results li.said-missed").count()
    row_js = "els => els.map(e => [...e.children].map(c => c.textContent).join(' | '))"
    rows = page.eval_on_selector_all("#recall-results li", row_js)
    ctx.shot(page, "10_recall_end_screen")
    detail = f"recall_visible={vis} label={label} got={got} missed={missed} rows={rows}"
    ctx.rec("8 recall replay -> end screen", vis and got >= 1 and missed >= 1, detail)


@step("8b live board lights on replay")
def s_live_board(ctx, page):
    # MEM-037: the replay board holds one row per palace point; the rows the matcher found are lit.
    page.wait_for_selector("#recall-live p.live-badge", timeout=30000)
    page.wait_for_selector("#recall-live ol.live-board li.lit", timeout=30000)
    badge = page.text_content("#recall-live p.live-badge")
    rows = page.locator("#recall-live ol.live-board li").count()
    lit = page.locator("#recall-live ol.live-board li.lit").count()
    points = page.locator("#recall-results ol.said-vs-palace > li").count()
    got = page.locator("#recall-results ol.said-vs-palace > li.said-got").count()
    ctx.shot(page, "10a_live_board")
    ok = badge == "recorded replay" and rows == points and lit == got and lit >= 1
    detail = f"badge={badge!r} board_rows={rows} palace_points={points} lit={lit} got={got}"
    ctx.rec("8b live board lights on replay", ok, detail)


def _hits(rate_rows):
    m = re.search(r": (\d+)/(\d+)", rate_rows[0]) if rate_rows else None
    return int(m.group(1)) if m else None


@step("9a mark got it override")
def s_override(ctx, page):
    btns = page.locator('#recall-results button[data-action="mark-got"]')
    nbtn = btns.count()
    got0 = page.locator("#recall-results li.said-got").count()
    miss0 = page.locator("#recall-results li.said-missed").count()
    rehearsal0 = texts(page, "#rehearsals li > span")
    rates0 = texts(page, "#hit-rates li")
    rowtext0 = page.locator("#recall-results li.said-missed").first.text_content()
    label = btns.first.get_attribute("aria-label").replace("Mark got it: ", "")
    btns.first.click()
    page.wait_for_timeout(800)
    got1 = page.locator("#recall-results li.said-got").count()
    miss1 = page.locator("#recall-results li.said-missed").count()
    marked = "marked got it" in page.text_content("#recall-results").lower()
    rehearsal1 = texts(page, "#rehearsals li > span")
    rates1 = texts(page, "#hit-rates li")
    ctx.shot(page, "10b_override")
    m0 = re.search(r"(\d+)/(\d+) recalled", rehearsal0[0]) if rehearsal0 else None
    inc = [r for r in rehearsal1 if r not in rehearsal0]
    m1 = re.search(r"(\d+)/12 recalled", inc[0]) if inc else None
    same_len = len(rehearsal1) == len(rehearsal0)
    reh_ok = bool(m1) and (m0 is None or int(m1.group(1)) == int(m0.group(1)) + 1 or same_len)
    rate0 = [r for r in rates0 if r.startswith(label + ":")]
    rate1 = [r for r in rates1 if r.startswith(label + ":")]
    rate_ok = _hits(rate1) is not None and (_hits(rate0) is None or _hits(rate1) == _hits(rate0) + 1)
    ok = nbtn == miss0 and got1 == got0 + 1 and miss1 == miss0 - 1 and marked and reh_ok and rate_ok
    detail = (
        f"mark_got_buttons={nbtn} missed0={miss0} got {got0}->{got1} missed {miss0}->{miss1} "
        f"marked_text={marked} row_before={rowtext0!r} rehearsals_before={rehearsal0} "
        f"after={rehearsal1} label={label!r} rate {rate0}->{rate1}"
    )
    ctx.rec("9a mark got it override", ok, detail)
    return rehearsal1, rates1


@step("10 rehearsal saved + hit rates")
def s_saved(ctx, page):
    rows = texts(page, "#rehearsals li > span")
    rates = texts(page, "#hit-rates li")
    ctx.shot(page, "11_rehearsals")
    detail = f"rows={rows} hit_rates={rates[:4]}... n={len(rates)}"
    ctx.rec("10 rehearsal saved + hit rates", len(rows) >= 1 and len(rates) >= 1, detail)
    return rows


@step("9a override persists after reload / 10b history on load")
def s_history_on_load(ctx, page, rehearsal_after, rates_after):
    page.reload()
    wait_status_ready(page)
    page.wait_for_timeout(1500)
    vis = page.is_visible("#history")
    rows = texts(page, "#rehearsals li > span")
    rates = texts(page, "#hit-rates li")
    ctx.shot(page, "12b_history_on_load")
    same = rows == rehearsal_after
    detail = f"rows_after_reload={rows} same_as_before_reload={same} rates_same={rates == rates_after}"
    ctx.rec("9a override persists after reload", same and rates == rates_after, detail)
    views = page.locator("#rehearsals li button", has_text="View")
    nrows = page.locator("#rehearsals li").count()
    svp = 0
    reqs = []
    marked_in_view = False
    if views.count():
        mark = len(ctx.net["all"])
        views.first.click()
        page.wait_for_timeout(800)
        reqs = [u for u in ctx.net["all"][mark:] if not u.startswith("data:")]
        svp = page.locator("#history-view ol.said-vs-palace").count()
        marked_in_view = "marked got it" in (page.text_content("#history-view") or "").lower()
        ctx.shot(page, "12c_history_view")
    ok = vis and nrows >= 1 and len(rates) >= 1 and views.count() == nrows and svp == 1 and not reqs
    detail = (
        f"history_visible={vis} rows={nrows} view_buttons={views.count()} hit_rates={len(rates)} "
        f"said_vs_palace_in_view={svp} requests_on_view={reqs} overridden_row_shows_marked={marked_in_view}"
    )
    ctx.rec("10b history on load (no Load demo)", ok, detail)
