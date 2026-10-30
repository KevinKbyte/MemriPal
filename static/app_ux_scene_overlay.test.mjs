// Covers: MEM-044
// Requirement: F15 scene overlay and scene accessibility. The open full-size scene overlay shows a
// visible close button that closes it (the backdrop click and Escape still close it too); each scene
// image's alt text names the item and its place ("<item> at <locus>"), never an empty or generic
// "Scene", and hostile item/locus text stays plain text (0 HTML writes); the #scenes panel is a
// polite live region, so "Rendering scene..." and each finished scene are announced.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakePage, find, findAll, jsonResponse, record, until } from "./fake_dom_test.mjs";
import { runScenes } from "./scenes.js";

const SCENE = "data:image/jpeg;base64,U0NFTkU=";
const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";

function card(item, label) {
  return {
    item,
    locus: { n: 1, label, box: { x1: 10, y1: 20, x2: 90, y2: 120 } },
    entry: { record: record(item, label), status: "valid", sig: "sig_1" },
  };
}

const tier1 = async () => jsonResponse({ tier: 1, image: SCENE, width: 800, height: 600 });

async function openScene(item, label) {
  const p = fakePage(["scenes", "scene-overlay"], { hidden: ["scene-overlay"] });
  await runScenes([card(item, label)], { doc: p.doc, fetch: tier1, image: IMAGE });
  const img = find(p.els.scenes, (n) => n.tagName === "IMG");
  assert.ok(img, "a tier-1 scene renders an <img>");
  return { p, img, overlay: p.els["scene-overlay"] };
}

const closeButton = (overlay) =>
  find(overlay, (n) => n.tagName === "BUTTON" && /close/i.test(`${n.textContent} ${n.getAttribute("aria-label") ?? ""}`));

describe("MEM-044 F15 scene overlay close control", () => {
  test("the open overlay shows a visible Close button", async () => {
    const { p, img, overlay } = await openScene("milk", "lamp");
    p.fire(img, "click");
    assert.equal(overlay.hidden, false, "click on the scene opens the overlay");
    const btn = closeButton(overlay);
    assert.ok(btn, `the open overlay has no close button (children: ${overlay.children.map((c) => c.tagName).join(",")})`);
    assert.equal(btn.hidden, false, "the close button is visible");
  });

  test("the Close button closes the overlay", async () => {
    const { p, img, overlay } = await openScene("milk", "lamp");
    p.fire(img, "click");
    const btn = closeButton(overlay);
    assert.ok(btn, "the open overlay has no close button");
    p.fire(btn, "click");
    assert.equal(overlay.hidden, true, "Close leaves the overlay open");
  });

  test("a backdrop click (the (5,5) spot is the overlay itself) still closes it, and it reopens", async () => {
    const { p, img, overlay } = await openScene("milk", "lamp");
    p.fire(img, "click");
    p.fire(overlay, "click");
    assert.equal(overlay.hidden, true, "backdrop click leaves the overlay open");
    p.fire(img, "click");
    assert.equal(overlay.hidden, false, "the scene reopens after a backdrop close");
  });
});

describe("MEM-044 F15 scene image alt text", () => {
  test('the zoomed scene image alt is "<item> at <locus>"', async () => {
    const { img } = await openScene("milk", "lamp");
    assert.equal(img.alt, "milk at lamp");
  });

  test("the full-size overlay image alt names the item and locus", async () => {
    const { p, img, overlay } = await openScene("eggs", "kitchen door");
    p.fire(img, "click");
    const full = find(overlay, (n) => n.tagName === "IMG");
    assert.ok(full, "overlay holds an image");
    assert.match(String(full.alt), /^eggs at kitchen door\b/, `overlay alt is "${full.alt}"`);
  });

  test("hostile item and locus text lands in alt verbatim, with 0 HTML writes", async () => {
    const item = '<img src=x onerror="alert(1)">';
    const label = 'shelf "top" & <b>co</b>';
    const { p, img, overlay } = await openScene(item, label);
    assert.equal(img.alt, `${item} at ${label}`);
    p.fire(img, "click");
    const full = find(overlay, (n) => n.tagName === "IMG");
    assert.ok(String(full.alt).startsWith(`${item} at ${label}`), `overlay alt is "${full.alt}"`);
    assert.deepEqual(p.htmlWrites, [], "scene text reached an HTML sink");
  });

  test("no scene image alt is empty or the generic \"Scene\"", async () => {
    const { p, img, overlay } = await openScene("bread", "clock");
    p.fire(img, "click");
    for (const i of [...findAll(p.els.scenes, (n) => n.tagName === "IMG"), ...findAll(overlay, (n) => n.tagName === "IMG")]) {
      const alt = String(i.alt ?? "").trim();
      assert.ok(alt && !/^scene(, full size)?$/i.test(alt), `generic alt "${alt}"`);
    }
  });
});

describe("MEM-044 F15 scene status is announced", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

  test('#scenes carries aria-live="polite" in index.html', () => {
    const tag = /<[^>]*\bid="scenes"[^>]*>/.exec(html)?.[0];
    assert.ok(tag, "index.html lost #scenes");
    assert.match(tag, /\baria-live="polite"/, `#scenes is not a polite live region: ${tag}`);
  });

  test("the rendering status text lands inside #scenes while a scene is pending", async () => {
    const p = fakePage(["scenes", "scene-overlay"], { hidden: ["scene-overlay"] });
    let release;
    const gate = new Promise((r) => (release = r));
    const run = runScenes([card("milk", "lamp")], { doc: p.doc, fetch: async () => (await gate, tier1()), image: IMAGE });
    await until(() => /Rendering scene/.test(p.els.scenes.textContent), "rendering status shown in #scenes");
    release();
    await run;
    assert.ok(find(p.els.scenes, (n) => n.tagName === "IMG"), "the finished scene replaces the status inside #scenes");
  });
});
