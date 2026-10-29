// Covers: MEM-044
// Requirement: static/style.css carries the v6 look (MEM-044 A1): the 21 v6 tokens (--bg..--shadow,
// --display, --body, --mono) under :root, the 18 v6 colour/shadow tokens (--bg..--shadow) redefined under
// the prefers-color-scheme dark :root:not([data-theme="light"]) block and :root[data-theme="dark"] (as in
// docs/design/v6/styles.css; font stacks do not change per mode), with color-scheme in all 3; every token
// is consumed by a var(); system font stacks only (0 @font-face, 0 @import, 0 http); CSP-clean; the live
// [hidden], #empty-state, img and #scene-overlay rules are kept; html, :root, body and main carry no
// property that would stop #scene-overlay being viewport-fixed; token pairs meet WCAG contrast in light
// and dark; every rule setting a background has an effective text colour >= 4.5:1; a rule setting color
// on input/textarea/select/button also sets background.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const RAW = read("./style.css");
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, "");

const TOKENS = [
  "--bg", "--surface", "--surface-2", "--ink", "--muted", "--line", "--primary", "--on-primary",
  "--lamp", "--lamp-ink", "--lamp-soft", "--ok", "--ok-soft", "--bad", "--bad-soft", "--on-bad",
  "--focus", "--shadow", "--display", "--body", "--mono",
];
const DARK_TOKENS = TOKENS.filter((t) => !["--display", "--body", "--mono"].includes(t));
const DARK_MEDIA = "@media(prefers-color-scheme:dark)";
const CONTEXTS = {
  light: { media: null, sel: ":root", tokens: TOKENS },
  "dark (prefers-color-scheme)": {
    media: DARK_MEDIA, sel: ':root:not([data-theme="light"])', tokens: DARK_TOKENS,
  },
  "dark ([data-theme=dark])": { media: null, sel: ':root[data-theme="dark"]', tokens: DARK_TOKENS },
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
const normSel = (s) => norm(s).replace(/'/g, '"');

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
        return [d.slice(0, i).trim().toLowerCase(), norm(d.slice(i + 1))];
      });
      const media = stack.filter((h) => h.startsWith("@media"))
        .map((h) => h.toLowerCase().replace(/\s+/g, ""));
      rules.push({ parts: splitTop(head, ",").map(normSel), decls, media });
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
const rulesFor = (sel) => RULES.filter((r) => r.parts.includes(sel));

function contextDecls({ media, sel }) {
  const out = {};
  for (const r of RULES) {
    const inCtx = media === null ? r.media.length === 0 : r.media.length === 1 && r.media[0].includes(
      media.slice("@media".length));
    if (inCtx && r.parts.includes(sel)) for (const [p, v] of r.decls) out[p] = v;
  }
  return out;
}

const LIGHT = contextDecls(CONTEXTS.light);
const MODES = {
  light: LIGHT,
  dark: { ...LIGHT, ...contextDecls(CONTEXTS["dark (prefers-color-scheme)"]) },
  "dark-attr": { ...LIGHT, ...contextDecls(CONTEXTS["dark ([data-theme=dark])"]) },
};

// Replace every var(--x[, fallback]) with the mode's token value, recursively.
function resolveVars(value, tokens, depth = 0) {
  if (depth > 10) return value;
  const at = value.indexOf("var(");
  if (at < 0) return value;
  let i = at + 4, level = 1;
  while (i < value.length && level > 0) { if (value[i] === "(") level++; if (value[i] === ")") level--; i++; }
  const [name, ...fb] = splitTop(value.slice(at + 4, i - 1), ",");
  const hit = tokens[name.trim()] ?? (fb.length ? fb.join(",").trim() : `<unresolved ${name.trim()}>`);
  const inner = resolveVars(hit, tokens, depth + 1);
  return resolveVars(value.slice(0, at) + inner + value.slice(i), tokens, depth);
}

const COLOR_RE =
  /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black|transparent|currentcolor)\b|<unresolved [^>]*>/gi;

function parseColor(s) {
  const t = s.trim().toLowerCase();
  if (t === "white") return [255, 255, 255, 1];
  if (t === "black") return [0, 0, 0, 1];
  if (t === "transparent") return [0, 0, 0, 0];
  let m = t.match(/^#([0-9a-f]{3,8})$/);
  if (m && [3, 4, 6, 8].includes(m[1].length)) {
    const h = m[1].length <= 4 ? [...m[1]].map((c) => c + c).join("") : m[1];
    const n = (k) => parseInt(h.slice(k, k + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = t.match(/^rgba?\(([^)]*)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = (v) => (v.endsWith("%") ? (parseFloat(v) * 255) / 100 : parseFloat(v));
    const a = p[3] === undefined ? 1 : p[3].endsWith("%") ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    if (p.length >= 3 && [0, 1, 2].every((k) => Number.isFinite(ch(p[k]))) && Number.isFinite(a)) {
      return [ch(p[0]), ch(p[1]), ch(p[2]), a];
    }
  }
  return null;
}

const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
const lum = (c) => {
  const [r, g, b] = c.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// The mode's opaque colour for a token, or an assertion failure naming what is missing.
function tokenColor(mode, name) {
  const raw = MODES[mode][name];
  assert.ok(raw !== undefined, `${mode}: token ${name} is not declared`);
  const c = parseColor(resolveVars(raw, MODES[mode]));
  assert.ok(c, `${mode}: token ${name} = ${raw} is not a colour`);
  return c[3] < 1 ? over(c, tokenColor(mode, "--bg")) : c;
}

const GENERIC = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "math", "emoji", "fangsong",
]);
const FORBIDDEN = new Set([
  "filter", "backdrop-filter", "transform", "perspective", "will-change", "contain", "mix-blend-mode",
  "isolation", "z-index", "overflow", "overflow-x", "overflow-y",
]);
const ROOTISH = /^(html|:root|body|main)(?:\[[^\]]*\]|[.#][\w-]+|:(?!:)[\w-]+(?:\([^)]*\))?)*$/i;
const lastCompound = (part) => splitTop(part.replace(/\s*([>+~])\s*/g, " "), " ").filter(Boolean).pop() ?? "";
const modesOf = (rule) => {
  const m = rule.media.join(" ");
  if (m.includes("prefers-color-scheme:dark")) return ["dark"];
  if (m.includes("prefers-color-scheme:light")) return ["light"];
  return Object.keys(MODES);
};

// Covers: MEM-044
// Requirement: MEM-044 A1 v6 tokens + base in static/style.css (see the file header).
describe("MEM-044 A1 v6 tokens + base (static/style.css)", () => {
  for (const [label, ctx] of Object.entries(CONTEXTS)) {
    test(`${label}: its ${ctx.tokens.length} v6 tokens and color-scheme are under ${ctx.sel}`, () => {
      const got = contextDecls(ctx);
      const missing = ctx.tokens.filter((t) => !(t in got));
      const where = `${ctx.media ?? "top level"} ${ctx.sel}`;
      assert.deepEqual(missing, [], `${label} (${where}) lacks ${missing.join(" ")}`);
      const scheme = got["color-scheme"];
      assert.ok(scheme, `${label}: no color-scheme declaration`);
      const want = label === "light" ? "light" : "dark";
      assert.match(scheme, new RegExp(`\\b${want}\\b`), `${label}: color-scheme is "${scheme}"`);
      if (want === "dark") assert.doesNotMatch(scheme, /\blight\b/, `${label}: color-scheme is "${scheme}"`);
    });
  }

  test("every v6 token and every declared custom property is consumed by a var() (0 dead tokens)", () => {
    const declared = new Set([...TOKENS, ...RULES.flatMap((r) => r.decls.map(([p]) => p))
      .filter((p) => p.startsWith("--"))]);
    const dead = [...declared].filter((t) => !new RegExp(`var\\(\\s*${t}\\s*[,)]`).test(CSS));
    assert.deepEqual(dead, [], `tokens never read via var(): ${dead.join(" ")}`);
  });

  test("system font stacks only: 0 @font-face, 0 @import, 0 http, url() only data: or /static/", () => {
    assert.doesNotMatch(CSS, /@font-face/i, "style.css declares @font-face");
    assert.doesNotMatch(CSS, /@import/i, "style.css uses @import");
    assert.doesNotMatch(CSS, /http/i, "style.css references http(s)");
    for (const m of CSS.matchAll(/url\(\s*["']?([^"')\s]*)/gi)) {
      assert.match(m[1], /^(data:|\/static\/)/, `url(${m[1]}) is neither data: nor /static/`);
    }
  });

  test("--display, --body and --mono end in a generic system family in every context", () => {
    for (const [mode, tokens] of Object.entries(MODES)) {
      for (const t of ["--display", "--body", "--mono"]) {
        assert.ok(tokens[t], `${mode}: ${t} is not declared`);
        const last = splitTop(tokens[t], ",").pop().trim().replace(/["']/g, "").toLowerCase();
        assert.ok(GENERIC.has(last), `${mode}: ${t} = ${tokens[t]} does not end in a generic family`);
      }
    }
  });

  test("CSP-clean: 0 style= and 0 <style> in index.html, no script-in-CSS, no eval in static JS", () => {
    const html = read("./index.html");
    assert.doesNotMatch(html, /\sstyle\s*=/i, "index.html has an inline style= attribute");
    assert.doesNotMatch(html, /<style/i, "index.html has a <style> element");
    assert.doesNotMatch(CSS, /expression\(|javascript:|-moz-binding|behavior\s*:/i, "style.css runs script");
    for (const f of readdirSync(new URL("./", import.meta.url)).filter((n) => n.endsWith(".js"))) {
      assert.doesNotMatch(read(`./${f}`), /\beval\s*\(|\bnew\s+Function\s*\(/, `static/${f} uses eval`);
    }
  });

  test("the live [hidden] rule keeps its display: none !important spelling", () => {
    const hidden = RULES.filter((r) => r.media.length === 0 && r.parts.includes("[hidden]"));
    assert.ok(hidden.length, "style.css lost the global [hidden] rule");
    assert.ok(hidden.some((r) => decl(r, "display") === "none !important"),
      `[hidden] display is ${hidden.map((r) => decl(r, "display")).join(", ")}, not "none !important"`);
  });

  test("the #empty-state, img and #scene-overlay rules are kept", () => {
    assert.ok(rulesFor("#empty-state").some((r) => decl(r, "display") === "block"),
      "no #empty-state display: block");
    const isImg = (r) => r.parts.some((p) => lastCompound(p) === "img");
    assert.ok(RULES.some((r) => isImg(r) && decl(r, "max-width") === "100%"),
      "no img { max-width: 100% } rule");
    const ov = rulesFor("#scene-overlay");
    const val = (p) => ov.map((r) => decl(r, p)).filter((v) => v !== undefined).pop();
    assert.equal(val("position"), "fixed", "#scene-overlay is not position: fixed");
    assert.match(val("inset") ?? "", /^0(px)?$/, "#scene-overlay is not inset: 0");
    assert.ok(Number(val("z-index")) >= 10, `#scene-overlay z-index ${val("z-index")} < 10`);
  });

  test("html, :root, body and main set no overlay-breaking property; no body::before layer", () => {
    for (const r of RULES) {
      if (!r.parts.some((p) => ROOTISH.test(p))) continue;
      for (const [p] of r.decls) {
        const bare = p.replace(/^-(webkit|moz|ms)-/, "");
        assert.ok(!FORBIDDEN.has(bare), `${r.parts.join(", ")} sets ${p}`);
      }
    }
    assert.deepEqual(rulesFor("body::before"), [], "the v6 body::before fixed layer is still present");
  });

  test("token contrast >= 4.5:1 (text) and >= 3:1 (focus, line) in light and both dark contexts", () => {
    const pairs = [
      ["--ink", "--bg", 4.5], ["--ink", "--surface", 4.5], ["--muted", "--bg", 4.5],
      ["--muted", "--surface", 4.5], ["--muted", "--surface-2", 4.5], ["--on-primary", "--primary", 4.5],
      ["--primary", "--surface", 4.5], ["--lamp-ink", "--lamp-soft", 4.5], ["--ink", "--lamp-soft", 4.5],
      ["--ok", "--ok-soft", 4.5], ["--bad", "--bad-soft", 4.5], ["--on-bad", "--bad", 4.5],
      ["--focus", "--bg", 3], ["--line", "--surface", 3],
    ];
    for (const mode of Object.keys(MODES)) {
      for (const [fg, bg, min] of pairs) {
        const r = ratio(tokenColor(mode, fg), tokenColor(mode, bg));
        assert.ok(r >= min, `${mode}: ${fg} on ${bg} is ${r.toFixed(2)}:1 < ${min}:1`);
      }
    }
  });

  test("every rule setting a background has an effective text colour >= 4.5:1 in each mode", () => {
    for (const r of RULES.filter((x) => decl(x, "background") || decl(x, "background-color"))) {
      for (const mode of modesOf(r)) {
        const tokens = MODES[mode];
        const pageBg = tokenColor(mode, "--bg");
        const own = decl(r, "color");
        const inherit = !own || /^(inherit|currentcolor|unset|initial|revert)$/i.test(own);
        const text = parseColor(resolveVars(inherit ? "var(--ink)" : own, tokens));
        assert.ok(text, `${mode}: ${r.parts.join(", ")} text colour ${own ?? "var(--ink)"} does not resolve`);
        for (const p of ["background", "background-color"]) {
          const v = decl(r, p);
          if (!v) continue;
          for (const lit of resolveVars(v, tokens).match(COLOR_RE) ?? []) {
            const c = /^currentcolor$/i.test(lit) ? text : parseColor(lit);
            assert.ok(c, `${mode}: ${r.parts.join(", ")} ${p} colour ${lit} does not resolve`);
            if (c[3] === 0) continue;
            const bg = over(c, pageBg);
            const cr = ratio(text[3] < 1 ? over(text, bg) : text, bg);
            assert.ok(cr >= 4.5, `${mode}: ${r.parts.join(", ")} text on ${p} ${lit} is ${cr.toFixed(2)}:1`);
          }
        }
      }
    }
  });

  test("a rule setting color on input, textarea, select or button also sets background", () => {
    const ctl = /^(input|textarea|select|button)(?=$|[.#:[])/i;
    for (const r of RULES) {
      if (!decl(r, "color") || !r.parts.some((p) => ctl.test(lastCompound(p)))) continue;
      assert.ok(decl(r, "background") || decl(r, "background-color"),
        `${r.parts.join(", ")} sets color without background`);
    }
  });
});
