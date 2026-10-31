// Covers: MEM-022
// Requirement: taste is optional (Kev's 'Optional taste'): a walk step whose record has no gustatory key
// or a blank gustatory channel shows no taste row, while the other 7 channels still show in order; a
// record that has taste text still shows the gustatory row. Drives runEncode (the page's path).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { CHANNELS, fakePage, findAll, jsonResponse, memoryAdapter, record } from "./fake_dom_test.mjs";
import { createPalaceStore } from "./palace_store.js";

const encode = await import("./encode.js").catch((err) => ({ __missing: String(err) }));

const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const LOCI = [{ n: 1, label: "lamp", box: { x1: 10, y1: 10, x2: 150, y2: 200 } }];
const POINTS = [{ label: "milk", source_quote: "Buy milk" }];
const IDS = [
  "route-review", "route", "route-undo", "generate", "auto", "walk", "walk-prev", "walk-next", "walk-step",
  "scenes", "scene-overlay", "assoc-status", "associations", "upload-status", "scene", "loci", "status",
];
const OTHERS = CHANNELS.filter((c) => c !== "gustatory");

/** Walk step 1 after an auto runEncode whose /associate record is shaped by edit(record). */
async function walkWith(edit) {
  assert.equal(typeof encode.runEncode, "function", `encode.js must export runEncode (${encode.__missing ?? ""})`);
  const p = fakePage(IDS, { hidden: ["route-review", "route-undo", "walk", "scene-overlay"] });
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url === "/associate") {
      const rec = record(body.item, body.locus);
      edit(rec);
      return jsonResponse({ record: rec, status: "valid", sig: `sig_${body.item}` });
    }
    if (url === "/scenes") return jsonResponse({ tier: 3, reason: "timeout" });
    return jsonResponse({ error: "not_found" }, 404);
  };
  const input = { image: IMAGE, loci: structuredClone(LOCI), points: structuredClone(POINTS), auto: true };
  await encode.runEncode(input, { doc: p.doc, fetch, store: createPalaceStore(memoryAdapter()) });
  const dts = findAll(p.els["walk-step"], (n) => n.tagName === "DT", { visibleOnly: true });
  assert.ok(dts.length > 0, "walk step 1 shows channel rows");
  return dts.map((n) => n.textContent.toLowerCase());
}

describe("runEncode walk view: optional taste row", () => {
  const cases = {
    "no gustatory key": (r) => delete r.gustatory,
    "empty gustatory": (r) => (r.gustatory = ""),
    "blank gustatory": (r) => (r.gustatory = "   "),
  };
  for (const [name, edit] of Object.entries(cases)) {
    test(`${name}: no taste row; the other 7 channels show in order`, async () => {
      assert.deepEqual(await walkWith(edit), OTHERS);
    });
  }

  test("taste text present: the gustatory row still shows, all 8 in order", async () => {
    assert.deepEqual(await walkWith(() => {}), CHANNELS);
  });
});
