// Covers: MEM-029, MEM-030
// Requirement: a demo (fixture-mode) server has no recorded scene for most places, so /scenes answers
// tier 3 with reason "fixture_missing" (or a 404 {"error": "fixture_missing"}). The walk view and the
// scenes panel must then say so in plain words: the text still mentions the scene and the demo, and
// never shows the raw code "fixture_missing" (seen as "Scene unavailable: fixture_missing" in the
// 0.17.3 walk screenshot). Other reasons keep "Scene unavailable: <code>" (pinned in encode.test.mjs).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  fakePage, jsonResponse, memoryAdapter, record, textOf, until, visibleText,
} from "./fake_dom_test.mjs";
import { createPalaceStore } from "./palace_store.js";

const encode = await import("./encode.js").catch((err) => ({ __missing: String(err) }));

const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const LABELS = ["lamp", "door"];
const box = (i) => ({ x1: 10 + i * 200, y1: 10, x2: 150 + i * 200, y2: 200 });
const LOCI = LABELS.map((label, i) => ({ n: i + 1, label, box: box(i) }));
const POINTS = ["milk", "eggs"].map((label) => ({ label, source_quote: `Buy ${label}` }));
const IDS = [
  "route-review", "route", "route-undo", "generate", "auto", "walk", "walk-prev", "walk-next", "walk-step",
  "scenes", "scene-overlay", "assoc-status", "associations", "upload-status", "scene", "loci", "status",
];

/** Fetch for /associate (signed valid records) and /scenes (answered by `scene()`). */
function demoFetch(scene) {
  return async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url === "/associate") {
      const signed = { record: record(body.item, body.locus), status: "valid", sig: `sig_${body.item}` };
      return jsonResponse(signed);
    }
    if (url === "/scenes") return scene();
    return jsonResponse({ error: "not_found" }, 404);
  };
}

async function walkWith(scene) {
  const missing = encode.__missing ?? "";
  assert.equal(typeof encode.runEncode, "function", `static/encode.js must export runEncode (${missing})`);
  const p = fakePage(IDS, { hidden: ["route-review", "route-undo", "walk", "scene-overlay"] });
  const input = { image: IMAGE, loci: structuredClone(LOCI), points: structuredClone(POINTS), auto: true };
  const store = createPalaceStore(memoryAdapter());
  await encode.runEncode(input, { doc: p.doc, fetch: demoFetch(scene), store });
  await until(() => /\b1 of 2\b/.test(visibleText(p.els["walk-step"])), "walk view at step 1");
  return p;
}

const ANSWERS = [
  ["tier 3 reason fixture_missing", () => jsonResponse({ tier: 3, reason: "fixture_missing" })],
  ["404 error fixture_missing", () => jsonResponse({ error: "fixture_missing" }, 404)],
];

// Covers: MEM-029, MEM-030
// Requirement: a demo scene that was never recorded reads as human copy, not a raw code (UX 102a).
describe("walk view when the demo server has no recorded scene", () => {
  for (const [name, scene] of ANSWERS) {
    test(`${name}: plain words about the demo scene, no raw fixture_missing code`, async () => {
      const p = await walkWith(scene);
      const step = visibleText(p.els["walk-step"]);
      const seen = JSON.stringify(step);
      assert.ok(step.includes("milk") && step.includes("lamp"), `step 1 shows its pair (${step})`);
      assert.ok(!step.includes("fixture_missing"), `walk step shows the raw code: ${seen}`);
      assert.match(step, /scene/i, `walk step still tells the user about the scene: ${seen}`);
      assert.match(step, /demo/i, `walk step says why (no demo scene here): ${seen}`);
      const panel = textOf(p.els.scenes);
      assert.ok(!panel.includes("fixture_missing"), `scenes panel shows the code: ${JSON.stringify(panel)}`);
    });
  }
});
