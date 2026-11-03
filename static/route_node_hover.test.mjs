// Covers: MEM-077
// Requirement: a station marker (the .route-node circle, in the sketch and as the real-map overlay marker)
// is hard to see at rest, so hovering it doubles its size (Kev: "on hover should increase the size of the
// landmark icon by 2x"). static/style.css: inside @media (hover: hover) a .route-node:hover rule sets
// transform: scale(2); .route-node scales about its own centre (transform-box: fill-box, transform-origin:
// center), never the svg origin; inside the real-map overlay the markers take pointer-events: auto so a
// hover reaches them, while the overlay svg itself stays pointer-events: none (map drags elsewhere still
// pass through); if a transition is added to .route-node, @media (prefers-reduced-motion: reduce) sets it
// to none.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { STYLE, parseRules, lastCompound } from "./theme_painterly_css_test.mjs";

const RULES = parseRules(STYLE);
const NODE = /(^|[^\w-])\.route-node(?![\w-])/;
const OVERLAY = /(^|[^\w-])\.route-map-overlay(?![\w-])/;
const isHover = (compound) => /:hover(?![\w-])/.test(compound);
const declsOf = (rule, prop) => rule.decls.filter(([p]) => p === prop).map(([, v]) => v);
const where = (r) => `${r.media.join(" ")} ${r.parts.join(", ")}`.trim();

/** Rules with a selector whose subject (last compound) is a .route-node, filtered by pred(part, rule). */
function nodeRules(pred = () => true) {
  return RULES.filter((r) => r.parts.some((p) => NODE.test(lastCompound(p)) && pred(p, r)));
}

describe("station marker doubles on hover (static/style.css)", () => {
  test("a .route-node:hover rule inside @media (hover: hover) sets transform: scale(2)", () => {
    const hovers = nodeRules((p) => isHover(lastCompound(p)));
    const inHoverMedia = hovers.filter((r) => r.media.some((m) => m.includes("(hover:hover)")));
    const scaled = inHoverMedia.filter((r) =>
      declsOf(r, "transform").some((v) => /^scale\(\s*2(\s*,\s*2)?\s*\)$/.test(v)));
    assert.ok(scaled.length,
      `no @media (hover: hover) .route-node:hover rule sets transform: scale(2); hover rules: ${
        hovers.map(where).join(" | ") || "none"}`);
  });

  test(".route-node scales about its own centre: transform-box: fill-box, transform-origin: center", () => {
    const base = nodeRules((p) => !isHover(lastCompound(p)));
    const box = base.flatMap((r) => declsOf(r, "transform-box"));
    const origin = base.flatMap((r) => declsOf(r, "transform-origin"));
    assert.ok(box.includes("fill-box"), `.route-node transform-box: ${box.join(", ") || "unset"}`);
    assert.ok(origin.some((v) => /^(center|center center|50% 50%)$/.test(v)),
      `.route-node transform-origin: ${origin.join(", ") || "unset"}`);
  });

  test("overlay markers take pointer-events: auto; the overlay svg itself stays pointer-events: none", () => {
    const markers = nodeRules((p) => OVERLAY.test(p) && !isHover(lastCompound(p)));
    const auto = markers.filter((r) => declsOf(r, "pointer-events").includes("auto"));
    assert.ok(auto.length,
      `no .route-map-overlay .route-node rule sets pointer-events: auto; overlay node rules: ${
        markers.map(where).join(" | ") || "none"}`);
    const overlay = RULES.filter((r) => r.media.length === 0
      && r.parts.some((p) => OVERLAY.test(lastCompound(p)) && !NODE.test(p)));
    const pe = overlay.flatMap((r) => declsOf(r, "pointer-events"));
    assert.ok(pe.length, "no .route-map-overlay rule sets pointer-events");
    assert.equal(pe.at(-1), "none", "the overlay svg must stay pointer-events: none so map drags pass through");
  });

  test("under prefers-reduced-motion: reduce, any .route-node transition is none", () => {
    const isReduce = (r) => r.media.some((m) => m.includes("(prefers-reduced-motion:reduce)"));
    const moving = nodeRules((p, r) => !isReduce(r))
      .filter((r) => declsOf(r, "transition").some((v) => v !== "none")
        || declsOf(r, "transition-duration").some((v) => !/^0m?s$/.test(v)));
    if (!moving.length) return;
    const reduced = nodeRules((p, r) => isReduce(r)).flatMap((r) => declsOf(r, "transition"));
    assert.ok(reduced.includes("none"),
      `.route-node transitions (${moving.map(where).join(" | ")}) have no reduced-motion transition: none`);
  });
});
