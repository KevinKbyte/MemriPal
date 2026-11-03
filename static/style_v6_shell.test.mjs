// Covers: MEM-072
// Requirement: static/style.css lays out the map-first shell (MEM-072, ADR 0038): :root defines --tabbar-h: 4rem
// and --drawer-w: min(22rem, 88vw); .map-wrap is fixed and ends at bottom: var(--tabbar-h), its .real-map and
// svg#route-map fill it (100% width and height, not the 8/5 card box); .tabbar is fixed at bottom 0 with four
// equal-width a.tab links of min-height >= 44px, the [aria-current] tab distinct by font-weight and colour;
// .drawer is a right panel of width var(--drawer-w) whose .drawer-handle is >= 44px tall and whose .drawer-body
// scrolls (overflow-y: auto); at >= 900px an open drawer shrinks .map-wrap by var(--drawer-w); non-home tab
// panels pad their bottom by var(--tabbar-h); the shell's colours come from the theme tokens so dark mode
// (prefers-color-scheme and [data-theme=dark]) covers them.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("./style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// Split on sep at depth 0, outside quotes, parens and brackets.
function splitTop(str, sep) {
  const out = [];
  let buf = "", depth = 0, quote = null;
  for (const ch of str) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === sep && depth === 0) { out.push(buf); buf = ""; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

const norm = (s) => s.replace(/\s+/g, " ").trim();
const normSel = (s) => norm(s).replace(/'/g, '"').replace(/\s*>\s*/g, " > ");

// Rules of style.css: { parts: [selector...], decls: [[prop, value]], media: [@media preludes] }.
function parseRules(src) {
  const rules = [], stack = [];
  let buf = "", quote = null;
  for (const ch of src) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "{") { stack.push(norm(buf)); buf = ""; continue; }
    if (ch === ";" && stack.length === 0) { buf = ""; continue; }
    if (ch !== "}") { buf += ch; continue; }
    const head = stack.pop();
    if (head !== undefined && !head.startsWith("@")) {
      const decls = splitTop(buf, ";").map((d) => d.trim()).filter((d) => d.includes(":")).map((d) => {
        const i = d.indexOf(":");
        return [d.slice(0, i).trim().toLowerCase(), norm(d.slice(i + 1))];
      });
      const media = stack.filter((h) => h.startsWith("@media"));
      rules.push({ parts: splitTop(head, ",").map(normSel), decls, media });
    }
    buf = "";
  }
  return rules;
}

const RULES = parseRules(CSS);
const TOP = RULES.filter((r) => r.media.length === 0);
// Cascade (source order, no media) of every top-level rule with a part matching re.
const effective = (re) => Object.fromEntries(TOP.filter((r) => r.parts.some((p) => re.test(p)))
  .flatMap((r) => r.decls));
const toPx = (v) => {
  const m = /^([\d.]+)(px|rem|em)$/.exec(v ?? "");
  return m ? Number(m[1]) * (m[2] === "px" ? 1 : 16) : NaN;
};
const isZero = (v) => /^0(px|rem|%)?$/.test(v ?? "");

const MAP_WRAP = /^\.map-wrap$/;
const TABBAR = /^(nav)?\.tabbar$/;
const TAB = /^(\.tabbar (> )?(ul (> )?)?(li (> )?)?)?a?\.tab$/;
const DRAWER = /^(details)?(#drawer)?\.drawer$|^#drawer$/;

describe("map-first shell CSS: tokens and the full-screen map", () => {
  test(":root defines --tabbar-h: 4rem and --drawer-w: min(22rem, 88vw)", () => {
    const root = effective(/^:root$/);
    assert.equal(root["--tabbar-h"], "4rem");
    assert.equal(root["--drawer-w"], "min(22rem, 88vw)");
  });

  test(".map-wrap is position: fixed and ends above the tab bar (bottom: var(--tabbar-h))", () => {
    const wrap = effective(MAP_WRAP);
    assert.equal(wrap.position, "fixed");
    assert.equal(wrap.bottom, "var(--tabbar-h)");
  });

  for (const [label, re] of [[".map-wrap .real-map", /^\.map-wrap (> )?\.real-map$/],
    [".map-wrap svg#route-map", /^\.map-wrap (> )?(svg)?(#route-map|\.route-map)$/]]) {
    test(`${label} fills .map-wrap: width 100%, height 100%, no 8/5 aspect-ratio`, () => {
      const box = effective(re);
      assert.equal(box.width, "100%", `${label} width`);
      assert.equal(box.height, "100%", `${label} height`);
      assert.notEqual((box["aspect-ratio"] ?? "").replace(/\s+/g, ""), "8/5", `${label} keeps the 8/5 card box`);
    });
  }
});

describe("map-first shell CSS: the bottom tab bar", () => {
  test(".tabbar is position: fixed at bottom 0", () => {
    const bar = effective(TABBAR);
    assert.equal(bar.position, "fixed");
    assert.ok(isZero(bar.bottom), `.tabbar bottom is ${bar.bottom}`);
  });

  test("a.tab is a >= 44px touch target", () => {
    const px = toPx(effective(TAB)["min-height"]);
    assert.ok(px >= 44, `a.tab min-height ${effective(TAB)["min-height"]}`);
  });

  test("the four tabs share the bar equally (grid repeat(4, 1fr) on the list, or flex: 1 per tab)", () => {
    const grid = TOP.some((r) => r.parts.some((p) => /^\.tabbar( > )? ?ul$/.test(p))
      && r.decls.some(([k, v]) => k === "grid-template-columns" && /^repeat\(4, (minmax\(0, )?1fr\)?\)$/.test(v)));
    const flex = TOP.some((r) => r.parts.some((p) => /^\.tabbar (> )?(ul (> )?)?(li|a?\.tab)$/.test(p))
      && r.decls.some(([k, v]) => k === "flex" && /^1( 1 0(%|px)?)?$/.test(v)));
    assert.ok(grid || flex, "no equal-column rule for the four tabs");
  });

  test("the aria-current tab differs from the other tabs by font-weight and colour", () => {
    const base = effective(TAB);
    const cur = effective(/^(\.tabbar (> )?(ul (> )?)?(li (> )?)?)?a?\.tab\[aria-current(="page")?\]$/);
    assert.ok(cur["font-weight"], "[aria-current] tab sets font-weight");
    assert.notEqual(cur["font-weight"], base["font-weight"] ?? "normal", "font-weight distinct");
    assert.ok(cur.color, "[aria-current] tab sets color");
    assert.notEqual(cur.color, base.color, "color distinct");
  });
});

describe("map-first shell CSS: the route drawer", () => {
  test(".drawer is a right-side panel of width var(--drawer-w)", () => {
    const d = effective(DRAWER);
    assert.equal(d.width, "var(--drawer-w)");
    assert.ok(isZero(d.right) || isZero(d["inset-inline-end"]), `.drawer right is ${d.right}`);
  });

  test(".drawer-handle is a >= 44px touch target", () => {
    const h = effective(/^(\.drawer (> )?)?(summary)?\.drawer-handle$/)["min-height"];
    assert.ok(toPx(h) >= 44, `.drawer-handle min-height ${h}`);
  });

  test(".drawer-body scrolls on its own (overflow-y: auto)", () => {
    assert.equal(effective(/^(\.drawer (> )?)?\.drawer-body$/)["overflow-y"], "auto");
  });

  test("@media (min-width: 900px): body:has(.drawer[open]) .map-wrap shrinks by var(--drawer-w)", () => {
    const hit = RULES.some((r) => r.media.some((m) => /min-width: ?900px/.test(m))
      && r.parts.some((p) => /^body:has\((\.drawer|#drawer|details\.drawer)\[open\]\) (> )?\.map-wrap$/.test(p))
      && r.decls.some(([k, v]) => /^(right|inset-inline-end|width|margin-right)$/.test(k) && v.includes("var(--drawer-w)")));
    assert.ok(hit, "no >= 900px body:has(.drawer[open]) .map-wrap rule using var(--drawer-w)");
  });
});

describe("map-first shell CSS: tab panels and dark mode", () => {
  test("non-home tab panels pad their bottom by var(--tabbar-h)", () => {
    const hit = TOP.some((r) => r.parts.some((p) => /\.tab-panel|#tab-(landmarks|recall|settings)/.test(p))
      && r.decls.some(([k, v]) => /^padding(-bottom|-block-end|-block)?$/.test(k) && v.includes("var(--tabbar-h)")));
    assert.ok(hit, "no tab-panel rule pads by var(--tabbar-h)");
  });

  test(".tabbar, .drawer and .map-chip paint a token background", () => {
    for (const [label, re] of [[".tabbar", TABBAR], [".drawer", DRAWER], [".map-chip", /^(p)?\.map-chip$/]]) {
      const e = effective(re);
      const bg = e.background ?? e["background-color"];
      assert.match(bg ?? "", /var\(--/, `${label} background ${bg}`);
    }
  });

  test("every shell colour comes from a theme token (no hex/rgb literal), so dark mode covers it", () => {
    const SHELL = /\.(tabbar|tab|drawer|drawer-handle|drawer-body|map-chip|map-wrap|tab-panel)\b/;
    const literals = TOP.filter((r) => r.parts.some((p) => SHELL.test(p))).flatMap((r) => r.decls
      .filter(([k, v]) => /^(color|background|background-color|border(-top|-left|-right|-bottom)?(-color)?|outline(-color)?)$/.test(k)
        && /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(v))
      .map(([k, v]) => `${r.parts.join(", ")} { ${k}: ${v} }`));
    assert.ok(TOP.some((r) => r.parts.some((p) => SHELL.test(p))), "no shell rules in style.css");
    assert.deepEqual(literals, [], "shell colours hard-coded instead of tokens");
  });
});
