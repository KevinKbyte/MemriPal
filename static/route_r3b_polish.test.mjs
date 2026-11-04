// Covers: MEM-088
// Requirement (R3b route-builder polish): static/style.css
// - a selected station (li[aria-current="true"], set by a map marker click) is visibly styled in both
//   #route-view-stations and #landmarks-list (a background, box-shadow, border or outline);
// - a real-map overlay marker (.route-map-overlay .route-node) has radius 12px (CSS `r`) and cursor: pointer,
//   since a click selects its station;
// - the route line is ~4px of --primary;
// - below 768px the open drawer covers the map, so the .map-chip (pinned over the map) is display: none while
//   the drawer is open (a selector that checks .drawer[open], inside a max-width media query under 768px).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { STYLE, parseRules } from "./theme_painterly_css_test.mjs";

const RULES = parseRules(STYLE);
const declsOf = (rule, prop) => rule.decls.filter(([p]) => p === prop).map(([, v]) => v);
const VISUAL = ["background", "background-color", "box-shadow", "border", "border-color", "border-left",
  "outline"];

describe("MEM-088 R3b route-builder polish (static/style.css)", () => {
  for (const list of ["route-view-stations", "landmarks-list"]) {
    test(`#${list} styles the selected li[aria-current="true"]`, () => {
      const re = new RegExp(`#${list}\\b[^,]*li\\[aria-current="true"\\]`);
      const sel = RULES.filter((r) => r.media.length === 0 && r.parts.some((p) => re.test(p)));
      const visual = sel.filter((r) => VISUAL.some((v) => declsOf(r, v).length));
      assert.ok(visual.length, `no unconditional #${list} li[aria-current="true"] rule with a visual declaration`);
    });
  }

  test(".route-map-overlay .route-node: r 12px, cursor pointer", () => {
    const rs = RULES.filter((r) => r.media.length === 0
      && r.parts.some((p) => /\.route-map-overlay \.route-node$/.test(p)));
    assert.ok(rs.flatMap((r) => declsOf(r, "r")).includes("12px"), "overlay .route-node r is not 12px");
    assert.ok(rs.flatMap((r) => declsOf(r, "cursor")).includes("pointer"), "overlay .route-node cursor not pointer");
  });

  test(".route-line is ~4px of --primary", () => {
    const rs = RULES.filter((r) => r.media.length === 0 && r.parts.includes(".route-line"));
    assert.equal(rs.flatMap((r) => declsOf(r, "stroke")).at(-1), "var(--primary)");
    const w = parseFloat(rs.flatMap((r) => declsOf(r, "stroke-width")).at(-1));
    assert.ok(w >= 3.5 && w <= 5, `.route-line stroke-width ${w}`);
  });

  test(".map-chip is display: none below 768px while the drawer is open", () => {
    const narrow = (m) => {
      const mx = /max-width:(\d+(?:\.\d+)?)px/.exec(m);
      return mx && Number(mx[1]) < 768 && Number(mx[1]) >= 767;
    };
    const rs = RULES.filter((r) => r.media.some(narrow)
      && r.parts.some((p) => /\.drawer\[open\]/.test(p) && /\.map-chip$/.test(p)));
    assert.ok(rs.some((r) => declsOf(r, "display").includes("none")),
      "no @media (max-width: 767px) rule hides .map-chip when .drawer[open]");
  });
});
