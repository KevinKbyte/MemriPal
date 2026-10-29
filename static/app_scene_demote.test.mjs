// Covers: MEM-042
// Requirement: I7 a sig verifies only under the issuing instance's key, so when /scenes answers 403
// bad_signature the page re-puts that stored entry with status "invalid" (record kept); the next
// run then regenerates it and gets a fresh signed record instead of reusing a dead sig forever.
// Any other scene failure leaves the stored entry exactly as it was.
// Contract (RED; GREEN implements in static/encode.js runEncode):
//   after runScenes, for every step whose scene result is {tier: 3, reason: "bad_signature"},
//   store.put(associationKey(item, locus.label), {...stored, status: "invalid"}) with the record
//   unchanged. No other result changes the store.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { fakePage, jsonResponse, memoryAdapter, record } from "./fake_dom_test.mjs";
import { associationKey, createPalaceStore } from "./palace_store.js";

const encode = await import("./encode.js").catch((err) => ({ __missing: String(err) }));

function runEncode() {
  assert.ok("runEncode" in encode, `static/encode.js must export runEncode (${encode.__missing ?? "not exported"})`);
  return encode.runEncode;
}

const IDS = [
  "route-review", "route", "route-undo", "generate", "assoc-status", "associations",
  "scenes", "scene-overlay", "walk", "walk-step", "walk-prev", "walk-next",
];
const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const SCENE = "data:image/jpeg;base64,U0NFTkU=";
const LOCI = ["lamp", "door"].map((label, i) => ({ n: i + 1, label, box: { x1: 10 + i * 200, y1: 10, x2: 150 + i * 200, y2: 200 } }));
const POINTS = ["milk", "eggs"].map((label) => ({ label, source_quote: `Buy ${label}` }));
const OLD_SIG = "0".repeat(64);
const NEW_SIG = "f".repeat(64);

/** Fake server: /associate signs with NEW_SIG; /scenes answers via scenes(body). */
function server(scenes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ u, body });
    if (u === "/associate") {
      return jsonResponse({ item: body.item, locus: body.locus, status: "valid", attempts: 1, record: record(body.item, body.locus), sig: NEW_SIG });
    }
    if (u === "/scenes") return scenes(body);
    return jsonResponse({ error: "not_found" }, 404);
  };
  return { fn, calls, posts: (u) => calls.filter((c) => c.u === u) };
}

const ok = () => jsonResponse({ tier: 1, image: SCENE, width: 800, height: 600 });
const badSig = () => jsonResponse({ error: "bad_signature" }, 403);

/** A palace store already holding a valid entry signed by another instance for every pair. */
async function seeded(items = POINTS.map((p) => p.label)) {
  const adapter = memoryAdapter();
  const store = createPalaceStore(adapter);
  for (const [i, item] of items.entries()) {
    await store.put(associationKey(item, LOCI[i].label), { record: record(item, LOCI[i].label), status: "valid", sig: OLD_SIG });
  }
  return { adapter, store };
}

function run(store, srv) {
  const p = fakePage(IDS, { hidden: ["route-review", "route-undo", "walk", "scene-overlay"] });
  return runEncode()({ image: IMAGE, loci: LOCI, points: POINTS, auto: true }, { doc: p.doc, fetch: srv.fn, store });
}

const stored = (store, i) => store.get(associationKey(POINTS[i].label, LOCI[i].label));

// Covers: MEM-042
// Requirement: I7 a 403 bad_signature demotes exactly the refused stored entry to "invalid" (record
// kept, imported or generated alike), and the next run regenerates it with a fresh signed record.
describe("MEM-042 I7: a dead sig demotes its stored entry", () => {
  test("403 bad_signature -> stored entry re-put with status invalid, record unchanged", async () => {
    const { store } = await seeded();
    const srv = server(badSig);
    await run(store, srv);
    assert.equal(srv.posts("/associate").length, 0, "valid stored entries were reused");
    assert.equal(srv.posts("/scenes").length, 2, "the stored sig was sent and refused");
    for (const i of [0, 1]) {
      const got = await stored(store, i);
      assert.equal(got.status, "invalid", `${POINTS[i].label} demoted`);
      assert.deepEqual(got.record, record(POINTS[i].label, LOCI[i].label), "record kept");
    }
  });

  test("only the refused entry is demoted; the accepted one stays valid", async () => {
    const { store } = await seeded();
    const before = await stored(store, 1);
    await run(store, server((body) => (body.record.item === "milk" ? badSig() : ok())));
    assert.equal((await stored(store, 0)).status, "invalid");
    assert.deepEqual(await stored(store, 1), before, "eggs untouched");
  });

  test("the next run regenerates the demoted entry and stores the fresh sig", async () => {
    const { store } = await seeded();
    await run(store, server(badSig));
    const srv = server(ok);
    await run(store, srv);
    assert.deepEqual(srv.posts("/associate").map((c) => c.body.item).sort(), ["eggs", "milk"], "demoted entries regenerated");
    for (const i of [0, 1]) assert.deepEqual(await stored(store, i), { record: record(POINTS[i].label, LOCI[i].label), status: "valid", sig: NEW_SIG });
    assert.deepEqual(srv.posts("/scenes").map((c) => c.body.sig), [NEW_SIG, NEW_SIG], "the fresh sig is what /scenes gets");
  });

  test("an entry generated in this same run is demoted too", async () => {
    const store = createPalaceStore(memoryAdapter());
    const srv = server(badSig);
    await run(store, srv);
    assert.equal(srv.posts("/associate").length, 2);
    for (const i of [0, 1]) {
      const got = await stored(store, i);
      assert.equal(got.status, "invalid");
      assert.deepEqual(got.record, record(POINTS[i].label, LOCI[i].label));
    }
  });
});

// Covers: MEM-042
// Requirement: I7 only bad_signature demotes: any other scene failure (another 403 code, a 4xx/5xx,
// a network error, a tier-3 reply) or a tier-1 scene leaves the stored entry byte-for-byte as it was.
describe("MEM-042 I7: other scene outcomes never demote", () => {
  const cases = {
    "tier 1 scene": ok,
    "403 other code": () => jsonResponse({ error: "forbidden" }, 403),
    "403 without a body": () => new Response("", { status: 403 }),
    "400 bad_request": () => jsonResponse({ error: "bad_request" }, 400),
    "500": () => jsonResponse({ error: "upstream" }, 500),
    "429 budget_exhausted": () => jsonResponse({ error: "budget_exhausted" }, 429),
    "tier 3 reply": () => jsonResponse({ tier: 3, reason: "edit_failed" }),
    "200 with error bad_signature": () => jsonResponse({ error: "bad_signature" }),
    "network error": () => {
      throw new TypeError("fetch failed");
    },
  };
  for (const [name, answer] of Object.entries(cases)) {
    test(`${name}: stored entries unchanged`, async () => {
      const { adapter, store } = await seeded();
      const entries = () => [...adapter.map].filter(([k]) => k !== "route").sort();
      const before = entries();
      await run(store, server(answer));
      assert.deepEqual(entries(), before);
    });
  }
});
