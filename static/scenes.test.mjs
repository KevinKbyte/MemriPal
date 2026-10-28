// Covers: MEM-029
// Requirement: each generated association gets a rendered scene: the client POSTs /scenes per
// valid card (never more than 3 at once), shows a tier-1 scene image zoomed to its locus with a
// full-size overlay on click/tap, and shows "Scene unavailable: <code>" for tier 3 or any failure
// without stopping the other cards. Model text only ever reaches the page via textContent.
// Contract (RED; GREEN implements, ADR 0021):
//   static/scenes.js (new module; app.js is near the 500-line cap) exports
//     MAX_SCENES_IN_FLIGHT = 3 (matches the server's MAX_CONCURRENT_SCENES)
//     isSafeImageSrc(value) -> boolean: true only for a string starting with
//       "data:image/(png|jpeg|webp);base64," (case-sensitive) or "blob:"
//     zoomFor(box, width, height) -> {scale, tx, ty}: the tier-1 <img> (the WHOLE edited photo,
//       width x height) is shown with `transform-origin: 0 0; transform: scale(s)
//       translate(tx*100%, ty*100%)`, i.e. image point (px, py) lands at frame fraction
//       (s*(px/width + tx), s*(py/height + ty)). The locus box lands fully inside the frame, the
//       image always covers the frame (tx in [1/s - 1, 0]), s >= 1. Invalid box -> identity
//       {scale: 1, tx: 0, ty: 0}.
//     runScenes(cards, deps) -> Promise<Array<{tier: 1, image} | {tier: 3, reason} | null>>,
//       one entry per card in input order (null = card skipped, no request).
//       cards = [{item, locus: {n, label, box: {x1, y1, x2, y2}}, entry: {record, status} | null}]
//         (an AssocPair plus its stored AssocEntry). Eligible = entry.status "valid" + a box.
//       deps = {doc, fetch, image}: image = the processed photo data URL from POST /loci.
//       Renders one #scenes child per eligible card, in input order whatever the answer order;
//       its text includes the item and locus label. Tier 1 with a safe src -> an <img> whose
//       src is the server data URL (or a blob: URL made from it) and whose style.transform holds
//       the zoomFor scale(...); clicking/tapping it shows #scene-overlay (hidden=false) holding a
//       newly created full-size <img> (no scale transform); a click on #scene-overlay or an
//       Escape keydown on doc hides it again. Everything else -> no <img>, text
//       "Scene unavailable: <code>": tier-3 reason; non-2xx JSON error string, else
//       "http_<status>"; network error "network"; tier 1 with an unsafe src "bad_image".
//       Never throws. Missing image -> no request.
// POST /scenes (MEM-028): JSON body exactly {image, box, record}; 200 {tier: 1, image, width,
//   height} or 200 {tier: 3, reason}. Fake DOM surface: see fake_dom_test.mjs.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SAFE_SRC,
  deferred,
  fakePage,
  find,
  findAll,
  jsonResponse,
  record,
  settle,
  textOf,
  until,
} from "./fake_dom_test.mjs";

const scenes = await import("./scenes.js").catch((err) => ({ __missing: String(err) }));

/** The named export, failing the test with a clear message while scenes.js is missing. */
function api(name) {
  assert.ok(name in scenes, `static/scenes.js must export ${name} (${scenes.__missing ?? "not exported"})`);
  return scenes[name];
}

const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const W = 800;
const H = 600;
const SCENE = (tag) => `data:image/jpeg;base64,U0NFTkU${tag}`;
const ITEMS = ["milk", "eggs", "bread", "apples", "cheese"];
const LABELS = ["lamp", "door", "clock", "frame", "shelf"];

function cards(n, entryFor = () => "valid") {
  return ITEMS.slice(0, n).map((item, i) => {
    const label = LABELS[i];
    const status = entryFor(item);
    return {
      item,
      locus: { n: i + 1, label, box: { x1: 10 + i * 100, y1: 20, x2: 90 + i * 100, y2: 120 } },
      entry: status === null ? null : { record: record(item, label), status },
    };
  });
}

const PAGE_IDS = ["scenes", "scene-overlay"];
const page = () => fakePage(PAGE_IDS, { hidden: ["scene-overlay"] });

/** Fetch stub: answer(body) -> Response (or throws); every call recorded. */
function sceneFetch(answer = (body) => jsonResponse({ tier: 1, image: SCENE(body.record.item), width: W, height: H })) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), init, body });
    return answer(body);
  };
  return { fn, calls };
}

const panelCards = (p) => p.els.scenes.children.filter((c) => typeof c === "object");
const imgsIn = (node) => findAll(node, (n) => n.tagName === "IMG");
const isShownSrc = (src, server) => src === server || /^blob:/.test(src);

// Covers: MEM-029
// Requirement: the scene panel seam exists: scenes.js exports and the page has #scenes and a
// hidden #scene-overlay.
describe("scene panel seam", () => {
  test("scenes.js exports runScenes, zoomFor, isSafeImageSrc and MAX_SCENES_IN_FLIGHT = 3", () => {
    assert.equal(typeof api("runScenes"), "function");
    assert.equal(typeof api("zoomFor"), "function");
    assert.equal(typeof api("isSafeImageSrc"), "function");
    assert.equal(api("MAX_SCENES_IN_FLIGHT"), 3);
  });

  test("index.html has the #scenes panel and a #scene-overlay that starts hidden", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    assert.match(html, /\bid="scenes"/);
    assert.match(html, /<[^>]*\bid="scene-overlay"[^>]*\bhidden\b[^>]*>/, "#scene-overlay must carry the hidden attribute");
  });
});

// Covers: MEM-029
// Requirement: a scene image src is only ever a server base64 data URL (png, jpeg or webp) or a
// Blob URL; anything else (script URLs, SVG, remote URLs) is refused.
describe("isSafeImageSrc", () => {
  test("accepts base64 png/jpeg/webp data URLs and blob: URLs", () => {
    const ok = api("isSafeImageSrc");
    for (const v of [
      "data:image/jpeg;base64,/9j/4AAQ",
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/webp;base64,UklGRg==",
      "blob:http://localhost:8000/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
    ]) {
      assert.equal(ok(v), true, v);
    }
  });

  test("refuses script, svg, html, remote, non-base64 and non-string values", () => {
    const ok = api("isSafeImageSrc");
    for (const v of [
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:text/html;base64,PGI+",
      "data:image/jpeg,rawbytes",
      "http://evil.example/x.jpg",
      "https://evil.example/x.jpg",
      "//evil.example/x.jpg",
      " data:image/jpeg;base64,AAAA",
      "DATA:image/jpeg;base64,AAAA",
      "x data:image/jpeg;base64,AAAA",
      "",
      null,
      undefined,
      42,
      {},
    ]) {
      assert.equal(ok(v), false, String(v));
    }
  });
});

// Covers: MEM-029
// Requirement: each eligible card (valid record + locus box) gets exactly one POST /scenes with
// JSON {image, box, record}; ineligible cards and a run without a photo send nothing; never more
// than 3 requests are in flight, and every card is still requested.
describe("runScenes: requests", () => {
  test("one POST /scenes per card, JSON body exactly {image, box, record}", async () => {
    const p = page();
    const f = sceneFetch();
    const input = cards(2);
    await api("runScenes")(input, { doc: p.doc, fetch: f.fn, image: IMAGE });
    assert.deepEqual(
      f.calls.map((c) => c.url),
      ["/scenes", "/scenes"],
    );
    for (const c of f.calls) {
      assert.equal(c.init.method, "POST");
      const headers = new Headers(c.init.headers);
      assert.match(headers.get("content-type") ?? "", /^application\/json/);
    }
    assert.deepEqual(
      f.calls.map((c) => c.body),
      input.map((c) => ({ image: IMAGE, box: c.locus.box, record: c.entry.record })),
    );
  });

  test("cards with no entry, an invalid entry or no box send no request and yield null", async () => {
    const p = page();
    const f = sceneFetch();
    const input = cards(4, (item) => ({ milk: "valid", eggs: null, bread: "invalid", apples: "valid" })[item]);
    delete input[3].locus.box;
    const results = await api("runScenes")(input, { doc: p.doc, fetch: f.fn, image: IMAGE });
    assert.deepEqual(
      f.calls.map((c) => c.body.record.item),
      ["milk"],
    );
    assert.equal(results.length, 4);
    assert.equal(results[0].tier, 1);
    assert.deepEqual(results.slice(1), [null, null, null]);
  });

  test("never more than 3 requests in flight; all 5 are sent and the run resolves", async () => {
    const p = page();
    const pending = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = (url, init) => {
      const d = deferred();
      const body = JSON.parse(init.body);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      pending.push({ body, d });
      return d.promise.finally(() => {
        inFlight -= 1;
      });
    };
    let done = false;
    const run = api("runScenes")(cards(5), { doc: p.doc, fetch, image: IMAGE }).then(() => {
      done = true;
    });
    await until(() => pending.length >= 3, "3 requests sent");
    await settle();
    assert.equal(pending.length, 3, "a 4th request went out while 3 were unanswered");
    for (let i = 0; i < 5; i++) {
      await until(() => pending.length > i, `request ${i + 1} sent`);
      pending[i].d.resolve(jsonResponse({ tier: 1, image: SCENE(pending[i].body.record.item), width: W, height: H }));
    }
    await run;
    assert.equal(done, true);
    assert.equal(pending.length, 5);
    assert.ok(maxInFlight <= 3, `max in flight ${maxInFlight}`);
  });

  for (const [name, image] of [
    ["missing", undefined],
    ["empty", ""],
  ]) {
    test(`${name} photo: no request, no throw`, async () => {
      const p = page();
      const f = sceneFetch();
      await api("runScenes")(cards(2), { doc: p.doc, fetch: f.fn, image });
      assert.deepEqual(f.calls, []);
    });
  }

  test("no cards: no request and an empty panel", async () => {
    const p = page();
    const f = sceneFetch();
    const results = await api("runScenes")([], { doc: p.doc, fetch: f.fn, image: IMAGE });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(results, []);
    assert.equal(panelCards(p).length, 0);
  });
});

// Covers: MEM-029
// Requirement: a tier-1 scene shows the whole edited photo zoomed to the locus box, and a
// click/tap opens it full size in an overlay that closes on click or Escape; an unsafe src never
// reaches an <img>.
describe("runScenes: tier-1 scene, zoom and overlay", () => {
  test("tier 1 renders an <img> with the server data URL and a zoom transform", async () => {
    const p = page();
    const results = await api("runScenes")(cards(1), { doc: p.doc, fetch: sceneFetch().fn, image: IMAGE });
    assert.equal(panelCards(p).length, 1);
    const imgs = imgsIn(p.els.scenes);
    assert.equal(imgs.length, 1, "one scene image");
    assert.ok(isShownSrc(imgs[0].src, SCENE("milk")), `src ${imgs[0].src}`);
    assert.match(String(imgs[0].style.transform ?? ""), /scale\(/, "scene image zoomed to the locus box");
    assert.equal(results[0].tier, 1);
  });

  for (const bad of ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "https://evil.example/x.jpg", 7]) {
    test(`tier 1 with unsafe image ${JSON.stringify(bad)} -> no <img>, "Scene unavailable: bad_image"`, async () => {
      const p = page();
      const f = sceneFetch(() => jsonResponse({ tier: 1, image: bad, width: W, height: H }));
      const results = await api("runScenes")(cards(1), { doc: p.doc, fetch: f.fn, image: IMAGE });
      assert.deepEqual(imgsIn(p.els.scenes), []);
      assert.deepEqual(p.srcWrites.filter((s) => !SAFE_SRC.test(s)), [], "unsafe src assigned");
      assert.match(p.els.scenes.textContent, /Scene unavailable: bad_image/);
      assert.deepEqual(results[0], { tier: 3, reason: "bad_image" });
    });
  }

  test("zoomFor: a full-image box is the identity", () => {
    assert.deepEqual(api("zoomFor")({ x1: 0, y1: 0, x2: W, y2: H }, W, H), { scale: 1, tx: 0, ty: 0 });
  });

  test("zoomFor: invalid boxes fall back to the identity", () => {
    const zoomFor = api("zoomFor");
    for (const box of [null, undefined, {}, { x1: 10, y1: 10, x2: 10, y2: 50 }, { x1: 0, y1: 0, x2: NaN, y2: 5 }]) {
      assert.deepEqual(zoomFor(box, W, H), { scale: 1, tx: 0, ty: 0 }, JSON.stringify(box));
    }
  });

  test("zoomFor: for every box the locus stays in frame and the photo covers the frame", () => {
    const zoomFor = api("zoomFor");
    const eps = 1e-9;
    for (const [w, h] of [
      [800, 600],
      [600, 800],
      [1024, 1024],
    ]) {
      for (const fx of [0, 0.1, 0.45, 0.9]) {
        for (const fw of [0.01, 0.1, 0.3, 1]) {
          for (const fy of [0, 0.2, 0.5, 0.95]) {
            for (const fh of [0.02, 0.25, 1]) {
              const x1 = Math.round(fx * w);
              const y1 = Math.round(fy * h);
              const x2 = Math.min(w, x1 + Math.max(1, Math.round(fw * w)));
              const y2 = Math.min(h, y1 + Math.max(1, Math.round(fh * h)));
              const box = { x1, y1, x2, y2 };
              const { scale: s, tx, ty } = zoomFor(box, w, h);
              const at = JSON.stringify({ box, w, h, s, tx, ty });
              assert.ok(Number.isFinite(s) && s >= 1, `scale >= 1: ${at}`);
              assert.ok(tx <= eps && ty <= eps, `photo covers the frame's top-left: ${at}`);
              assert.ok(s * (1 + tx) >= 1 - eps && s * (1 + ty) >= 1 - eps, `photo covers bottom-right: ${at}`);
              assert.ok(s * (x1 / w + tx) >= -eps && s * (x2 / w + tx) <= 1 + eps, `box in frame (x): ${at}`);
              assert.ok(s * (y1 / h + ty) >= -eps && s * (y2 / h + ty) <= 1 + eps, `box in frame (y): ${at}`);
            }
          }
        }
      }
    }
  });

  test("zoomFor: a small centred box is zoomed in and stays centred", () => {
    const { scale: s, tx, ty } = api("zoomFor")({ x1: 360, y1: 270, x2: 440, y2: 330 }, W, H);
    assert.ok(s > 1, `scale ${s}`);
    assert.ok(Math.abs(s * (0.5 + tx) - 0.5) < 1e-9, "box centre at frame centre (x)");
    assert.ok(Math.abs(s * (0.5 + ty) - 0.5) < 1e-9, "box centre at frame centre (y)");
  });

  test("click opens a full-size overlay; a click on it or Escape closes it", async () => {
    const p = page();
    await api("runScenes")(cards(1), { doc: p.doc, fetch: sceneFetch().fn, image: IMAGE });
    const overlay = p.els["scene-overlay"];
    const scene = imgsIn(p.els.scenes)[0];
    assert.ok(scene, "scene image rendered");
    assert.equal(overlay.hidden, true, "overlay starts hidden");

    p.fire(scene, "click");
    assert.equal(overlay.hidden, false, "click on the scene opens the overlay");
    const full = find(overlay, (n) => n.tagName === "IMG");
    assert.ok(full, "overlay holds an image");
    assert.ok(isShownSrc(full.src, SCENE("milk")), `overlay src ${full.src}`);
    assert.doesNotMatch(String(full.style.transform ?? ""), /scale\(/, "overlay image is full size, not zoomed");

    p.fire(overlay, "click");
    assert.equal(overlay.hidden, true, "click on the overlay closes it");

    p.fire(scene, "click");
    assert.equal(overlay.hidden, false, "reopens");
    p.fire(p.doc, "keydown", { key: "Enter" });
    assert.equal(overlay.hidden, false, "other keys leave it open");
    p.fire(p.doc, "keydown", { key: "Escape" });
    assert.equal(overlay.hidden, true, "Escape closes it");
  });

  test("clicking a fallback card never opens the overlay", async () => {
    const p = page();
    const f = sceneFetch(() => jsonResponse({ tier: 3, reason: "timeout" }));
    await api("runScenes")(cards(1), { doc: p.doc, fetch: f.fn, image: IMAGE });
    for (const node of findAll(p.els.scenes, () => true)) p.fire(node, "click");
    assert.equal(p.els["scene-overlay"].hidden, true);
  });
});

// Covers: MEM-029
// Requirement: tier 3, a non-2xx answer or a network error shows "Scene unavailable: <code>" for
// that card only; the run never throws, the other cards keep going, and panel order follows the
// cards, not the answer order.
describe("runScenes: failures fall back per card", () => {
  test('tier 3 shows "Scene unavailable: <reason>"', async () => {
    const p = page();
    const f = sceneFetch(() => jsonResponse({ tier: 3, reason: "timeout" }));
    const results = await api("runScenes")(cards(1), { doc: p.doc, fetch: f.fn, image: IMAGE });
    assert.match(p.els.scenes.textContent, /Scene unavailable: timeout/);
    assert.deepEqual(imgsIn(p.els.scenes), []);
    assert.deepEqual(results[0], { tier: 3, reason: "timeout" });
  });

  test("502, 500 without JSON and a network error each fall back; the tier-1 card still renders", async () => {
    const p = page();
    const f = sceneFetch((body) => {
      const item = body.record.item;
      if (item === "eggs") return jsonResponse({ error: "upstream" }, 502);
      if (item === "bread") return new Response("oops", { status: 500 });
      if (item === "apples") throw new TypeError("network down");
      return jsonResponse({ tier: 1, image: SCENE(item), width: W, height: H });
    });
    let results;
    await assert.doesNotReject(async () => {
      results = await api("runScenes")(cards(4), { doc: p.doc, fetch: f.fn, image: IMAGE });
    });
    const kids = panelCards(p);
    assert.equal(kids.length, 4, "one panel card per input card");
    assert.equal(imgsIn(kids[0]).length, 1, "tier-1 card keeps its image");
    assert.match(textOf(kids[1]), /Scene unavailable: upstream/);
    assert.match(textOf(kids[2]), /Scene unavailable: http_500/);
    assert.match(textOf(kids[3]), /Scene unavailable: network/);
    assert.deepEqual(
      results.map((r) => r.tier),
      [1, 3, 3, 3],
    );
  });

  test("panel order follows the cards even when answers arrive in reverse", async () => {
    const p = page();
    const pending = [];
    const fetch = (url, init) => {
      const d = deferred();
      pending.push({ body: JSON.parse(init.body), d });
      return d.promise;
    };
    const run = api("runScenes")(cards(3), { doc: p.doc, fetch, image: IMAGE });
    await until(() => pending.length === 3, "3 requests sent");
    for (const c of [...pending].reverse()) {
      c.d.resolve(jsonResponse({ tier: 3, reason: `r_${c.body.record.item}` }));
      await settle(5);
    }
    await run;
    const texts = panelCards(p).map(textOf);
    assert.equal(texts.length, 3);
    ["milk", "eggs", "bread"].forEach((item, i) => {
      assert.ok(texts[i].includes(item), `card ${i} shows ${item}: "${texts[i]}"`);
      assert.ok(texts[i].includes(LABELS[i]), `card ${i} shows locus ${LABELS[i]}`);
      assert.ok(texts[i].includes(`Scene unavailable: r_${item}`), `card ${i} shows its own reason`);
    });
  });
});

// Covers: MEM-029
// Requirement: model-derived text (item, locus label, tier-3 reason) is set via textContent only:
// hostile markup is shown as literal text and never becomes an element.
describe("scene panel text safety", () => {
  test("hostile item, label and reason render as literal text", async () => {
    const p = page();
    const hostile = "<img src=x onerror=alert(1)>";
    const input = [
      {
        item: hostile,
        locus: { n: 1, label: `${hostile}<script>alert(2)</script>`, box: { x1: 1, y1: 1, x2: 50, y2: 50 } },
        entry: { record: record("milk", "lamp", { visual: hostile }), status: "valid" },
      },
    ];
    const f = sceneFetch(() => jsonResponse({ tier: 3, reason: hostile }));
    await api("runScenes")(input, { doc: p.doc, fetch: f.fn, image: IMAGE });
    assert.deepEqual(p.htmlWrites, [], "no innerHTML/outerHTML/insertAdjacentHTML");
    const tags = p.madeByCode().map((e) => e.tagName);
    assert.ok(!tags.includes("IMG") && !tags.includes("SCRIPT"), `hostile markup became elements: ${tags}`);
    const text = p.els.scenes.textContent;
    assert.ok(text.includes(hostile), "hostile item shown verbatim");
    assert.ok(text.includes("<script>alert(2)</script>"), "hostile label shown verbatim");
    assert.ok(text.includes(`Scene unavailable: ${hostile}`), "hostile reason shown verbatim");
  });

  test("scenes.js never uses HTML-string sinks", () => {
    let src;
    try {
      src = readFileSync(new URL("./scenes.js", import.meta.url), "utf8");
    } catch {
      assert.fail("static/scenes.js missing");
    }
    assert.doesNotMatch(src, /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b/);
  });
});
