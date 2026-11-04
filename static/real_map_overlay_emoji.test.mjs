// Covers: MEM-100
// Requirement: every station on the live Routes map shows a landmark emoji just above its circle (ADR 0055).
// A station's optional emoji field is drawn as-is; a station without one shows U+1F4CD (round pushpin). The
// glyph is an SVG text element with class lm-emoji, a sibling of the station circle (a circle cannot hold
// children) carrying the station's data-station-id, at x = cx and y = cy - 30 of its circle, and it follows
// the circle on every re-projection (map move and resize, pinned stations included). Exactly one per station:
// attaching again reuses the existing ones, and detaching the overlay (repeat mount, sketch fallback) removes
// them all. The glyph is plain text set via textContent, so a hostile emoji value such as markup shows as
// literal characters and is never parsed. Presentation attributes only, never a style attribute (CSP), and
// aria-hidden="true" (decorative; the station list stays the accessible path).
// Contract (RED; GREEN extends static/real_map_overlay.js attachOverlay / place() / detachOverlay):
//   attachOverlay: per station node, find-or-create doc.createElementNS(SVG_NS, "text") with class lm-emoji,
//   attribute data-station-id = the station id, aria-hidden="true", textContent = station.emoji ?? U+1F4CD,
//   inserted as a sibling of the node inside the svg. place(): setAttribute("x", cx) and ("y", cy - 30) using
//   the node's drawn (clamped) point. detachOverlay: removes every lm-emoji child, like lm-arrow.
//   Fake map surface: static/real_map_overlay_fakes_test.mjs (no querySelector: walk svg.children).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { findAll, settle } from "./fake_dom_test.mjs";
import { attachOverlay, detachOverlay } from "./real_map_overlay.js";
import {
  IDS,
  KENDALL,
  descendantOf,
  hasClass,
  mountIdle,
  moveTo,
  nodeFor,
  offIds,
  rig,
  setSize,
  stationNodes,
  stationsAt,
} from "./real_map_overlay_fakes_test.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const PUSHPIN = "\u{1F4CD}";
const COFFEE = "\u{2615}";
const MUSEUM = "\u{1F3DB}\u{FE0F}";
const SKETCH_VIEWBOX = "0 0 320 200";
// A pan that puts st-1 off the left edge at 375x300 (pinned), as in real_map_overlay.test.mjs.
const WEST = [-71.08, 42.36396];

const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const emojis = (svg) => findAll(svg, (n) => n !== svg && hasClass(n, "lm-emoji"));
const emojiFor = (svg, id) => emojis(svg).filter((n) => n.getAttribute?.("data-station-id") === id);
const withEmoji = (byId) => stationsAt(KENDALL).map((s) => (s.id in byId ? { ...s, emoji: byId[s.id] } : s));

function assertOnePerStation(svg, label) {
  const all = emojis(svg);
  assert.equal(all.length, IDS.length, `${label}: lm-emoji count (one per station)`);
  assert.deepEqual(all.map((n) => n.getAttribute("data-station-id")).sort(), IDS, `${label}: one per station id`);
}

function assertAbove(svg, label) {
  for (const id of IDS) {
    const node = nodeFor(svg, id);
    const [e] = emojiFor(svg, id);
    assert.ok(e, `${label}: lm-emoji for ${id}`);
    const cx = Number(node.getAttribute("cx"));
    const cy = Number(node.getAttribute("cy"));
    const x = Number(e.getAttribute("x"));
    const y = Number(e.getAttribute("y"));
    assert.ok(near(x, cx) && near(y, cy - 30),
      `${label}: ${id} emoji at (${e.getAttribute("x")}, ${e.getAttribute("y")}), want (${cx}, ${cy - 30})`);
  }
}

describe("real map: landmark emoji above each station (MEM-100)", () => {
  test("default: one text.lm-emoji sibling per station, showing U+1F4CD when the station has no emoji", async () => {
    const r = rig();
    const map = await mountIdle(r);
    assertOnePerStation(r.svg, "first idle");
    for (const id of IDS) {
      const [e] = emojiFor(r.svg, id);
      const node = nodeFor(r.svg, id);
      assert.equal(e.tagName, "TEXT", `${id}: an svg text element`);
      assert.equal(e.namespaceURI, SVG_NS, `${id}: created in the SVG namespace`);
      assert.ok(e.parent === node.parent, `${id}: a sibling of the station circle`);
      assert.equal(e.textContent, PUSHPIN, `${id}: default glyph`);
    }
    assert.ok(descendantOf(r.svg, map.getContainer()), "precondition: the svg is the map overlay");
  });

  test("custom: a station's emoji is drawn as-is; stations without one keep U+1F4CD", async () => {
    const r = rig({ stations: withEmoji({ "st-2": COFFEE, "st-4": MUSEUM }) });
    await mountIdle(r);
    assertOnePerStation(r.svg, "first idle");
    const want = { "st-1": PUSHPIN, "st-2": COFFEE, "st-3": PUSHPIN, "st-4": MUSEUM };
    for (const id of IDS) assert.equal(emojiFor(r.svg, id)[0].textContent, want[id], `${id} glyph`);
  });

  test("position: (cx, cy - 30) at first idle, after a pan (pinned station), a zoom and a resize", async () => {
    const r = rig();
    const map = await mountIdle(r);
    assertAbove(r.svg, "first idle");
    await moveTo(map, { center: WEST, end: false });
    assert.deepEqual(offIds(map, r.stations), ["st-1"], "precondition: st-1 off the map");
    assert.ok(hasClass(nodeFor(r.svg, "st-1"), "lm-pinned"), "precondition: st-1 pinned");
    assertAbove(r.svg, "after pan west (move)");
    await moveTo(map, { zoom: 15.4 });
    assertAbove(r.svg, "after zoom");
    setSize(map.getContainer(), 768, 400);
    map.emit("resize");
    await settle(5);
    assertAbove(r.svg, "after resize");
    assertOnePerStation(r.svg, "after pan, zoom and resize");
  });

  test("re-attach without detach reuses the emoji nodes: still one per station, same nodes", async () => {
    const r = rig({ stations: withEmoji({ "st-3": COFFEE }) });
    const map = await mountIdle(r);
    const before = IDS.map((id) => emojiFor(r.svg, id)[0]);
    attachOverlay(map, r.svg, r.stations, r.doc);
    assertOnePerStation(r.svg, "after a second attachOverlay");
    IDS.forEach((id, i) => assert.ok(emojiFor(r.svg, id)[0] === before[i], `${id}: same lm-emoji node reused`));
    await moveTo(map, { center: WEST });
    assertAbove(r.svg, "re-attached, after pan");
    assert.equal(emojiFor(r.svg, "st-3")[0].textContent, COFFEE, "custom glyph kept");
  });

  test("detachOverlay removes every lm-emoji", async () => {
    const r = rig();
    await mountIdle(r);
    assert.equal(emojis(r.svg).length, IDS.length, "precondition: emoji drawn");
    detachOverlay(r.svg, SKETCH_VIEWBOX);
    assert.deepEqual(emojis(r.svg).map((n) => n.getAttribute("data-station-id")), [], "lm-emoji left after detach");
    assert.equal(stationNodes(r.svg).length, IDS.length, "station circles stay");
  });

  test("repeat mount: no lm-emoji on the sketch before the new idle; the new map has one per station", async () => {
    const r = rig();
    await mountIdle(r);
    assertOnePerStation(r.svg, "first map");
    const second = await r.loader.mount(r.svg, r.stations);
    assert.ok(second?.map, "second mount made a map");
    assert.equal(emojis(r.svg).length, 0, "no lm-emoji left on the sketch while the second map loads");
    setSize(second.map.getContainer(), 375, 300);
    second.map.emit("load");
    second.map.emit("idle");
    await settle(5);
    assertOnePerStation(r.svg, "second map");
    assertAbove(r.svg, "second map");
  });

  test("hostile emoji value renders as literal text via textContent: no element parsed, no innerHTML", async () => {
    const hostile = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    const r = rig({ stations: withEmoji({ "st-1": hostile }) });
    await mountIdle(r);
    const [e] = emojiFor(r.svg, "st-1");
    assert.ok(e, "lm-emoji for st-1");
    assert.equal(e.textContent, hostile, "the value shows as literal characters");
    assert.equal(e.children.length, 0, "no child elements under the glyph");
    const parsed = findAll(r.svg, (n) => n.tagName === "IMG" || n.tagName === "SCRIPT");
    assert.deepEqual(parsed.map((n) => n.tagName), [], "no img/script element in the overlay");
    assert.deepEqual(r.htmlWrites, [], "no innerHTML / outerHTML / insertAdjacentHTML writes");
  });

  test("CSP: no lm-emoji carries a style attribute or inline style, after a pan", async () => {
    const r = rig();
    const map = await mountIdle(r);
    await moveTo(map, { center: WEST });
    assertOnePerStation(r.svg, "after pan");
    for (const e of emojis(r.svg)) {
      const id = e.getAttribute("data-station-id");
      assert.equal(e.getAttribute("style"), null, `${id}: no style attribute`);
      const inline = Object.entries(e.style ?? {}).filter(([, v]) => typeof v !== "function");
      assert.deepEqual(inline, [], `${id}: no inline style`);
    }
  });

  test("a11y: every lm-emoji is aria-hidden=\"true\"", async () => {
    const r = rig();
    await mountIdle(r);
    assertOnePerStation(r.svg, "first idle");
    for (const e of emojis(r.svg)) {
      assert.equal(e.getAttribute("aria-hidden"), "true", `${e.getAttribute("data-station-id")}: aria-hidden`);
    }
  });
});
