// Covers: MEM-044
// Requirement: static/theme-painterly.css is the droppable painterly theme (MEM-044 P1), linked last after
// style.css. It visibly changes the live app (no-op guard: it remaps v6 tokens style.css consumes, in all
// 3 A1 token selectors, and every theme token is a v6 token or read in the theme); it is CSP-clean (0
// http(s), 0 @import, url() only data: or /static/, small hostile-free SVG data URIs); text keeps WCAG
// contrast over the paper grain (alpha <= 0.08) in light and dark; it never breaks the 360 px layout or the
// viewport-fixed #scene-overlay (no filter:url, no blend modes, no fixed backgrounds, deckle only as a
// .panel::before mask); it styles only markup that exists; forced-colors, more-contrast and print drop
// every painterly image/filter/mask/border-image; 0 animation; 0 !important so [hidden] still wins.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const THEME_FILE = "theme-painterly.css";
const HTML = read("./index.html");
const STYLE = strip(read("./style.css"));
let themeCache;
const themeCss = () => {
  assert.ok(existsSync(new URL(`./${THEME_FILE}`, import.meta.url)), `static/${THEME_FILE} missing`);
  themeCache ??= strip(read(`./${THEME_FILE}`));
  return themeCache;
};

const TOKENS = [
  "--bg", "--surface", "--surface-2", "--ink", "--muted", "--line", "--primary", "--on-primary",
  "--lamp", "--lamp-ink", "--lamp-soft", "--ok", "--ok-soft", "--bad", "--bad-soft", "--on-bad",
  "--focus", "--shadow", "--display", "--body", "--mono",
];
const CONTEXTS = {
  light: { media: null, sel: ":root", scheme: "light" },
  dark: { media: "(prefers-color-scheme:dark)", sel: ':root:not([data-theme="light"])', scheme: "dark" },
  "dark-attr": { media: null, sel: ':root[data-theme="dark"]', scheme: "dark" },
};
const FORBIDDEN = new Set([
  "filter", "backdrop-filter", "transform", "perspective", "will-change", "contain", "mix-blend-mode",
  "isolation", "z-index", "overflow", "overflow-x", "overflow-y",
]);
const ROOTISH = /^(html|:root|body|main)(?:\[[^\]]*\]|[.#][\w-]+|:(?!:)[\w-]+(?:\([^)]*\))?)*$/i;
const RESET_MEDIA = { "forced-colors": /\(forced-colors:active\)/, "prefers-contrast": /\(prefers-contrast:more\)/,
  print: /\bprint\b/ };
const IMAGE_PROPS = ["background-image", "filter", "mask-image", "border-image"];
const GRAIN_MAX = 0.08;

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

// Rules: { parts: [selector...], decls: [[prop, value]], media: [normalized @media preludes] }.
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
      const media = stack.filter((h) => h.startsWith("@media")).map((h) => h.toLowerCase().replace(/\s+/g, ""));
      rules.push({ parts: splitTop(head, ",").map(normSel), decls, media });
    }
    buf = "";
  }
  return rules;
}
const decl = (rule, prop) => rule.decls.filter(([p]) => p === prop).map(([, v]) => v).pop();
const bare = (p) => p.replace(/^-(webkit|moz|ms)-/, "");
const compounds = (part) => splitTop(part.replace(/\s*([>+~])\s*/g, " "), " ").filter(Boolean);
const lastCompound = (part) => compounds(part).pop() ?? "";
const where = (r) => `${r.media.join(" ")} ${r.parts.join(", ")}`.trim();
const STYLE_RULES = parseRules(STYLE);
const themeRules = () => parseRules(themeCss());
const isReset = (r) => Object.values(RESET_MEDIA).some((re) => r.media.some((m) => re.test(m)));

function contextDecls(rules, { media, sel }) {
  const out = {};
  for (const r of rules) {
    const inCtx = media === null ? r.media.length === 0 : r.media.length === 1 && r.media[0].includes(media);
    if (inCtx && r.parts.includes(sel)) for (const [p, v] of r.decls) out[p] = v;
  }
  return out;
}
// Tokens per mode with the theme cascading over style.css (it is linked after it).
function modes() {
  const tr = themeRules();
  const light = { ...contextDecls(STYLE_RULES, CONTEXTS.light), ...contextDecls(tr, CONTEXTS.light) };
  const dark = (ctx) => ({ ...light, ...contextDecls(STYLE_RULES, ctx), ...contextDecls(tr, ctx) });
  return { light, dark: dark(CONTEXTS.dark), "dark-attr": dark(CONTEXTS["dark-attr"]) };
}

// Replace every var(--x[, fallback]) with the mode's token value, recursively.
function resolveVars(value, tokens, depth = 0) {
  if (depth > 10) return value;
  const at = value.indexOf("var(");
  if (at < 0) return value;
  let i = at + 4, level = 1;
  while (i < value.length && level > 0) { if (value[i] === "(") level++; if (value[i] === ")") level--; i++; }
  const [name, ...fb] = splitTop(value.slice(at + 4, i - 1), ",");
  const hit = tokens[name.trim()] ?? (fb.length ? fb.join(",").trim() : `<unresolved ${name.trim()}>`);
  return resolveVars(value.slice(0, at) + resolveVars(hit, tokens, depth + 1) + value.slice(i), tokens, depth);
}
const COLOR_RE =
  /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black|transparent|currentcolor)\b|<unresolved [^>]*>/gi;
const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const noUrls = (v) => v.replace(URL_RE, "");

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
function tokenColor(tokens, mode, name) {
  const raw = tokens[name];
  assert.ok(raw !== undefined, `${mode}: token ${name} is not declared`);
  const c = parseColor(resolveVars(raw, tokens));
  assert.ok(c, `${mode}: token ${name} = ${raw} is not a colour`);
  return c[3] < 1 ? over(c, tokenColor(tokens, mode, "--bg")) : c;
}

// Raw url() targets of a stylesheet, then the decoded body of a data: URI.
const urls = (css) => [...css.matchAll(URL_RE)].map((m) => m[1] ?? m[2] ?? m[3]);
function decodeData(uri) {
  const comma = uri.indexOf(",");
  const head = uri.slice(0, comma), body = uri.slice(comma + 1);
  return /;base64$/i.test(head) ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
}
const attrsOf = (rest) => Object.fromEntries([...rest.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)]
  .map((a) => [a[1].toLowerCase(), a[3] ?? a[4]]));

// Well-formed XML check: one <svg> root, balanced tags, quoted attributes, legal entities.
// Returns { problem } or { root: attrs, elements: [{ tag, attrs }] }.
function parseSvg(src) {
  const s = src.replace(/^\s*<\?xml[\s\S]*?\?>/, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  const stack = [], elements = [];
  let last = 0, closedRoot = false;
  const tagRe = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g;
  for (const m of s.matchAll(tagRe)) {
    const text = s.slice(last, m.index);
    if (text.includes("<") || (closedRoot && text.trim())) return { problem: `stray text ${text}` };
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(text)) return { problem: "bad entity" };
    last = m.index + m[0].length;
    const [, close, tag, rest, self] = m;
    if (closedRoot) return { problem: `content after the root: <${close}${tag}>` };
    if (close) {
      if (stack.pop() !== tag) return { problem: `unbalanced </${tag}>` };
      if (!stack.length) closedRoot = true;
      continue;
    }
    if (!/^(\s+[\w:.-]+\s*=\s*("[^"]*"|'[^']*'))*\s*$/.test(rest)) return { problem: `bad attributes on <${tag}>` };
    if (!elements.length && tag !== "svg") return { problem: `root is <${tag}>, not <svg>` };
    if (elements.length && !stack.length) return { problem: "more than one root element" };
    elements.push({ tag, attrs: attrsOf(rest) });
    if (self) { if (!stack.length) closedRoot = true; } else stack.push(tag);
  }
  if (s.slice(last).trim() || stack.length || !closedRoot) return { problem: "unclosed or trailing content" };
  return { root: elements[0].attrs, elements };
}

// Worst-case alpha of a grain SVG: root opacity x the largest opacity on any drawing element.
function grainAlpha(svg) {
  const op = (a) => ["opacity", "fill-opacity", "stroke-opacity", "flood-opacity"]
    .map((k) => a[k]).filter((v) => v !== undefined).map(Number);
  const root = op(svg.root);
  const inner = svg.elements.slice(1).flatMap((e) => op(e.attrs));
  return (root.length ? Math.min(...root) : 1) * (inner.length ? Math.max(...inner) : 1);
}

const linkedSheets = () => [...HTML.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0])
  .filter((t) => /rel\s*=\s*"stylesheet"/i.test(t)).map((t) => t.match(/href\s*=\s*"([^"]*)"/i)?.[1]);
const HTML_TAGS = new Set([...HTML.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase()));
const HTML_IDS = new Set([...HTML.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]));
const HTML_CLASSES = new Set([...HTML.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)));
const JS = readdirSync(new URL("./", import.meta.url)).filter((n) => n.endsWith(".js"))
  .map((f) => read(`./${f}`)).join("\n");
const inJs = (c) => new RegExp(`["'\`]([^"'\`\\n]*\\s)?${c}(\\s[^"'\`\\n]*)?["'\`]`).test(JS);
const usesVar = (css, t) => new RegExp(`var\\(\\s*${t}\\s*[,)]`).test(css);
const themeTokens = () => [...new Set(themeRules().flatMap((r) => r.decls.map(([p]) => p))
  .filter((p) => p.startsWith("--")))];

// Covers: MEM-044
// Requirement: MEM-044 P1 painterly theme (static/theme-painterly.css; see the file header).
describe("MEM-044 P1 painterly theme (static/theme-painterly.css)", () => {
  test("no-op guard: in each A1 token selector the theme remaps a v6 token that style.css consumes", () => {
    const tr = themeRules();
    for (const [label, ctx] of Object.entries(CONTEXTS)) {
      const mine = contextDecls(tr, ctx), base = contextDecls(STYLE_RULES, ctx);
      const changed = TOKENS.filter((t) => t in mine && usesVar(STYLE, t) && norm(mine[t]) !== norm(base[t] ?? ""));
      assert.ok(changed.length, `${label} (${ctx.sel}): the theme remaps no v6 token style.css reads`);
    }
  });

  test("no-op guard + 0 dead tokens: every theme token is a v6 token or read via var() in the theme", () => {
    const css = themeCss();
    const dead = themeTokens().filter((t) => !TOKENS.includes(t) && !usesVar(css, t));
    assert.deepEqual(dead, [], `theme tokens that change nothing: ${dead.join(" ")}`);
  });

  test("index.html links the theme as its LAST stylesheet, with 0 style= and 0 <style", () => {
    themeCss();
    assert.equal(linkedSheets().pop(), `/static/${THEME_FILE}`, `stylesheets: ${linkedSheets().join(" ")}`);
    assert.doesNotMatch(HTML, /\sstyle\s*=/i, "index.html has an inline style= attribute");
    assert.doesNotMatch(HTML, /<style/i, "index.html has a <style> element");
  });

  test("CSP-clean: 0 http(s) outside data: URIs, 0 @import, every url() is data: or /static/", () => {
    const css = themeCss();
    assert.doesNotMatch(css, /@import/i, "theme uses @import");
    assert.doesNotMatch(css.replace(URL_RE, "url()"), /https?:/i, "theme references an http(s) URL");
    for (const u of urls(css)) assert.match(u, /^(data:|\/static\/)/, `url(${u.slice(0, 40)}) is not data: or /static/`);
  });

  test("each data: URI is a small hostile-free SVG: xmlns, no raw #, no style/script/href/url(, <= 256 px", () => {
    const data = urls(themeCss()).filter((u) => u.startsWith("data:"));
    assert.ok(data.length, "theme has no data: URI (deckle and grain are data: SVGs)");
    for (const u of data) {
      const tag = u.slice(0, 40);
      assert.match(u, /^data:image\/svg\+xml[;,]/i, `${tag} is not image/svg+xml`);
      assert.ok(!u.includes("#"), `${tag} has a raw # (encode it as %23)`);
      const xml = decodeData(u);
      const svg = parseSvg(xml);
      assert.ok(!svg.problem, `${tag} is not well-formed SVG XML: ${svg.problem}`);
      assert.equal(svg.root.xmlns, "http://www.w3.org/2000/svg", `${tag} lacks the SVG xmlns`);
      assert.doesNotMatch(xml, /<style|style\s*=|<script|href|url\(/i, `${tag} carries style/script/href/url(`);
      assert.doesNotMatch(xml.replace(/xmlns=(["'])http:\/\/www\.w3\.org\/2000\/svg\1/, ""), /https?:/i,
        `${tag} references an http(s) URL`);
      for (const k of ["width", "height"]) {
        assert.match(svg.root[k] ?? "", /^\d+(\.\d+)?(px)?$/, `${tag} has no explicit numeric ${k}`);
        assert.ok(parseFloat(svg.root[k]) <= 256, `${tag} ${k}=${svg.root[k]} > 256`);
      }
    }
    const total = data.reduce((n, u) => n + Buffer.byteLength(u, "utf8"), 0);
    assert.ok(total <= 4096, `data: URIs total ${total} bytes > 4096`);
  });

  test("tokens live only under the 3 A1 selectors, each with color-scheme; --body is never set", () => {
    const tr = themeRules();
    for (const r of tr.filter((x) => x.decls.some(([p]) => p.startsWith("--")))) {
      const ok = Object.values(CONTEXTS).some((c) => r.parts.length === 1 && r.parts[0] === c.sel
        && (c.media === null ? r.media.length === 0 : r.media.length === 1 && r.media[0].includes(c.media)));
      assert.ok(ok, `theme declares tokens under ${where(r)}, not an A1 token selector`);
    }
    for (const [label, ctx] of Object.entries(CONTEXTS)) {
      const scheme = contextDecls(tr, ctx)["color-scheme"];
      assert.ok(scheme, `${label} (${ctx.sel}): theme sets no color-scheme`);
      assert.match(scheme, new RegExp(`\\b${ctx.scheme}\\b`), `${label}: color-scheme is "${scheme}"`);
    }
    assert.ok(!themeTokens().includes("--body"), "theme sets --body (serif only via --display)");
    for (const r of tr) {
      const ff = decl(r, "font-family");
      if (ff !== undefined) assert.equal(ff, "var(--display)", `${where(r)} font-family is ${ff}`);
    }
  });

  test("token contrast >= 4.5:1 (text) and >= 3:1 (focus, line) with the theme in light and dark", () => {
    const pairs = [
      ["--ink", "--bg", 4.5], ["--ink", "--surface", 4.5], ["--muted", "--bg", 4.5],
      ["--muted", "--surface", 4.5], ["--muted", "--surface-2", 4.5], ["--on-primary", "--primary", 4.5],
      ["--primary", "--surface", 4.5], ["--lamp-ink", "--lamp-soft", 4.5], ["--ink", "--lamp-soft", 4.5],
      ["--ok", "--ok-soft", 4.5], ["--bad", "--bad-soft", 4.5], ["--on-bad", "--bad", 4.5],
      ["--focus", "--bg", 3], ["--line", "--surface", 3],
    ];
    for (const [mode, tokens] of Object.entries(modes())) {
      for (const [fg, bg, min] of pairs) {
        const r = ratio(tokenColor(tokens, mode, fg), tokenColor(tokens, mode, bg));
        assert.ok(r >= min, `${mode}: ${fg} on ${bg} is ${r.toFixed(2)}:1 < ${min}:1`);
      }
    }
  });

  test("every rule setting a background in every linked stylesheet keeps text >= 4.5:1 per mode", () => {
    themeCss();
    const sheets = linkedSheets();
    assert.ok(sheets.includes(`/static/${THEME_FILE}`), `the theme is not linked: ${sheets.join(" ")}`);
    const all = sheets.flatMap((h) => parseRules(strip(read(`./${h.replace(/^\/static\//, "")}`))));
    const md = modes();
    for (const r of all.filter((x) => decl(x, "background") || decl(x, "background-color"))) {
      const m = r.media.join(" ");
      const ms = m.includes("prefers-color-scheme:dark") ? ["dark"]
        : m.includes("prefers-color-scheme:light") ? ["light"] : Object.keys(md);
      for (const mode of ms) {
        const tokens = md[mode], pageBg = tokenColor(tokens, mode, "--bg");
        const own = decl(r, "color");
        const inherit = !own || /^(inherit|currentcolor|unset|initial|revert)$/i.test(own);
        const text = parseColor(resolveVars(inherit ? "var(--ink)" : own, tokens));
        assert.ok(text, `${mode}: ${where(r)} text colour ${own ?? "var(--ink)"} does not resolve`);
        for (const p of ["background", "background-color"]) {
          const v = decl(r, p);
          if (!v) continue;
          for (const lit of noUrls(resolveVars(v, tokens)).match(COLOR_RE) ?? []) {
            const c = /^currentcolor$/i.test(lit) ? text : parseColor(lit);
            assert.ok(c, `${mode}: ${where(r)} ${p} colour ${lit} does not resolve`);
            if (c[3] === 0) continue;
            const bg = over(c, pageBg);
            const cr = ratio(text[3] < 1 ? over(text, bg) : text, bg);
            assert.ok(cr >= 4.5, `${mode}: ${where(r)} text on ${p} ${lit} is ${cr.toFixed(2)}:1`);
          }
        }
      }
    }
  });

  test("grain: a body background data: SVG with alpha <= 0.08; ink, muted, primary on bg >= 4.5:1 over it", () => {
    const grains = themeRules().filter((r) => r.parts.includes("body") && !isReset(r))
      .flatMap((r) => urls((decl(r, "background-image") ?? "") + (decl(r, "background") ?? "")))
      .filter((u) => /^data:image\/svg\+xml/i.test(u));
    assert.ok(grains.length, "no body rule sets a data: SVG grain background");
    for (const u of grains) {
      const svg = parseSvg(decodeData(u));
      assert.ok(!svg.problem, `grain SVG is not well-formed: ${svg.problem}`);
      const a = grainAlpha(svg);
      assert.ok(a <= GRAIN_MAX, `grain alpha (opacity attributes) is ${a} > ${GRAIN_MAX}`);
    }
    for (const [mode, tokens] of Object.entries(modes())) {
      const bg = tokenColor(tokens, mode, "--bg");
      const worst = [over([0, 0, 0, GRAIN_MAX], bg), over([255, 255, 255, GRAIN_MAX], bg)];
      for (const fg of ["--ink", "--muted", "--primary"]) {
        const r = Math.min(...worst.map((w) => ratio(tokenColor(tokens, mode, fg), w)));
        assert.ok(r >= 4.5, `${mode}: ${fg} on --bg under worst-case grain is ${r.toFixed(2)}:1 < 4.5:1`);
      }
    }
  });

  test("overlay-safe: no A1-forbidden property on html, :root, body, main (#scene-overlay ancestors)", () => {
    for (const r of themeRules()) {
      if (!r.parts.some((p) => ROOTISH.test(lastCompound(p)))) continue;
      for (const [p] of r.decls) assert.ok(!FORBIDDEN.has(bare(p)), `${where(r)} sets ${p}`);
    }
  });

  test("0 filter:url(, 0 mix-blend-mode, 0 fixed background, 0 <filter> in index.html", () => {
    const css = themeCss();
    assert.doesNotMatch(css, /filter\s*:[^;}]*url\(/i, "theme uses filter: url(");
    assert.doesNotMatch(HTML, /<filter/i, "index.html carries an inline <svg><filter>");
    for (const r of themeRules()) {
      for (const [p, v] of r.decls) {
        assert.notEqual(bare(p), "mix-blend-mode", `${where(r)} sets mix-blend-mode`);
        if (p === "background-attachment" || p === "background") {
          assert.doesNotMatch(noUrls(v), /\bfixed\b/i, `${where(r)} uses a fixed background`);
        }
      }
    }
  });

  test("deckle: mask-image is set only on .panel::before, as a data: SVG", () => {
    const masks = themeRules().filter((r) => !isReset(r) && r.decls.some(([p]) => /^mask(-image)?$/.test(bare(p))));
    assert.ok(masks.length, "theme sets no deckle mask-image");
    for (const r of masks) {
      assert.deepEqual(r.parts, [".panel::before"], `${where(r)} sets mask-image outside .panel::before`);
      const v = r.decls.filter(([p]) => /^mask(-image)?$/.test(bare(p))).map(([, x]) => x).join(" ");
      assert.ok(urls(v).some((u) => /^data:image\/svg\+xml/i.test(u)), `${where(r)} mask is not a data: SVG`);
    }
  });

  test("0 orphan selectors: every theme tag, id and class exists in index.html or a static/*.js literal", () => {
    const orphans = [];
    for (const r of themeRules()) {
      for (const part of r.parts) {
        for (const c of compounds(part)) {
          const s = c.replace(/\[[^\]]*\]/g, "").replace(/::?[\w-]+(\((?:[^()]|\([^()]*\))*\))?/g, "");
          const tag = s.match(/^([a-z][\w-]*)/i)?.[1]?.toLowerCase();
          if (tag && !HTML_TAGS.has(tag)) orphans.push(`<${tag}> in ${part}`);
          for (const m of s.matchAll(/#([\w-]+)/g)) if (!HTML_IDS.has(m[1])) orphans.push(`#${m[1]} in ${part}`);
          for (const m of s.matchAll(/\.([\w-]+)/g)) {
            if (!HTML_CLASSES.has(m[1]) && !inJs(m[1])) orphans.push(`.${m[1]} in ${part}`);
          }
        }
      }
    }
    assert.deepEqual(orphans, [], `theme selectors matching nothing: ${orphans.join("; ")}`);
  });

  test("forced-colors, prefers-contrast: more and print reset every painterly image/filter/mask/border-image", () => {
    const tr = themeRules();
    const sets = (r, prop) => r.decls.some(([p, v]) => bare(p) === prop
      || (prop === "background-image" && p === "background" && /url\(/i.test(v))
      || (prop === "mask-image" && bare(p) === "mask" && /url\(/i.test(v)));
    const resets = (r, prop) => r.decls.some(([p, v]) => (bare(p) === prop && v === "none")
      || (prop === "background-image" && p === "background" && !/url\(/i.test(v))
      || (prop === "mask-image" && bare(p) === "mask" && v === "none"));
    let painted = 0;
    for (const r of tr.filter((x) => !isReset(x))) {
      for (const prop of IMAGE_PROPS.filter((p) => sets(r, p))) {
        painted++;
        for (const part of r.parts) {
          for (const [name, re] of Object.entries(RESET_MEDIA)) {
            const ok = tr.some((x) => x.media.some((m) => re.test(m)) && x.parts.includes(part) && resets(x, prop));
            assert.ok(ok, `${part} sets ${prop} but no ${name} rule resets it to none`);
          }
        }
      }
    }
    assert.ok(painted, "theme sets no background-image/filter/mask-image/border-image to reset");
  });

  test("0 @keyframes, 0 animation, 0 transition", () => {
    assert.doesNotMatch(themeCss(), /@(-webkit-)?keyframes/i, "theme declares @keyframes");
    for (const r of themeRules()) {
      for (const [p] of r.decls) {
        assert.doesNotMatch(bare(p), /^(animation|transition)/, `${where(r)} sets ${p}`);
      }
    }
  });

  test("0 !important (so the style.css [hidden] rule still wins)", () => {
    assert.doesNotMatch(themeCss(), /!\s*important/i, "theme uses !important");
  });
});
