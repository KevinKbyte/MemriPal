// Covers: MEM-036
// Requirement: association records are signed by the server, and the page keeps each record's
// signature beside it and sends it back on every scene request, so a passcode holder can only ever
// ask for scenes of records the server itself produced. A record saved before signing existed (no
// sig) never reaches /scenes and shows the "Scene unavailable" fallback instead; a scene refused
// with 403 bad_signature (e.g. the server restarted with a new key) also shows the fallback. Neither
// case throws or stops the rest of the palace.
// Contract (RED; GREEN implements, ADR 0027):
//   POST /associate 200 -> {item, locus, status, attempts, record, sig}; sig = lowercase hex
//     HMAC-SHA256 of the canonical record (the client treats it as an opaque string).
//   app.js runAssociations stores the entry as {record, status, sig} under associationKey(item,
//     locus label) (sig beside record, not inside it), so a reload over the same storage keeps it.
//   scenes.js runScenes: a card whose entry.sig is a string POSTs /scenes with a JSON body of
//     exactly {image, box, record, sig} (sig = entry.sig, record = entry.record); a card whose
//     entry has no sig makes no request and its result is not tier 1 (null or {tier: 3, ...}), so
//     the walk view shows "Scene unavailable: <code>". A 403 {"error": "bad_signature"} becomes
//     {tier: 3, reason: "bad_signature"}. A stored valid entry without sig is not regenerated.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { fakePage, findAll, jsonResponse, record, settle, until, visibleText } from "./fake_dom_test.mjs";
import { associationKey, createPalaceStore, localStorageAdapter } from "./palace_store.js";
import { createRehearsalStore } from "./rehearsals.js";

const flow = await import("./flow.js").catch((err) => ({ __missing: String(err) }));
const scenes = await import("./scenes.js").catch((err) => ({ __missing: String(err) }));

function wireApp() {
  assert.ok("wireApp" in flow, `static/flow.js must export wireApp (${flow.__missing ?? "not exported"})`);
  return flow.wireApp;
}
function runScenes() {
  assert.ok("runScenes" in scenes, `static/scenes.js must export runScenes (${scenes.__missing ?? "not exported"})`);
  return scenes.runScenes;
}

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const SCENE = "data:image/jpeg;base64,U0NFTkU=";
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const NOTES = "Buy milk, eggs and bread.";
const POINTS = ["milk", "eggs", "bread"].map((label) => ({ label, source_quote: `Buy ${label}` }));
const LOCI = ["lamp", "door", "clock"].map((label, i) => ({ n: i + 1, label, box: { x1: 10 + i * 200, y1: 10, x2: 150 + i * 200, y2: 200 } }));
const SCENE_KEYS = ["box", "image", "record", "sig"];
const TURNS = 5000;

// Test-only server key; the client never sees it, only the hex signatures it produces.
const KEY = "test-record-key";
const canonical = (rec) => JSON.stringify(Object.fromEntries(Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
const sigFor = (rec) => createHmac("sha256", KEY).update(canonical(rec)).digest("hex");

/** Page roots exactly as index.html declares them (ids, and which start hidden). */
function pageFromHtml() {
  const ids = [];
  const hidden = [];
  for (const m of HTML.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
    const id = /\bid="([^"]+)"/.exec(m[0]);
    if (!id) continue;
    ids.push(id[1]);
    if (/\shidden(?=[\s>=/])/.test(m[0])) hidden.push(id[1]);
  }
  return fakePage(ids, { hidden });
}

/**
 * Fake server that signs like MEM-036: /associate returns {item, locus, status, attempts, record,
 * sig}; /scenes checks the exact key set (400 bad_request) and the sig (403 bad_signature).
 * opts.scenes(body) overrides the /scenes answer.
 */
function signingServer(opts = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ u, method, body });
    if (u === "/demo/photo.jpg") return new Response(PHOTO, { headers: { "content-type": "image/jpeg" } });
    if (u === "/demo/notes.txt") return new Response(NOTES, { headers: { "content-type": "text/plain" } });
    if (u === "/loci") return jsonResponse({ image: IMAGE, width: 800, height: 600, loci: LOCI });
    if (u === "/split") return jsonResponse({ points: POINTS });
    if (u === "/associate") {
      if (opts.associateDown) return jsonResponse({ error: "upstream" }, 502);
      const rec = record(body.item, body.locus);
      return jsonResponse({ item: body.item, locus: body.locus, status: "valid", attempts: 1, record: rec, sig: sigFor(rec) });
    }
    if (u === "/scenes") {
      if (opts.scenes) return opts.scenes(body);
      const keys = body && typeof body === "object" ? Object.keys(body).sort() : [];
      if (JSON.stringify(keys) !== JSON.stringify(SCENE_KEYS)) return jsonResponse({ error: "bad_request" }, 400);
      if (typeof body.sig !== "string" || body.sig !== sigFor(body.record)) return jsonResponse({ error: "bad_signature" }, 403);
      return jsonResponse({ tier: 1, image: SCENE, width: 800, height: 600 });
    }
    return jsonResponse({ error: "not_found" }, 404);
  };
  const posts = (u) => calls.filter((c) => c.method === "POST" && c.u === u);
  return { fn, calls, posts };
}

/** Storage stand-in: every value is a JSON string, exactly like a browser reload sees it. */
function fakeStorage() {
  const map = new Map();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

function kvAdapter() {
  const map = new Map();
  return {
    get: async (k) => map.get(k),
    put: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    list: async () => [...map.values()],
  };
}

/**
 * Records every unhandled rejection / uncaught exception for the rest of the test; listeners are
 * removed when the test ends.
 */
function watchUncaught(t) {
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  const onException = (err) => seen.push(err);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  t.after(() => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  });
  return seen;
}

/** A page with wireApp applied over a JSON palace storage (shared storage = a reload). */
function boot({ server = signingServer(), storage = fakeStorage() } = {}) {
  const p = pageFromHtml();
  let t = Date.UTC(2026, 9, 31, 9, 0, 0);
  let n = 0;
  const palace = localStorageAdapter("memripal.palace:", () => storage);
  wireApp()({
    doc: p.doc,
    fetch: server.fn,
    store: createPalaceStore(palace),
    rehearsals: createRehearsalStore(kvAdapter(), { now: () => (t += 60_000), newId: () => `reh-${++n}` }),
    getUserMedia: undefined,
    location: { hostname: "localhost" },
    loadImage: async (src) => ({ src }),
    confirm: () => true,
    wait: async () => {},
  });
  return { p, server, storage, palace };
}

const el = (b, id) => {
  const e = b.p.els[id];
  assert.ok(e, `index.html must contain #${id}`);
  return e;
};

async function loadDemo(b) {
  el(b, "auto").checked = true;
  b.p.fire(el(b, "load-demo"), "click");
  await until(() => !el(b, "walk").hidden || /Demo failed/.test(visibleText(el(b, "upload-status"))), "walk view shown", TURNS);
  assert.doesNotMatch(visibleText(el(b, "upload-status")), /Demo failed/, "the demo palace builds without an error");
  assert.equal(el(b, "walk").hidden, false, "walk view shown");
  await settle(20);
}

const storedEntry = (b, item, label) => {
  const raw = b.storage.getItem("memripal.palace:" + associationKey(item, label));
  return raw === null ? undefined : JSON.parse(raw);
};
const imgs = (node) => findAll(node, (n) => n.tagName === "IMG");

// Covers: MEM-036
// Requirement: the signature the server returns with each association is kept beside that record
// in the palace store, still there after a reload, and is what the page later sends for its scene.
describe("signed records: the sig from /associate is stored beside its record", () => {
  test("each generated association is stored as {record, status, sig} with the server's sig", async (t) => {
    const errors = watchUncaught(t);
    const b = boot();
    await loadDemo(b);
    assert.equal(b.server.posts("/associate").length, POINTS.length);
    POINTS.forEach((pt, i) => {
      const entry = storedEntry(b, pt.label, LOCI[i].label);
      assert.ok(entry, `entry stored for ${pt.label}`);
      assert.deepEqual(entry.record, record(pt.label, LOCI[i].label), "record stored unchanged");
      assert.equal(entry.status, "valid");
      assert.equal(entry.sig, sigFor(entry.record), `sig stored beside the record for ${pt.label}`);
      assert.equal("sig" in entry.record, false, "sig sits beside the record, never inside it");
    });
    assert.deepEqual(errors, []);
  });

  test("after a reload the stored sig is the one sent to /scenes, with no re-generation", async (t) => {
    const errors = watchUncaught(t);
    const first = boot();
    await loadDemo(first);
    const sigs = POINTS.map((pt, i) => storedEntry(first, pt.label, LOCI[i].label)?.sig);
    assert.ok(sigs.every((s) => typeof s === "string" && s.length > 0), `sigs stored: ${JSON.stringify(sigs)}`);

    const again = boot({ storage: first.storage, server: signingServer({ associateDown: true }) });
    await loadDemo(again);
    assert.equal(again.server.posts("/associate").length, 0, "valid signed records are reused after a reload");
    const sent = again.server.posts("/scenes");
    assert.equal(sent.length, POINTS.length);
    for (const c of sent) {
      const i = POINTS.findIndex((pt) => pt.label === c.body.record?.item);
      assert.ok(i >= 0, `scene request for a palace record: ${JSON.stringify(c.body.record)}`);
      assert.equal(c.body.sig, sigs[i], `stored sig sent for ${POINTS[i].label}`);
    }
    assert.equal(imgs(el(again, "scenes")).length, POINTS.length, "every signed scene renders after the reload");
    assert.deepEqual(errors, []);
  });
});

// Covers: MEM-036
// Requirement: every scene request carries the record together with its signature and nothing
// else the server would refuse: the body is exactly {image, box, record, sig}.
describe("signed records: /scenes body is exactly {image, box, record, sig}", () => {
  test("Load demo: every /scenes body has exactly those keys, with the stored record and sig", async (t) => {
    const errors = watchUncaught(t);
    const b = boot();
    await loadDemo(b);
    const sent = b.server.posts("/scenes");
    assert.equal(sent.length, POINTS.length, "one scene request per signed record");
    for (const c of sent) {
      assert.deepEqual(Object.keys(c.body).sort(), SCENE_KEYS, `body keys ${JSON.stringify(Object.keys(c.body))}`);
      const i = POINTS.findIndex((pt) => pt.label === c.body.record.item);
      assert.ok(i >= 0, "record of a palace point");
      const entry = storedEntry(b, POINTS[i].label, LOCI[i].label);
      assert.deepEqual(c.body.record, entry.record);
      assert.equal(c.body.sig, entry.sig);
      assert.equal(c.body.image, IMAGE);
      assert.deepEqual(c.body.box, LOCI[i].box);
    }
    assert.equal(imgs(el(b, "scenes")).length, POINTS.length, "the signing server accepts every request");
    assert.equal(imgs(el(b, "walk-step")).length, 1, "walk step 1 shows its scene");
    assert.deepEqual(errors, []);
  });

  test("runScenes sends entry.sig beside entry.record and nothing more", async () => {
    const p = fakePage(["scenes", "scene-overlay"], { hidden: ["scene-overlay"] });
    const rec = record("milk", "lamp");
    const sig = sigFor(rec);
    const bodies = [];
    const fetchFn = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ tier: 1, image: SCENE, width: 800, height: 600 });
    };
    const card = { item: "milk", locus: LOCI[0], entry: { record: rec, status: "valid", sig } };
    const results = await runScenes()([card], { doc: p.doc, fetch: fetchFn, image: IMAGE });
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0], { image: IMAGE, box: LOCI[0].box, record: rec, sig });
    assert.equal(results[0]?.tier, 1);
  });
});

// Covers: MEM-036
// Requirement: a palace saved before records were signed keeps working: an unsigned record is
// never sent to /scenes (nor silently regenerated) and its step shows "Scene unavailable", while
// the signed records around it still get their scenes; nothing throws.
describe("signed records: a stored record without sig makes no scene request", () => {
  test("pre-change palace: the unsigned record gets no /scenes call and shows the fallback", async (t) => {
    const errors = watchUncaught(t);
    const storage = fakeStorage();
    const old = record(POINTS[0].label, LOCI[0].label);
    storage.setItem("memripal.palace:" + associationKey(POINTS[0].label, LOCI[0].label), JSON.stringify({ record: old, status: "valid" }));
    const b = boot({ storage });
    await loadDemo(b);
    const sent = b.server.posts("/scenes");
    assert.equal(
      sent.filter((c) => c.body?.record?.item === POINTS[0].label).length,
      0,
      "no /scenes request for the record saved without a sig",
    );
    assert.equal(sent.length, POINTS.length - 1, "the signed records still request their scenes");
    assert.equal(
      b.server.posts("/associate").filter((c) => c.body.item === POINTS[0].label).length,
      0,
      "a stored valid record is reused as is, not regenerated",
    );
    assert.equal(imgs(el(b, "scenes")).length, POINTS.length - 1, "signed scenes still render");
    const step = el(b, "walk-step");
    assert.match(visibleText(step), new RegExp(`${POINTS[0].label} at ${LOCI[0].label}`), "walk starts at the unsigned step");
    assert.match(visibleText(step), /Scene unavailable/, "tier-3 fallback shown for the unsigned record");
    assert.equal(imgs(step).length, 0, "no scene image for the unsigned record");
    assert.deepEqual(errors, []);
  });

  test("runScenes: an entry without sig is skipped with a non-tier-1 result and no fetch", async () => {
    const p = fakePage(["scenes", "scene-overlay"], { hidden: ["scene-overlay"] });
    const rec = record("eggs", "door");
    const bodies = [];
    const fetchFn = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ tier: 1, image: SCENE, width: 800, height: 600 });
    };
    const signed = { item: "milk", locus: LOCI[0], entry: { record: record("milk", "lamp"), status: "valid", sig: sigFor(record("milk", "lamp")) } };
    const unsigned = { item: "eggs", locus: LOCI[1], entry: { record: rec, status: "valid" } };
    const results = await runScenes()([signed, unsigned], { doc: p.doc, fetch: fetchFn, image: IMAGE });
    assert.deepEqual(bodies.map((b) => b.record.item), ["milk"], "only the signed card is requested");
    assert.equal(results[0]?.tier, 1);
    assert.ok(results[1] === null || results[1].tier === 3, `unsigned result ${JSON.stringify(results[1])}`);
  });
});

// Covers: MEM-036
// Requirement: when the server refuses a scene with 403 bad_signature (for example after a
// restart with a new key) the step shows "Scene unavailable: bad_signature" and the rest of the
// palace, walk view and recall panel carry on; nothing throws.
describe("signed records: a 403 bad_signature shows the fallback", () => {
  test("Load demo: every scene refused with bad_signature -> fallback text, walk and recall still shown", async (t) => {
    const errors = watchUncaught(t);
    const server = signingServer({ scenes: () => jsonResponse({ error: "bad_signature" }, 403) });
    const b = boot({ server });
    await loadDemo(b);
    const sent = server.posts("/scenes");
    assert.equal(sent.length, POINTS.length);
    for (const c of sent) assert.equal(typeof c.body.sig, "string", "the stored sig was sent before the server refused it");
    assert.equal(imgs(el(b, "scenes")).length, 0);
    assert.match(visibleText(el(b, "walk-step")), /Scene unavailable: bad_signature/);
    await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
    assert.deepEqual(errors, []);
  });

  test("runScenes: 403 bad_signature -> {tier: 3, reason: bad_signature} after sending the sig", async () => {
    const p = fakePage(["scenes", "scene-overlay"], { hidden: ["scene-overlay"] });
    const rec = record("milk", "lamp");
    const bodies = [];
    const fetchFn = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ error: "bad_signature" }, 403);
    };
    const card = { item: "milk", locus: LOCI[0], entry: { record: rec, status: "valid", sig: "00".repeat(32) } };
    const results = await runScenes()([card], { doc: p.doc, fetch: fetchFn, image: IMAGE });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].sig, "00".repeat(32));
    assert.deepEqual(results, [{ tier: 3, reason: "bad_signature" }]);
    assert.match(visibleText(p.els.scenes), /Scene unavailable: bad_signature/);
  });
});
