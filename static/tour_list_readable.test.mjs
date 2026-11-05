import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { read, strip, parseRules, modes, tokenColor, ratio } from "./theme_painterly_css_test.mjs";

const TOUR_RULES = parseRules(strip(read("./tour.css")));
const HOUSE_ROW = ".tour-house:not([hidden]) + .tour-fig .fig-row";
const STORY_HOUSE_CARD = ".tour.is-story .tour-card:has(.tour-house:not([hidden]))";
const sel = (s) => s.replace(/\s+/g, " ").replace(/'/g, '"').trim();

// Declarations for a selector across top-level (non-@media) rules, later rules winning.
function declsFor(selector, { anyMedia = false } = {}) {
  const want = sel(selector);
  const out = {};
  for (const r of TOUR_RULES) {
    if (!anyMedia && r.media.length) continue;
    if (r.parts.includes(want)) for (const [p, v] of r.decls) out[p] = v;
  }
  return out;
}

const splitWs = (v) => v.trim().split(/\s+(?![^(]*\))/);
// Parse a length/number to px (rem/em at 16px); unitless numbers returned as-is with unit "".
function len(v) {
  const m = String(v).trim().match(/^(-?[\d.]+)(px|rem|em)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return { px: m[2] === "px" ? n : m[2] ? n * 16 : n, unit: m[2] ?? "" };
}

// `font: [style] [weight] size[/lh] family`.
function fontShorthand(v) {
  if (!v) return {};
  const toks = splitWs(v);
  const i = toks.findIndex((t) => /^[\d.]+(px|rem|em)(\/\S+)?$/.test(t));
  if (i < 0) return {};
  const [size, lh] = toks[i].split("/");
  return { size, lh, family: toks.slice(i + 1).join(" ") };
}

const fontSizePx = (d) => len(d["font-size"] ?? fontShorthand(d.font).size)?.px;
const lineHeight = (d) => d["line-height"] ?? fontShorthand(d.font).lh;
const family = (d) => d["font-family"] ?? fontShorthand(d.font).family;

// Effective font-size for a selector that inherits .fig-row unless it overrides.
const effectiveSize = (selector, base) => fontSizePx(declsFor(selector)) ?? fontSizePx(declsFor(base));

function paddingBlock(d) {
  let top, bottom;
  if (d.padding) {
    const v = splitWs(d.padding);
    top = v[0];
    bottom = v[2] ?? v[0];
  }
  if (d["padding-block"]) {
    const v = splitWs(d["padding-block"]);
    top = v[0];
    bottom = v[1] ?? v[0];
  }
  top = d["padding-top"] ?? d["padding-block-start"] ?? top;
  bottom = d["padding-bottom"] ?? d["padding-block-end"] ?? bottom;
  return [len(top)?.px, len(bottom)?.px];
}

// Requirement: Pal's tour step 3 "My Royal Shopping List" is comfortably readable on a 375x812 phone --
// list rows at least 17px with roomy 1.5 line-height and padding, keyword captions and spot labels at least
// 16px in the body (not mono) face, the card scrolls instead of overflowing, and ink/muted text keeps
// WCAG AA (4.5:1) contrast on the row and card backgrounds in light and both dark contexts.
// Covers: MEM-056
describe("tour royal shopping list is readable at phone size (MEM-056)", () => {
  test(".fig-row font-size >= 17px and the house-step row does not shrink it", () => {
    const base = fontSizePx(declsFor(".fig-row"));
    assert.ok(base !== undefined, ".fig-row declares no font-size");
    assert.ok(base >= 17, `.fig-row font-size is ${base}px, want >= 17px`);
    const house = effectiveSize(HOUSE_ROW, ".fig-row");
    assert.ok(house >= 17, `${HOUSE_ROW} font-size is ${house}px, want >= 17px`);
  });

  for (const [selector, base] of [[".tour-kw", ".tour-kw"], [".fig-spot", ".fig-spot"],
    [".fig-sub .fig-row", ".fig-row"]]) {
    test(`${selector} font-size >= 16px`, () => {
      const px = effectiveSize(selector, base);
      assert.ok(px !== undefined, `${selector} declares no font-size`);
      assert.ok(px >= 16, `${selector} font-size is ${px}px, want >= 16px`);
    });
  }

  for (const [selector, min] of [[".fig-row", 1.5], [".tour-kw", 1.4]]) {
    test(`${selector} line-height >= ${min} (unitless)`, () => {
      const lh = lineHeight(declsFor(selector));
      assert.ok(lh !== undefined, `${selector} declares no line-height`);
      const v = len(lh);
      assert.ok(v && v.unit === "", `${selector} line-height ${lh} is not unitless`);
      assert.ok(v.px >= min, `${selector} line-height is ${lh}, want >= ${min}`);
    });
  }

  test("house-step row padding-block >= 0.5rem", () => {
    const [top, bottom] = paddingBlock({ ...declsFor(".fig-row"), ...declsFor(HOUSE_ROW) });
    assert.ok(top >= 8 && bottom >= 8, `${HOUSE_ROW} padding-block is ${top}px/${bottom}px, want >= 8px (0.5rem)`);
  });

  test(".tour-fig gap >= 0.5rem", () => {
    const d = declsFor(".tour-fig");
    const gap = d["row-gap"] ?? (d.gap ? splitWs(d.gap)[0] : undefined);
    assert.ok(gap !== undefined, ".tour-fig declares no gap");
    assert.ok(len(gap)?.px >= 8, `.tour-fig gap is ${gap}, want >= 0.5rem`);
  });

  test(".tour-kw is not set in the mono face", () => {
    const d = declsFor(".tour-kw");
    const fam = family(d) ?? "";
    assert.doesNotMatch(fam, /var\(\s*--mono\b/, `.tour-kw font family is ${fam}`);
    assert.doesNotMatch(d.font ?? "", /var\(\s*--mono\b/, `.tour-kw font shorthand is ${d.font}`);
  });

  test("story house card caps its height and scrolls vertically", () => {
    const d = declsFor(STORY_HOUSE_CARD, { anyMedia: true });
    assert.ok(d["max-height"] && d["max-height"] !== "none", `${STORY_HOUSE_CARD} declares no max-height`);
    const oy = d["overflow-y"] ?? (d.overflow ? splitWs(d.overflow).pop() : undefined);
    assert.equal(oy, "auto", `${STORY_HOUSE_CARD} overflow-y is ${oy}, want auto`);
  });

  test("--ink and --muted keep >= 4.5:1 on --lamp-soft and --surface in every theme context", () => {
    for (const [mode, tokens] of Object.entries(modes())) {
      for (const fg of ["--ink", "--muted"]) {
        for (const bg of ["--lamp-soft", "--surface"]) {
          const r = ratio(tokenColor(tokens, mode, fg), tokenColor(tokens, mode, bg));
          assert.ok(r >= 4.5, `${mode}: ${fg} on ${bg} is ${r.toFixed(2)}:1, want >= 4.5:1`);
        }
      }
    }
  });
});
