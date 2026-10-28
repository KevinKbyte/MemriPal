// Covers: MEM-030
// Requirement: the encode UI runs route review (arrow reorder; drop = confirm then Undo, never a
// single click) -> generate (resumable) -> walk view (prev/next, scene, 8 KAVE channels); the
// "auto" flag (D19) skips review with 0 clicks; "Load demo" runs the fixture palace end to end;
// image src only from data:image/(png|jpeg|webp) base64 or Blob URLs; model text via textContent.
// Contract (RED; GREEN implements, ADR 0021):
//   static/encode.js (new module) exports
//     createRouteReview(loci) -> {order(), move(i, delta), requestDrop(i), pendingDrop(),
//       confirmDrop(), cancelDrop(), undo()}: order() = current loci (input never mutated);
//       move(i, -1|1) -> false at a boundary (no change); requestDrop(i) only marks i pending
//       (pendingDrop() -> i, or null; out of range -> null); confirmDrop() removes it (false
//       when nothing is pending); undo() restores the most recent drop at its index (stack;
//       false when empty).
//     runEncode(input, deps) -> Promise, resolves once the walk view shows step 1.
//       input = {image, loci, points, auto}: image = /loci data URL, loci = /loci loci
//       [{n, label, box}], points = /split points [{label, source_quote}].
//       deps = {doc, fetch, store}; store = createPalaceStore(adapter).
//       auto false: shows #route-review (hidden=false) with one <li> per locus in #route (text
//       includes the label), each holding <button>s with data-action "up" / "down" / "drop"; a
//       pending drop adds a "confirm-drop" button in that <li>; after a confirmed drop
//       #route-undo shows (hidden=false) and a click restores the locus and hides it again.
//       Nothing is generated until #generate is clicked. auto true: no review, no click needed,
//       #route-review stays hidden.
//       Generate: store.saveRoute(order); points[i] pairs with order[i]; POST /associate per pair
//       (body {image, item: point.label, locus: locus.label}), skipping valid records already
//       stored under associationKey (resume); then POST /scenes per pair (scenes.js runScenes).
//       Walk view: #walk hidden=false; #walk-step shows "<i> of <N>", item, locus label, the
//       scene (<img> with a safe src, or the "Scene unavailable" text) and the 8 channels (name +
//       text, KAVE order); #walk-prev / #walk-next step; disabled at the first / last step.
//     runDemoPalace({auto}, deps) -> Promise; deps = {doc, fetch, store, loadImage}: GET
//       /demo/photo.jpg -> POST /loci with those exact bytes -> GET /demo/notes.txt -> POST /split
//       JSON exactly {photo: <base64 of the /loci data URL>, mode: "notes", text, loci_count:
//       loci.length} -> runEncode. A failed step writes #upload-status, stops, never throws.
//   palace_store.js createPalaceStore gains saveRoute(loci) / loadRoute() (palace_store.test.mjs).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CHANNELS,
  SAFE_SRC,
  fakePage,
  find,
  findAll,
  jsonResponse,
  memoryAdapter,
  record,
  settle,
  until,
  visibleText,
} from "./fake_dom_test.mjs";
import { associationKey, createPalaceStore } from "./palace_store.js";

const encode = await import("./encode.js").catch((err) => ({ __missing: String(err) }));

function api(name) {
  assert.ok(name in encode, `static/encode.js must export ${name} (${encode.__missing ?? "not exported"})`);
  return encode[name];
}

const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const LABELS = ["lamp", "door", "clock"];
const ITEMS = ["milk", "eggs", "bread"];
const LOCI = LABELS.map((label, i) => ({ n: i + 1, label, box: { x1: 10 + i * 200, y1: 10, x2: 150 + i * 200, y2: 200 } }));
const POINTS = ITEMS.map((label) => ({ label, source_quote: `Buy ${label}` }));
const SCENE = (item) => `data:image/jpeg;base64,U0NFTkU${item}`;

const IDS = [
  "route-review", "route", "route-undo", "generate", "auto", "walk", "walk-prev", "walk-next", "walk-step",
  "scenes", "scene-overlay", "assoc-status", "associations", "upload-status", "scene", "loci", "status",
];
const page = () => fakePage(IDS, { hidden: ["route-review", "route-undo", "walk", "scene-overlay"] });

/** Opaque server signature the fake /associate returns for an item (MEM-036). */
const sigOf = (item) => `sig_${item}`;

/** Fetch for /associate and /scenes; sceneFor(item) -> /scenes JSON body. */
function flowFetch(sceneFor = (item) => ({ tier: 1, image: SCENE(item), width: 800, height: 600 })) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    if (url === "/associate") return jsonResponse({ record: record(body.item, body.locus), status: "valid", sig: sigOf(body.item) });
    if (url === "/scenes") return jsonResponse(sceneFor(body.record.item));
    return jsonResponse({ error: "not_found" }, 404);
  };
  const assoc = () => calls.filter((c) => c.url === "/associate").map((c) => [c.body.item, c.body.locus]);
  return { fn, calls, assoc };
}

function setup() {
  const p = page();
  const adapter = memoryAdapter();
  return { p, adapter, store: createPalaceStore(adapter) };
}

const lis = (p) => p.els.route.children.filter((c) => typeof c === "object" && c.tagName === "LI" && !c.hidden);
const labelOf = (li) => LABELS.find((l) => visibleText(li).includes(l));
const button = (root, action) =>
  find(root, (n) => n.tagName === "BUTTON" && n.dataset.action === action, { visibleOnly: true });
const step = (p) => visibleText(p.els["walk-step"]);

function input(extra = {}) {
  return { image: IMAGE, loci: structuredClone(LOCI), points: structuredClone(POINTS), auto: false, ...extra };
}

// Covers: MEM-030
// Requirement: the encode UI seam exists: encode.js exports and the page has its elements,
// including the D19 "auto" checkbox.
describe("encode UI seam", () => {
  test("encode.js exports createRouteReview, runEncode and runDemoPalace", () => {
    for (const name of ["createRouteReview", "runEncode", "runDemoPalace"]) assert.equal(typeof api(name), "function");
  });

  test("index.html has route review, generate, auto, walk view and undo elements", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    for (const id of ["route-review", "route", "route-undo", "generate", "walk", "walk-prev", "walk-next", "walk-step"]) {
      assert.match(html, new RegExp(`\\bid="${id}"`), id);
    }
    assert.match(html, /<input[^>]*\bid="auto"[^>]*>/);
    assert.match(html, /<input[^>]*\bid="auto"[^>]*\btype="checkbox"|<input[^>]*\btype="checkbox"[^>]*\bid="auto"/);
  });
});

// Covers: MEM-030
// Requirement: route review reorders by one step at a time, a drop is only a pending request
// until confirmed, and Undo restores the most recent drop where it was (D6).
describe("createRouteReview", () => {
  const labels = (r) => r.order().map((l) => l.label);

  test("move swaps neighbours and refuses to move past either end", () => {
    const r = api("createRouteReview")(structuredClone(LOCI));
    assert.deepEqual(labels(r), LABELS);
    assert.equal(r.move(1, -1), true);
    assert.deepEqual(labels(r), ["door", "lamp", "clock"]);
    assert.equal(r.move(0, -1), false);
    assert.equal(r.move(2, 1), false);
    assert.deepEqual(labels(r), ["door", "lamp", "clock"]);
    assert.equal(r.move(1, 1), true);
    assert.deepEqual(labels(r), ["door", "clock", "lamp"]);
  });

  test("requestDrop alone removes nothing; confirmDrop removes; undo restores at the same index", () => {
    const r = api("createRouteReview")(structuredClone(LOCI));
    r.requestDrop(1);
    assert.deepEqual(labels(r), LABELS, "a single drop request must not delete");
    assert.equal(r.pendingDrop(), 1);
    assert.equal(r.confirmDrop(), true);
    assert.deepEqual(labels(r), ["lamp", "clock"]);
    assert.equal(r.pendingDrop(), null);
    assert.equal(r.undo(), true);
    assert.deepEqual(labels(r), LABELS);
    assert.equal(r.undo(), false, "nothing left to undo");
  });

  test("cancelDrop clears the pending drop; confirmDrop without one is a no-op", () => {
    const r = api("createRouteReview")(structuredClone(LOCI));
    assert.equal(r.confirmDrop(), false);
    r.requestDrop(0);
    r.cancelDrop();
    assert.equal(r.pendingDrop(), null);
    assert.equal(r.confirmDrop(), false);
    assert.deepEqual(labels(r), LABELS);
    r.requestDrop(7);
    assert.equal(r.pendingDrop(), null, "out-of-range index is never pending");
  });

  test("undo is a stack: two drops undo newest first", () => {
    const r = api("createRouteReview")(structuredClone(LOCI));
    r.requestDrop(1);
    r.confirmDrop();
    r.requestDrop(1);
    r.confirmDrop();
    assert.deepEqual(labels(r), ["lamp"]);
    r.undo();
    assert.deepEqual(labels(r), ["lamp", "clock"]);
    r.undo();
    assert.deepEqual(labels(r), LABELS);
  });

  test("never mutates the input array; an empty route is safe", () => {
    const loci = structuredClone(LOCI);
    const r = api("createRouteReview")(loci);
    r.move(0, 1);
    r.requestDrop(0);
    r.confirmDrop();
    assert.deepEqual(loci, LOCI);
    const empty = api("createRouteReview")([]);
    assert.deepEqual(empty.order(), []);
    assert.equal(empty.move(0, 1), false);
  });
});

// Covers: MEM-030
// Requirement: in the page, arrow buttons reorder the route, one click on drop never deletes
// (confirm first, then Undo is offered), nothing generates before Generate, associations follow
// the reviewed order, and the reviewed route is saved so it survives a reload.
describe("runEncode: route review in the page", () => {
  test("review is shown and nothing is generated until Generate is clicked", async () => {
    const { p, store } = setup();
    const f = flowFetch();
    const run = api("runEncode")(input(), { doc: p.doc, fetch: f.fn, store });
    await until(() => lis(p).length === 3, "3 loci listed");
    await settle();
    assert.equal(p.els["route-review"].hidden, false);
    assert.deepEqual(lis(p).map(labelOf), LABELS);
    assert.deepEqual(f.calls, [], "no request before Generate");
    p.fire(p.els.generate, "click");
    await run;
    assert.deepEqual(f.assoc(), ITEMS.map((item, i) => [item, LABELS[i]]));
  });

  test("down arrow reorders; associations follow the new order and the route is saved", async () => {
    const { p, adapter, store } = setup();
    const f = flowFetch();
    const run = api("runEncode")(input(), { doc: p.doc, fetch: f.fn, store });
    await until(() => lis(p).length === 3, "3 loci listed");
    p.fire(button(lis(p)[0], "down"), "click");
    await until(() => labelOf(lis(p)[0]) === "door", "lamp moved down");
    assert.deepEqual(lis(p).map(labelOf), ["door", "lamp", "clock"]);
    p.fire(button(lis(p)[2], "up"), "click");
    await until(() => labelOf(lis(p)[1]) === "clock", "clock moved up");
    p.fire(p.els.generate, "click");
    await run;
    assert.deepEqual(f.assoc(), [
      ["milk", "door"],
      ["eggs", "clock"],
      ["bread", "lamp"],
    ]);
    const reloaded = await createPalaceStore(adapter).loadRoute();
    assert.deepEqual(
      reloaded.map((l) => l.label),
      ["door", "clock", "lamp"],
    );
  });

  test("drop needs a confirm click, offers Undo, and Undo restores the locus", async () => {
    const { p, store } = setup();
    const run = api("runEncode")(input(), { doc: p.doc, fetch: flowFetch().fn, store });
    await until(() => lis(p).length === 3, "3 loci listed");
    p.fire(button(lis(p)[1], "drop"), "click");
    await settle();
    assert.equal(lis(p).length, 3, "one click on drop must not delete");
    const confirm = button(lis(p)[1], "confirm-drop");
    assert.ok(confirm, "a confirm-drop button appears in the pending row");
    p.fire(confirm, "click");
    await until(() => lis(p).length === 2, "dropped after confirm");
    assert.deepEqual(lis(p).map(labelOf), ["lamp", "clock"]);
    assert.equal(p.els["route-undo"].hidden, false, "Undo offered after a drop");
    p.fire(p.els["route-undo"], "click");
    await until(() => lis(p).length === 3, "restored by Undo");
    assert.deepEqual(lis(p).map(labelOf), LABELS);
    assert.equal(p.els["route-undo"].hidden, true, "Undo hidden once nothing is left to undo");
    p.fire(p.els.generate, "click");
    await run;
  });

  test("a confirmed drop is never generated for", async () => {
    const { p, store } = setup();
    const f = flowFetch();
    const run = api("runEncode")(input({ points: POINTS.slice(0, 2) }), { doc: p.doc, fetch: f.fn, store });
    await until(() => lis(p).length === 3, "3 loci listed");
    p.fire(button(lis(p)[1], "drop"), "click");
    await until(() => button(lis(p)[1], "confirm-drop"), "confirm offered");
    p.fire(button(lis(p)[1], "confirm-drop"), "click");
    await until(() => lis(p).length === 2, "dropped");
    p.fire(p.els.generate, "click");
    await run;
    assert.deepEqual(f.assoc(), [
      ["milk", "lamp"],
      ["eggs", "clock"],
    ]);
  });
});

// Covers: MEM-030
// Requirement: with "auto" on (D19) the flow goes straight to generate with 0 review clicks;
// generate is resumable (valid stored records are not regenerated).
describe("runEncode: auto flag and resume", () => {
  test("auto on: walk view reached with zero clicks; review never shown", async () => {
    const { p, store } = setup();
    const f = flowFetch();
    await api("runEncode")(input({ auto: true }), { doc: p.doc, fetch: f.fn, store });
    assert.equal(p.els["route-review"].hidden, true);
    assert.equal(p.els.walk.hidden, false);
    assert.deepEqual(f.assoc(), ITEMS.map((item, i) => [item, LABELS[i]]));
    const sceneBodies = f.calls.filter((c) => c.url === "/scenes").map((c) => c.body);
    assert.equal(sceneBodies.length, 3);
    assert.deepEqual(
      sceneBodies.map((b) => [b.record.item, b.sig]),
      ITEMS.map((item) => [item, sigOf(item)]),
      "each /scenes request carries its record's /associate sig",
    );
  });

  test("resume: a valid stored record is reused without a request", async () => {
    const { p, store } = setup();
    await store.put(associationKey("milk", "lamp"), { record: record("milk", "lamp"), status: "valid", sig: sigOf("milk") });
    const f = flowFetch();
    await api("runEncode")(input({ auto: true }), { doc: p.doc, fetch: f.fn, store });
    assert.deepEqual(f.assoc(), [
      ["eggs", "door"],
      ["bread", "clock"],
    ]);
    const reused = f.calls.find((c) => c.url === "/scenes" && c.body.record.item === "milk");
    assert.ok(reused, "the reused record still gets its scene");
    assert.deepEqual([reused.body.record, reused.body.sig], [record("milk", "lamp"), sigOf("milk")], "with the stored record and sig");
  });
});

// Covers: MEM-030
// Requirement: the walk view steps through the palace with prev/next, showing each step's item,
// locus, scene and the 8 KAVE channels in order; only safe image srcs reach an <img> and model
// text is never parsed as HTML.
describe("runEncode: walk view", () => {
  const sceneFor = (item) =>
    item === "eggs" ? { tier: 3, reason: "timeout" } : { tier: 1, image: SCENE(item), width: 800, height: 600 };

  test("step 1 shows item, locus, scene and the 8 channels in KAVE order; prev disabled", async () => {
    const { p, store } = setup();
    await api("runEncode")(input({ auto: true }), { doc: p.doc, fetch: flowFetch(sceneFor).fn, store });
    const text = step(p);
    assert.match(text, /\b1 of 3\b/);
    assert.ok(text.includes("milk") && text.includes("lamp"), text);
    assert.ok(!text.includes("eggs"), "only the current step is visible");
    const rec = record("milk", "lamp");
    let at = -1;
    for (const c of CHANNELS) {
      const name = text.toLowerCase().indexOf(c, at + 1);
      assert.ok(name > at, `channel ${c} after the previous one`);
      const value = text.indexOf(rec[c], name);
      assert.ok(value > name, `channel ${c} text after its name`);
      at = value;
    }
    const img = find(p.els["walk-step"], (n) => n.tagName === "IMG", { visibleOnly: true });
    assert.ok(img && SAFE_SRC.test(img.src), "scene image with a safe src");
    assert.equal(p.els["walk-prev"].disabled, true);
    assert.equal(p.els["walk-next"].disabled, false);
  });

  test("next/prev step through; the fallback step shows its reason; next disabled at the end", async () => {
    const { p, store } = setup();
    await api("runEncode")(input({ auto: true }), { doc: p.doc, fetch: flowFetch(sceneFor).fn, store });
    p.fire(p.els["walk-next"], "click");
    await until(() => /\b2 of 3\b/.test(step(p)), "step 2");
    assert.ok(step(p).includes("eggs") && step(p).includes("door"));
    assert.match(step(p), /Scene unavailable: timeout/);
    assert.equal(find(p.els["walk-step"], (n) => n.tagName === "IMG", { visibleOnly: true }), null);
    p.fire(p.els["walk-next"], "click");
    await until(() => /\b3 of 3\b/.test(step(p)), "step 3");
    assert.equal(p.els["walk-next"].disabled, true);
    p.fire(p.els["walk-prev"], "click");
    await until(() => /\b2 of 3\b/.test(step(p)), "back to step 2");
    assert.equal(p.els["walk-prev"].disabled, false);
  });

  test("unsafe scene srcs never reach an <img>", async () => {
    const { p, store } = setup();
    const bad = { milk: "javascript:alert(1)", eggs: "data:image/svg+xml;base64,PHN2Zz4=", bread: "https://evil.example/a.png" };
    const f = flowFetch((item) => ({ tier: 1, image: bad[item], width: 800, height: 600 }));
    await api("runEncode")(input({ auto: true }), { doc: p.doc, fetch: f.fn, store });
    assert.deepEqual(p.srcWrites.filter((s) => !SAFE_SRC.test(s)), []);
    assert.equal(findAll(p.els["walk-step"], (n) => n.tagName === "IMG").length, 0);
    assert.match(step(p), /Scene unavailable/);
  });

  test("hostile record text renders literally, never through an HTML sink", async () => {
    const { p, store } = setup();
    const hostile = "<img src=x onerror=alert(1)>";
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (url === "/associate") {
        return jsonResponse({ record: record(body.item, body.locus, { visual: hostile }), status: "valid", sig: sigOf(body.item) });
      }
      return jsonResponse({ tier: 3, reason: "timeout" });
    };
    await api("runEncode")(input({ auto: true }), { doc: p.doc, fetch, store });
    assert.deepEqual(p.htmlWrites, []);
    assert.ok(step(p).includes(hostile));
    assert.match(step(p), /Scene unavailable: timeout/, "the signed record reached the /scenes render path");
    assert.ok(!p.madeByCode().some((e) => e.tagName === "IMG" || e.tagName === "SCRIPT"));
  });

  test("encode.js never uses HTML-string sinks", () => {
    let src;
    try {
      src = readFileSync(new URL("./encode.js", import.meta.url), "utf8");
    } catch {
      assert.fail("static/encode.js missing");
    }
    assert.doesNotMatch(src, /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b/);
  });
});

// Covers: MEM-030
// Requirement: "Load demo" runs the fixture palace end to end: demo photo -> loci -> demo notes
// -> split -> associations -> scenes -> walk view; a failed step stops cleanly with a status.
describe("runDemoPalace", () => {
  const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const NOTES = "Buy milk. Then eggs. Then bread.";

  function demoFetch(photoStatus = 200) {
    const calls = [];
    const flow = flowFetch();
    const fn = async (url, init = {}) => {
      const u = String(url);
      const method = (init.method ?? "GET").toUpperCase();
      if (u === "/demo/photo.jpg") {
        calls.push({ u, method });
        return photoStatus === 200 ? new Response(PHOTO, { headers: { "content-type": "image/jpeg" } }) : jsonResponse({ error: "demo_missing" }, photoStatus);
      }
      if (u === "/loci") {
        calls.push({ u, method, bytes: new Uint8Array(await new Response(init.body).arrayBuffer()) });
        return jsonResponse({ image: IMAGE, width: 800, height: 600, loci: LOCI });
      }
      if (u === "/demo/notes.txt") {
        calls.push({ u, method });
        return new Response(NOTES, { headers: { "content-type": "text/plain" } });
      }
      if (u === "/split") {
        calls.push({ u, method, body: JSON.parse(init.body) });
        return jsonResponse({ points: POINTS });
      }
      calls.push({ u, method });
      return flow.fn(url, init);
    };
    return { fn, calls };
  }

  test("auto on: photo -> /loci (same bytes) -> notes -> /split -> associate x3 -> scenes x3 -> walk", async () => {
    const { p, store } = setup();
    const f = demoFetch();
    const deps = { doc: p.doc, fetch: f.fn, store, loadImage: async (src) => ({ src }) };
    await api("runDemoPalace")({ auto: true }, deps);
    const seq = f.calls.map((c) => `${c.method} ${c.u}`);
    const at = (s) => seq.indexOf(s);
    assert.ok(at("GET /demo/photo.jpg") >= 0 && at("GET /demo/photo.jpg") < at("POST /loci"), seq.join(", "));
    assert.ok(at("POST /loci") < at("POST /split") && at("GET /demo/notes.txt") < at("POST /split"), seq.join(", "));
    assert.ok(at("POST /split") < at("POST /associate"), seq.join(", "));
    assert.deepEqual([...f.calls.find((c) => c.u === "/loci").bytes], [...PHOTO], "demo photo POSTed byte-for-byte");
    assert.deepEqual(f.calls.find((c) => c.u === "/split").body, {
      photo: IMAGE.slice(IMAGE.indexOf(",") + 1),
      mode: "notes",
      text: NOTES,
      loci_count: 3,
    });
    assert.equal(seq.filter((s) => s === "POST /associate").length, 3);
    assert.equal(seq.filter((s) => s === "POST /scenes").length, 3);
    assert.match(step(p), /\b1 of 3\b/);
  });

  test("a missing demo photo stops before /loci, shows a status and never throws", async () => {
    const { p, store } = setup();
    const f = demoFetch(404);
    const deps = { doc: p.doc, fetch: f.fn, store, loadImage: async (src) => ({ src }) };
    await assert.doesNotReject(api("runDemoPalace")({ auto: true }, deps));
    assert.deepEqual(
      f.calls.map((c) => c.u),
      ["/demo/photo.jpg"],
    );
    assert.notEqual(p.els["upload-status"].textContent.trim(), "");
  });
});
