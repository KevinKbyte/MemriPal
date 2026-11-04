// Covers: MEM-044, MEM-095, MEM-112, MEM-045
// Requirement: static/index.html carries the v6 shell and control markup (MEM-044 A2, F13): topbar brand,
// .panel, .field, .btn, .btn-primary, .eyebrow and .notice around the live elements; every id of 748a5e1
// is kept with its hidden attribute unchanged (MEM-048/MEM-050/MEM-051/MEM-072/MEM-081: the only ids added are MEM-048's 14,
// MEM-050's 15, MEM-051's Part A ids, MEM-072's shell ids and MEM-081's 4, and only their start-hidden ids may carry hidden;
// MEM-081 moved #route-undo into the hidden #route-toast, so #route-undo itself no longer carries hidden); 0 orphan classes (each index.html class has a style.css
// rule) and 0 orphan selectors (each style.css class is in index.html or a class literal in static/*.js);
// F13: #auto and its label sit inside #routes-settings (MEM-048; was #load-demo's container); every text/file/password input has a
// <label for> inside one .field wrapper (display grid or block); main has no bare <label>/<input> child;
// #auto stays a native visible checkbox with no hidden ancestor except a MEM-072 section.tab-panel (start-hidden,
// revealed by tabbar.js showTab, so it is checked as revealed); button and .btn (incl. the F7 Show/Hide aria-expanded toggles)
// keep min-height >= 44px; no wrapper between main and #scene-overlay sets an A1-forbidden property.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { MEM048_IDS, MEM048_MAY_START_HIDDEN, MEM050_IDS, MEM050_MAY_START_HIDDEN, MEM051_IDS,
  MEM051_MAY_START_HIDDEN, MEM072_IDS, MEM072_MAY_START_HIDDEN, MEM081_IDS, MEM081_MAY_START_HIDDEN,
  MEM088_IDS, MEM088_MAY_START_HIDDEN, MEM095_IDS, MEM095_MAY_START_HIDDEN, MEM045_IDS, MEM045_MAY_START_HIDDEN }
  from "./index_ids_test.mjs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const HTML = read("./index.html");
// MEM-095: tour classes live in tour.css, so the orphan-class check reads it beside style.css.
const TOUR_CSS = existsSync(new URL("./tour.css", import.meta.url)) ? read("./tour.css") : "";
const CSS = read("./style.css").replace(/\/\*[\s\S]*?\*\//g, "");

// index.html at 748a5e1 (before MEM-044): its ids, and the ids carrying the hidden attribute.
const BASE_IDS = [
  "public-banner", "status", "meta-notice", "photo", "passcode", "load-demo", "place-settings",
  "place-toggle", "place-typed", "places", "upload-status", "empty-state", "scene-wrap", "scene", "loci",
  "assoc-status", "associations", "auto", "route-review", "route", "route-undo", "generate", "scenes",
  "walk", "walk-step", "walk-prev", "walk-next", "recall", "recall-start", "recall-replay", "recall-typed",
  "recall-submit", "recall-live", "recall-results", "history", "rehearsals", "rehearsal-undo",
  "history-view", "hit-rates", "backup", "backup-export", "backup-import", "backup-status", "scene-overlay",
];
const BASE_HIDDEN = [
  "public-banner", "meta-notice", "route-review", "route-undo", "walk", "recall", "recall-typed",
  "history", "rehearsal-undo", "scene-overlay",
];
// MEM-081: 748a5e1 hidden ids that now sit inside a hidden container instead of carrying hidden themselves.
const UNHIDDEN_BY_MEM081 = ["route-undo"];
const STAY_HIDDEN = BASE_HIDDEN.filter((id) => !UNHIDDEN_BY_MEM081.includes(id));
const V6_CLASSES = ["topbar", "brand", "panel", "field", "btn", "btn-primary", "eyebrow", "notice"];
const FORBIDDEN = new Set([
  "filter", "backdrop-filter", "transform", "perspective", "will-change", "contain", "mix-blend-mode",
  "isolation", "z-index", "overflow", "overflow-x", "overflow-y",
]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source",
  "track", "wbr"]);

// Element tree of index.html: { tag, attrs, children, parent, order }.
function parseHtml(src) {
  const root = { tag: "#root", attrs: {}, children: [], parent: null, order: -1 };
  let cur = root, order = 0;
  const body = src.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype[^>]*>/i, "");
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    const [, close, rawTag, rest] = m;
    const tag = rawTag.toLowerCase();
    if (close) {
      let n = cur;
      while (n !== root && n.tag !== tag) n = n.parent;
      if (n !== root) cur = n.parent;
      continue;
    }
    const attrs = {};
    for (const a of rest.matchAll(/([^\s"'=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
      attrs[a[1].toLowerCase()] = a[2] === undefined ? "" : a[2].replace(/^["']|["']$/g, "");
    }
    const el = { tag, attrs, children: [], parent: cur, order: order++ };
    cur.children.push(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(rest)) cur = el;
  }
  return root;
}

const DOC = parseHtml(HTML);
const all = (n = DOC) => n.children.flatMap((c) => [c, ...all(c)]);
const ELS = all();
const byId = (id) => ELS.find((e) => e.attrs.id === id);
const classes = (el) => (el.attrs.class ?? "").split(/\s+/).filter(Boolean);
const ancestors = (el) => {
  const out = [];
  for (let p = el.parent; p && p !== DOC; p = p.parent) out.push(p);
  return out;
};
const closestClass = (el, c) => [el, ...ancestors(el)].find((e) => classes(e).includes(c)) ?? null;
const desc = (el) => {
  if (!el) return "none";
  return `<${el.tag}${el.attrs.id ? ` id="${el.attrs.id}"` : ""} class="${el.attrs.class ?? ""}">`;
};

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

// Rules of style.css: { parts: [selector...], decls: [[prop, value]], media: [normalized @media preludes] }.
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
        return [d.slice(0, i).trim().toLowerCase(), norm(d.slice(i + 1)).toLowerCase()];
      });
      const media = stack.filter((h) => h.startsWith("@media"))
        .map((h) => h.toLowerCase().replace(/\s+/g, ""));
      rules.push({ parts: splitTop(head, ",").map((p) => norm(p).replace(/'/g, '"')), decls, media });
    }
    buf = "";
  }
  return rules;
}

const RULES = parseRules(CSS);
const decl = (rule, prop) => {
  const hit = rule.decls.filter(([p]) => p === prop);
  return hit.length ? hit[hit.length - 1][1] : undefined;
};
const compounds = (part) => splitTop(part.replace(/\s*([>+~])\s*/g, " "), " ").filter(Boolean);
const lastCompound = (part) => compounds(part).pop() ?? "";
const selectorClasses = (part) =>
  [...part.replace(/\[[^\]]*\]/g, "").matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);

// Whether one compound selector (no combinators) can match el; pseudo-classes other than :root are ignored,
// so the match over-approximates; pseudo-elements never match an element.
function matchesCompound(el, compound) {
  if (/::|:(before|after|first-line|first-letter|marker|placeholder)\b/i.test(compound)) return false;
  const attrs = [...compound.matchAll(/\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*("[^"]*"|[^\]\s]+))?\s*i?\s*\]/gi)];
  let s = compound.replace(/\[[^\]]*\]/g, "");
  const root = /:root\b/i.test(s);
  s = s.replace(/:(?!:)[\w-]+(\((?:[^()]|\([^()]*\))*\))?/g, "");
  if (root && el.tag !== "html") return false;
  const tag = s.match(/^([a-z][\w-]*|\*)/i)?.[1]?.toLowerCase();
  if (tag && tag !== "*" && tag !== el.tag) return false;
  for (const m of s.matchAll(/#([\w-]+)/g)) if (el.attrs.id !== m[1]) return false;
  for (const m of s.matchAll(/\.([\w-]+)/g)) if (!classes(el).includes(m[1])) return false;
  for (const [, name, op, raw] of attrs) {
    const have = el.attrs[name.toLowerCase()];
    if (have === undefined) return false;
    const want = raw?.replace(/^"|"$/g, "");
    if (op === "=" && have !== want) return false;
    if (op === "~=" && !have.split(/\s+/).includes(want)) return false;
  }
  return true;
}
const rulesMatching = (el) => RULES.filter((r) => r.parts.some((p) => matchesCompound(el, lastCompound(p))));

// px of a length value (16 px per rem/em); max() takes the largest, anything else the smallest length.
function px(value) {
  const lens = [...(value ?? "").matchAll(/(-?\d*\.?\d+)(px|rem|em)\b/g)]
    .map((m) => Number(m[1]) * (m[2] === "px" ? 1 : 16));
  if (!lens.length) return undefined;
  return /^max\(/.test(value) ? Math.max(...lens) : Math.min(...lens);
}

// Source of the non-test static/*.js; a class literal is the name as a whitespace-separated word of a
// quoted string ("lit", "said-got", ternary arms, "a b" lists).
const JS = readdirSync(new URL("./", import.meta.url)).filter((n) => n.endsWith(".js"))
  .map((f) => read(`./${f}`)).join("\n");
const inJs = (c) => new RegExp(`["'\`]([^"'\`\\n]*\\s)?${c}(\\s[^"'\`\\n]*)?["'\`]`).test(JS);

// MEM-108: the Spark Meta-fallback toast; it starts hidden and shows only after a fallback reply.
const MEM108_IDS = ["chat-fallback", "chat-fallback-text", "chat-fallback-dismiss"];
const MEM108_MAY_START_HIDDEN = ["chat-fallback"];
// MEM-110: the station card's read-only tap summary (one li per tap group with a value; hidden when none).
const MEM110_IDS = ["station-tap-summary"];
const MEM110_MAY_START_HIDDEN = ["station-tap-summary"];
// MEM-125: the Recall flashcards panel inside #tab-recall.
const MEM125_IDS = ["flashcards", "flashcards-title", "flashcards-status", "flashcards-card"];
// MEM-114: the zero-route empty-state slogan beside Pal; visible in the markup (never start-hidden).
const MEM114_IDS = ["empty-slogan"];

// Covers: MEM-044, MEM-095, MEM-112, MEM-045
// Requirement: MEM-044 A2 v6 shell + control markup in static/index.html (see the file header).
describe("MEM-044 A2 v6 shell + control markup (static/index.html, F13)", () => {
  // MEM-048 (plan B3) amended this test: 748a5e1's ids must survive (subset, each exactly once), and the
  // only additions allowed are the 14 MEM-048 Part A ids (exact allowlist). MEM-050 (plan B5) widened the
  // allowlist by its 15 S3 station-card ids; MEM-051 (plan B6) adds its S5/S8 ids; MEM-072 (map-first shell)
  // adds its tab panel, map chip, drawer and landmarks-list ids (older ids only move); MEM-081 its 4 route review ids;
  // MEM-088 its 12 route builder / map empty-state ids; MEM-108 its 3 chat-fallback toast ids (#chat-fallback starts hidden);
  // MEM-110 its station tap summary id; MEM-095 its Pal tour ids; MEM-045 its sticker panel ids; MEM-125 its
  // flashcards panel ids; MEM-114 its #empty-slogan id.
  test("every 748a5e1 id kept exactly once; the only ids added are MEM-048's, MEM-050's, MEM-051's, MEM-072's, MEM-081's, MEM-088's, MEM-108's, MEM-110's, MEM-095's, MEM-045's, MEM-125's and MEM-114's", () => {
    const ids = ELS.map((e) => e.attrs.id).filter((id) => id !== undefined);
    const count = (id) => ids.filter((x) => x === id).length;
    const lost = BASE_IDS.filter((id) => count(id) !== 1);
    assert.deepEqual(lost, [], `748a5e1 ids missing or duplicated: ${lost.join(" ")}`);
    const allowed = new Set([...BASE_IDS, ...MEM048_IDS, ...MEM050_IDS, ...MEM051_IDS, ...MEM072_IDS, ...MEM081_IDS,
      ...MEM088_IDS, ...MEM108_IDS, ...MEM110_IDS,
      ...MEM095_IDS, ...MEM045_IDS, ...MEM125_IDS, ...MEM114_IDS]);
    const unexpected = ids.filter((id) => !allowed.has(id));
    assert.deepEqual(unexpected, [],
      `ids outside 748a5e1 + MEM-048 + MEM-050 + MEM-051 + MEM-072 + MEM-081 + MEM-088 + MEM-108 + MEM-110 + MEM-095 + MEM-045 + MEM-125 + MEM-114: ${unexpected.join(" ")}`);
    const missing = MEM072_IDS.filter((id) => count(id) !== 1);
    assert.deepEqual(missing, [], `MEM-072 shell ids missing or duplicated: ${missing.join(" ")}`);
    const dupes = [...new Set(ids.filter((id) => count(id) > 1))];
    assert.deepEqual(dupes, [], `duplicated ids: ${dupes.join(" ")}`);
  });

  // MEM-048 (plan B3) amended this test: 748a5e1's hidden ids stay hidden and its visible ids stay visible;
  // a new element may carry hidden only if it is a MEM-048, MEM-050, MEM-051, MEM-081 or MEM-088 id that starts hidden,
  // or a MEM-072 non-home tab panel. MEM-081 amended it: #route-undo lives inside the hidden #route-toast and no
  // longer carries hidden itself.
  test("748a5e1's hidden ids unchanged (bar #route-undo); only start-hidden MEM-048/050/051/072/081/088/045 ids added as hidden", () => {
    const hidden = ELS.filter((e) => "hidden" in e.attrs).map((e) => e.attrs.id ?? desc(e));
    const lostHidden = STAY_HIDDEN.filter((id) => !hidden.includes(id));
    assert.deepEqual(lostHidden, [], `748a5e1 hidden ids no longer hidden: ${lostHidden.join(" ")}`);
    const mayHide = new Set([...STAY_HIDDEN, ...MEM048_MAY_START_HIDDEN, ...MEM050_MAY_START_HIDDEN,
      ...MEM051_MAY_START_HIDDEN, ...MEM072_MAY_START_HIDDEN, ...MEM081_MAY_START_HIDDEN,
      ...MEM088_MAY_START_HIDDEN, ...MEM108_MAY_START_HIDDEN, ...MEM110_MAY_START_HIDDEN,
      ...MEM095_MAY_START_HIDDEN, ...MEM045_MAY_START_HIDDEN]);
    const extra = hidden.filter((id) => !mayHide.has(id));
    assert.deepEqual(extra, [], `hidden but not allowed to start hidden: ${extra.join(" ")}`);
  });

  test("v6 shell classes topbar, brand, panel, field, btn, btn-primary, eyebrow, notice are used", () => {
    const used = new Set(ELS.flatMap(classes));
    const missing = V6_CLASSES.filter((c) => !used.has(c));
    assert.deepEqual(missing, [], `index.html uses no element with class ${missing.join(", ")}`);
  });

  test("0 orphan classes: every index.html class has a style.css rule", () => {
    const styled = new Set([...RULES, ...parseRules(TOUR_CSS.replace(/\/\*[\s\S]*?\*\//g, ""))]
      .flatMap((r) => r.parts.flatMap(selectorClasses)));
    const orphans = [...new Set(ELS.flatMap(classes))].filter((c) => !styled.has(c));
    assert.deepEqual(orphans, [], `classes with no style.css rule: ${orphans.join(" ")}`);
  });

  test("0 orphan selectors: every style.css class is in index.html or a class literal in static/*.js", () => {
    const used = new Set(ELS.flatMap(classes));
    const orphans = [...new Set(RULES.flatMap((r) => r.parts.flatMap(selectorClasses)))]
      .filter((c) => !used.has(c) && !inJs(c));
    assert.deepEqual(orphans, [], `style.css classes used nowhere: ${orphans.join(" ")}`);
  });

  // MEM-048 (plan B3) changed F13: #auto moved from #load-demo's container into #routes-settings,
  // its only home.
  test("F13: #auto and its label sit inside #routes-settings", () => {
    const auto = byId("auto"), settings = byId("routes-settings");
    assert.ok(auto, "#auto is missing");
    assert.ok(settings, "#routes-settings is missing");
    const label = [auto, ...ancestors(auto)].find((e) => e.tag === "label")
      ?? ELS.find((e) => e.tag === "label" && e.attrs.for === "auto");
    assert.ok(label, "#auto has no <label>");
    assert.ok(ancestors(auto).includes(settings), `#auto is outside #routes-settings`);
    assert.ok(ancestors(label).includes(settings), `the #auto label is outside #routes-settings`);
  });

  test("F13: every text/file/password input has a <label for> inside one .field wrapper with it", () => {
    const inputs = ELS.filter((e) => e.tag === "input" && ["text", "file", "password"]
      .includes((e.attrs.type ?? "text").toLowerCase()));
    assert.ok(inputs.length >= 4, `only ${inputs.length} text/file/password inputs found`);
    for (const input of inputs) {
      const id = input.attrs.id;
      const label = ELS.find((e) => e.tag === "label" && e.attrs.for === id);
      assert.ok(label, `#${id} has no <label for="${id}">`);
      const field = closestClass(input, "field");
      assert.ok(field, `#${id} is not inside a .field wrapper`);
      assert.equal(closestClass(label, "field"), field,
        `the #${id} label is outside #${id}'s .field ${desc(field)}`);
      const nested = ancestors(field).filter((e) => classes(e).includes("field"));
      assert.deepEqual(nested, [], `#${id} is inside more than one .field wrapper`);
    }
  });

  test("F13: a top-level .field rule sets display grid or block", () => {
    const field = RULES.filter((r) => r.media.length === 0 && r.parts.includes(".field")
      && decl(r, "display"));
    assert.ok(field.length, "style.css has no .field rule setting display");
    const display = decl(field[field.length - 1], "display");
    assert.match(display, /^(grid|block)$/, `.field display is ${display}`);
  });

  test("F13: main has no bare <label> or <input> child", () => {
    const main = ELS.find((e) => e.tag === "main");
    assert.ok(main, "index.html has no <main>");
    const bare = main.children.filter((c) => c.tag === "label" || c.tag === "input");
    assert.deepEqual(bare.map(desc), [], "bare top-level label/input children of main");
  });

  test("#auto stays a native visible checkbox", () => {
    const auto = byId("auto");
    assert.ok(auto, "#auto is missing");
    assert.equal(auto.tag, "input");
    assert.equal((auto.attrs.type ?? "").toLowerCase(), "checkbox", "#auto is not type=checkbox");
    for (const found of [auto, ...ancestors(auto)]) {
      // MEM-072: a section.tab-panel starts hidden and tabbar.js showTab reveals it; check it as revealed.
      const tabPanel = found !== auto && found.tag === "section" && classes(found).includes("tab-panel");
      const { hidden: _revealed, ...shownAttrs } = found.attrs;
      const el = tabPanel ? { ...found, attrs: shownAttrs } : found;
      assert.ok(!("hidden" in el.attrs), `${desc(el)} around #auto is hidden`);
      for (const r of rulesMatching(el)) {
        const at = `${r.parts.join(", ")} (on ${desc(el)})`;
        assert.notEqual(decl(r, "display"), "none", `${at} sets display: none`);
        assert.doesNotMatch(decl(r, "visibility") ?? "", /^(hidden|collapse)$/, `${at} hides #auto`);
        assert.notEqual(Number(decl(r, "opacity") ?? 1), 0, `${at} sets opacity: 0`);
        if (el !== auto) continue;
        for (const p of ["appearance", "-webkit-appearance", "-moz-appearance"]) {
          assert.notEqual(decl(r, p), "none", `${at} sets ${p}: none`);
        }
        assert.match(decl(r, "clip-path") ?? "none", /^none$/, `${at} clips #auto`);
        assert.match(decl(r, "clip") ?? "auto", /^auto$/, `${at} clips #auto`);
      }
    }
  });

  test("button and .btn rules set min-height >= 44px", () => {
    for (const sel of ["button", ".btn"]) {
      const hits = RULES.filter((r) => r.media.length === 0 && r.parts.includes(sel)
        && decl(r, "min-height"));
      assert.ok(hits.length, `style.css has no ${sel} rule setting min-height`);
      const h = px(decl(hits[hits.length - 1], "min-height"));
      assert.ok(h >= 44, `${sel} min-height is ${decl(hits[hits.length - 1], "min-height")} (< 44px)`);
    }
  });

  test("no rule lowers a button, .btn or F7 Show/Hide toggle below 44px", () => {
    const toggle = { tag: "button", attrs: { type: "button", "aria-expanded": "false" }, children: [] };
    const targets = [...ELS.filter((e) => e.tag === "button" || classes(e).includes("btn")), toggle];
    for (const el of targets) {
      const name = el === toggle ? 'F7 toggle <button aria-expanded="false">' : desc(el);
      const rules = rulesMatching(el);
      assert.ok(rules.some((r) => px(decl(r, "min-height")) >= 44),
        `${name}: no rule gives min-height >= 44px`);
      for (const r of rules) {
        for (const p of ["min-height", "height", "max-height"]) {
          const v = px(decl(r, p));
          assert.ok(v === undefined || v >= 44, `${name}: ${r.parts.join(", ")} sets ${p}: ${decl(r, p)}`);
        }
      }
    }
  });

  test("no wrapper between main and #scene-overlay sets an A1-forbidden property", () => {
    const overlay = byId("scene-overlay");
    assert.ok(overlay, "#scene-overlay is missing");
    for (const el of ancestors(overlay)) {
      for (const r of rulesMatching(el)) {
        for (const [p] of r.decls) {
          const bare = p.replace(/^-(webkit|moz|ms)-/, "");
          assert.ok(!FORBIDDEN.has(bare),
            `${r.parts.join(", ")} sets ${p} on #scene-overlay ancestor ${desc(el)}`);
        }
      }
    }
  });
});

// Covers: MEM-073
// Requirement: the room-photo upload flow is retired (ADR 0040), so the first screen no longer
// invites a room photo: index.html says neither "room photo" nor "photo of a room" (any case), while
// every A5 id stays exactly once (the #photo input included; checked above).
describe("MEM-073 first screen has no room-photo copy", () => {
  for (const phrase of ["room photo", "photo of a room"]) {
    test(`index.html never says "${phrase}"`, () => {
      const at = HTML.toLowerCase().indexOf(phrase);
      assert.equal(at, -1, `index.html still says "${phrase}": ...${HTML.slice(Math.max(0, at - 40), at + 40)}...`);
    });
  }
});

// Covers: MEM-114
// Requirement: the zero-route empty state shows the slogan "Find a home for every memory" beside Pal.
describe("MEM-114 empty-state slogan markup (static/index.html)", () => {
  test("#empty-slogan text is exactly 'Find a home for every memory'", () => {
    const m = HTML.match(/<([a-z0-9]+)\b[^>]*\bid=["']empty-slogan["'][^>]*>([\s\S]*?)<\/\1>/i);
    assert.ok(m, "index.html has no element with id empty-slogan");
    assert.equal(m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(), "Find a home for every memory");
  });

  test("#empty-slogan is not hidden in the markup", () => {
    const el = byId("empty-slogan");
    assert.ok(el, "index.html has no element with id empty-slogan");
    assert.equal("hidden" in el.attrs, false, "#empty-slogan carries the hidden attribute");
  });

  test("#empty-slogan is the next element sibling after #empty-state", () => {
    const pal = byId("empty-state");
    const slogan = byId("empty-slogan");
    assert.ok(slogan, "index.html has no element with id empty-slogan");
    assert.equal(slogan.parent, pal.parent, "#empty-slogan is not in the same parent as #empty-state");
    const sibs = pal.parent.children;
    assert.equal(sibs[sibs.indexOf(pal) + 1], slogan, "#empty-slogan does not immediately follow #empty-state");
  });
});
