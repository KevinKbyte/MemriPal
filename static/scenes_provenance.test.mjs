// Covers: MEM-046
// Requirement: scenes are shown as Muse Image returned them, marked "AI-generated": a tier-1 scene
// image whose rendered aspect matches the photo's keeps the locus zoom it has today; one whose
// aspect differs from the photo's by more than 2% is shown unzoomed (identity) instead of a wrong
// crop; every tier-1 scene card and the open full-size overlay carry exactly one .chip-ai.
// Contract (RED; GREEN implements, plan D2/B1):
//   static/scenes.js sceneView / runScenes: the server reports width/height = the PHOTO's dims while
//   the image bytes are the model reply (any size). On the tier-1 <img> "load" event (listener or
//   onload), read img.naturalWidth / img.naturalHeight; if |natural aspect / photo aspect - 1| > 0.02
//   the img transform becomes the identity zoom (scale 1, no translate; "" or "none" also count),
//   else it stays the zoomFor(box, width, height) transform set at render.
//   Chip: an element with class "chip-ai" and text "AI-generated" (plan Part A shared classes),
//   exactly one inside each tier-1 scene card (#scenes > section) and exactly one inside
//   #scene-overlay while it is open. Fake DOM surface: see fake_dom_test.mjs (no querySelector;
//   img.naturalWidth/naturalHeight are set by the test before it fires "load").
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { fakePage, findAll, jsonResponse, record } from "./fake_dom_test.mjs";

const scenes = await import("./scenes.js");

const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const W = 800;
const H = 600;
const BOX = { x1: 100, y1: 100, x2: 300, y2: 250 };
const SCENE = (tag) => `data:image/webp;base64,U0NFTkU${tag}`;
const ITEMS = ["milk", "eggs", "bread"];
const LABELS = ["lamp", "door", "clock"];

function cards(n) {
  return ITEMS.slice(0, n).map((item, i) => ({
    item,
    locus: { n: i + 1, label: LABELS[i], box: { ...BOX } },
    entry: { record: record(item, LABELS[i]), status: "valid", sig: `sig_${item}` },
  }));
}

const page = () => fakePage(["scenes", "scene-overlay"], { hidden: ["scene-overlay"] });

function sceneFetch(answer = (body) => jsonResponse({ tier: 1, image: SCENE(body.record.item), width: W, height: H })) {
  return async (_url, init) => answer(JSON.parse(init.body));
}

const imgsIn = (node) => findAll(node, (n) => n.tagName === "IMG");
const panelCards = (p) => p.els.scenes.children.filter((c) => typeof c === "object");
const hasClass = (n, cls) => String(n.className ?? "").split(/\s+/).includes(cls) || n.classList.contains(cls);
const chipsIn = (node) => findAll(node, (n) => hasClass(n, "chip-ai"));

/** {scale, tx, ty} from the scene transform string; "" / "none" is the identity. */
function parseZoom(transform) {
  const t = String(transform ?? "").trim();
  if (t === "" || t === "none") return { scale: 1, tx: 0, ty: 0 };
  const m = /^scale\(([^)]+)\)(?:\s*translate\(\s*([^,%]+)%\s*,\s*([^)%]+)%\s*\))?$/.exec(t);
  assert.ok(m, `unparsed transform "${t}"`);
  return { scale: Number(m[1]), tx: m[2] === undefined ? 0 : Number(m[2]) / 100, ty: m[3] === undefined ? 0 : Number(m[3]) / 100 };
}

function assertZoomClose(actual, expected, msg) {
  for (const k of ["scale", "tx", "ty"]) {
    assert.ok(Math.abs(actual[k] - expected[k]) < 1e-9, `${msg}: ${k} ${actual[k]} != ${expected[k]}`);
  }
}

/** Render one tier-1 card, then fire the img load with the given natural size. */
async function renderAndLoad(naturalWidth, naturalHeight) {
  const p = page();
  await scenes.runScenes(cards(1), { doc: p.doc, fetch: sceneFetch(), image: IMAGE });
  const [img] = imgsIn(p.els.scenes);
  assert.ok(img, "tier-1 scene image rendered");
  const before = String(img.style.transform ?? "");
  img.naturalWidth = naturalWidth;
  img.naturalHeight = naturalHeight;
  img.complete = true;
  p.fire(img, "load");
  return { p, img, before, after: parseZoom(img.style.transform) };
}

const IDENTITY = { scale: 1, tx: 0, ty: 0 };

// Covers: MEM-046
// Requirement: a scene whose rendered aspect matches the photo's keeps its locus zoom; one more
// than 2% off is shown unzoomed rather than mis-cropped.
describe("scene zoom follows the rendered image's aspect", () => {
  test("the test box zooms in for an 800x600 photo (so identity is distinguishable)", () => {
    assert.ok(scenes.zoomFor(BOX, W, H).scale > 1);
  });

  test("a 1024x768 reply for an 800x600 photo keeps today's zoomFor output", async () => {
    const { before, after } = await renderAndLoad(1024, 768);
    const today = scenes.zoomFor(BOX, W, H);
    assertZoomClose(parseZoom(before), today, "zoom at render");
    assertZoomClose(after, today, "zoom after load");
  });

  test("an aspect within 2% of the photo's (1000x740, ~1.4%) keeps the zoom", async () => {
    const { after } = await renderAndLoad(1000, 740);
    assertZoomClose(after, scenes.zoomFor(BOX, W, H), "zoom after load");
  });

  test("a 1024x1024 reply for an 800x600 photo gets the identity zoom", async () => {
    const { after } = await renderAndLoad(1024, 1024);
    assertZoomClose(after, IDENTITY, "zoom after load");
  });

  test("an aspect more than 2% off the photo's (1000x720, ~4.2%) gets the identity zoom", async () => {
    const { after } = await renderAndLoad(1000, 720);
    assertZoomClose(after, IDENTITY, "zoom after load");
  });
});

// Covers: MEM-046
// Requirement: every Muse Image scene the user sees (card and full-size overlay) is visibly marked
// "AI-generated" exactly once.
describe("AI-generated chip on scenes", () => {
  test("every tier-1 scene card carries exactly one .chip-ai reading AI-generated", async () => {
    const p = page();
    await scenes.runScenes(cards(3), { doc: p.doc, fetch: sceneFetch(), image: IMAGE });
    const sections = panelCards(p);
    assert.equal(sections.length, 3);
    for (const [i, section] of sections.entries()) {
      const chips = chipsIn(section);
      assert.equal(chips.length, 1, `card ${i} has ${chips.length} .chip-ai`);
      assert.equal(chips[0].textContent.trim(), "AI-generated");
    }
  });

  test("the open overlay carries exactly one .chip-ai, also after close and reopen", async () => {
    const p = page();
    await scenes.runScenes(cards(1), { doc: p.doc, fetch: sceneFetch(), image: IMAGE });
    const overlay = p.els["scene-overlay"];
    const [img] = imgsIn(p.els.scenes);
    assert.ok(img, "tier-1 scene image rendered");
    for (const round of [1, 2]) {
      p.fire(img, "click");
      assert.equal(overlay.hidden, false, `overlay open (round ${round})`);
      const chips = chipsIn(overlay);
      assert.equal(chips.length, 1, `overlay has ${chips.length} .chip-ai (round ${round})`);
      assert.equal(chips[0].textContent.trim(), "AI-generated");
      p.fire(overlay, "click");
      assert.equal(overlay.hidden, true, `overlay closed (round ${round})`);
    }
  });
});
