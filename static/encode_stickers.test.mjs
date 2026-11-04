// Covers: MEM-045
// Requirement: "Load demo" opens the sticker board on the demo landmark photo. Once the /loci payload is valid,
// runDemoPalace calls deps.stickers.show exactly once with {placeKey: "demo", width, height, loci} from that
// payload; the demo still reaches the walk view when deps.stickers is absent or its show fails, and show is not
// called when /loci fails.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { fakePage, jsonResponse, memoryAdapter, record, visibleText } from "./fake_dom_test.mjs";
import { createPalaceStore } from "./palace_store.js";

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
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const IDS = [
  "route-review", "route", "route-edit", "route-live", "route-toast", "route-toast-text", "route-undo", "generate", "auto", "walk", "walk-prev", "walk-next", "walk-step",
  "scenes", "scene-overlay", "assoc-status", "associations", "upload-status", "scene", "loci", "status",
];

function demoFetch({ lociStatus = 200 } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (u === "/demo/photo.jpg") return new Response(PHOTO, { headers: { "content-type": "image/jpeg" } });
    if (u === "/loci") {
      return lociStatus === 200
        ? jsonResponse({ image: IMAGE, width: 800, height: 600, loci: LOCI })
        : jsonResponse({ error: "loci_failed" }, lociStatus);
    }
    if (u === "/demo/notes.txt") return new Response("Buy milk. Then eggs. Then bread.", { headers: { "content-type": "text/plain" } });
    if (u === "/split") return jsonResponse({ points: POINTS });
    if (u === "/associate") return jsonResponse({ record: record(body.item, body.locus), status: "valid", sig: `sig_${body.item}` });
    if (u === "/scenes") return jsonResponse({ tier: 1, image: `data:image/jpeg;base64,U0NFTkU${body.record.item}`, width: 800, height: 600 });
    return jsonResponse({ error: "not_found" }, 404);
  };
}

function setup(extra = {}) {
  const p = fakePage(IDS, { hidden: ["route-review", "route-toast", "walk", "scene-overlay"] });
  const deps = {
    doc: p.doc,
    fetch: demoFetch(extra.fetchOpts),
    store: createPalaceStore(memoryAdapter()),
    loadImage: async (src) => ({ src }),
    ...extra.deps,
  };
  return { p, deps };
}

const step = (p) => visibleText(p.els["walk-step"]);

// Covers: MEM-045
// Requirement: runDemoPalace hands the demo photo's size and loci to the sticker board once, and a missing or
// failing board never breaks the demo.
describe("runDemoPalace opens the sticker board (MEM-045)", () => {
  test("calls deps.stickers.show once with placeKey demo and the /loci width, height, loci", async () => {
    const shows = [];
    const { p, deps } = setup({ deps: { stickers: { show: (view) => { shows.push(structuredClone(view)); } } } });
    await api("runDemoPalace")({ auto: true }, deps);
    assert.deepEqual(shows, [{ placeKey: "demo", width: 800, height: 600, loci: LOCI }]);
    assert.match(step(p), /\b1 of 3\b/, "demo still reaches the walk view");
  });

  test("completes without deps.stickers", async () => {
    const { p, deps } = setup();
    await assert.doesNotReject(api("runDemoPalace")({ auto: true }, deps));
    assert.match(step(p), /\b1 of 3\b/);
  });

  test("a rejecting stickers.show does not break the demo", async () => {
    let called = 0;
    const show = () => {
      called += 1;
      return Promise.reject(new Error("sticker board failed"));
    };
    const { p, deps } = setup({ deps: { stickers: { show } } });
    await assert.doesNotReject(api("runDemoPalace")({ auto: true }, deps));
    assert.equal(called, 1);
    assert.match(step(p), /\b1 of 3\b/);
  });

  test("a failed /loci never opens the sticker board", async () => {
    const shows = [];
    const { deps } = setup({ fetchOpts: { lociStatus: 500 }, deps: { stickers: { show: (v) => { shows.push(v); } } } });
    await assert.doesNotReject(api("runDemoPalace")({ auto: true }, deps));
    assert.deepEqual(shows, []);
  });
});
