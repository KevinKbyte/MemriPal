// Shared parsing/colour/SVG helpers for theme_painterly.test.mjs (MEM-044 P1); not a test module.
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
  const stack = [], idx = [], elements = [];
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
      idx.pop();
      if (stack.pop() !== tag) return { problem: `unbalanced </${tag}>` };
      if (!stack.length) closedRoot = true;
      continue;
    }
    if (!/^(\s+[\w:.-]+\s*=\s*("[^"]*"|'[^']*'))*\s*$/.test(rest)) return { problem: `bad attributes on <${tag}>` };
    if (!elements.length && tag !== "svg") return { problem: `root is <${tag}>, not <svg>` };
    if (elements.length && !stack.length) return { problem: "more than one root element" };
    elements.push({ tag, attrs: attrsOf(rest), parent: idx.length ? idx[idx.length - 1] : -1 });
    if (self) { if (!stack.length) closedRoot = true; } else { stack.push(tag); idx.push(elements.length - 1); }
  }
  if (s.slice(last).trim() || stack.length || !closedRoot) return { problem: "unclosed or trailing content" };
  return { root: elements[0].attrs, elements };
}

// Worst-case alpha of a grain SVG: max over painting elements of (opacity chain x paint alpha). A missing
// opacity attribute is alpha 1 (SVG default), never ignored; fill/stroke and their opacities inherit.
const NON_PAINT = new Set(["svg", "g", "defs", "symbol", "title", "desc", "metadata", "clippath", "mask",
  "pattern", "lineargradient", "radialgradient", "stop", "filter"]);
function grainAlpha(svg) {
  const els = svg.elements;
  const num = (v) => (v === undefined ? 1 : Number(v));
  const inherited = (i, k) => {
    for (let e = i; e >= 0; e = els[e].parent) if (els[e].attrs[k] !== undefined) return els[e].attrs[k];
    return undefined;
  };
  let max = 0;
  els.forEach((el, i) => {
    if (NON_PAINT.has(el.tag.toLowerCase())) return;
    let chain = 1;
    for (let e = i; e >= 0; e = els[e].parent) chain *= num(els[e].attrs.opacity);
    const fill = inherited(i, "fill"), stroke = inherited(i, "stroke");
    const paint = [fill === "none" ? 0 : num(inherited(i, "fill-opacity")),
      stroke === undefined || stroke === "none" ? 0 : num(inherited(i, "stroke-opacity"))];
    if (el.attrs["flood-opacity"] !== undefined) paint.push(Number(el.attrs["flood-opacity"]));
    const a = chain * Math.max(...paint);
    max = Number.isFinite(a) ? Math.max(max, a) : 1;
  });
  return max;
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
const sheetRules = () => linkedSheets().flatMap((h) => parseRules(strip(read(`./${h.replace(/^\/static\//, "")}`))));
// Last value of prop for an exact selector part across rules in source order (painterly resets excluded).
function resolved(rules, part, prop) {
  let v;
  for (const r of rules.filter((x) => !isReset(x) && x.parts.includes(part))) v = decl(r, prop) ?? v;
  return v;
}
// Could this compound select html, body or main (the #scene-overlay ancestors)? :is/:where need one
// matching argument; :not/:has and attributes are treated as permissive; pseudo-elements never match.
const ROOT_EL = ["html", "body", "main"].map((tag) => {
  const a = attrsOf(HTML.match(new RegExp(`<${tag}\\b([^>]*)>`, "i"))?.[1] ?? "");
  return { tag, id: a.id, classes: (a.class ?? "").split(/\s+/).filter(Boolean) };
});
const FN_PSEUDO = /:([\w-]+)\(((?:[^()]|\([^()]*\))*)\)/g;
function mayMatchRoot(compound) {
  if (compound.includes("::")) return false;
  for (const m of compound.matchAll(FN_PSEUDO)) {
    if (/^(is|where|matches|-webkit-any|-moz-any)$/i.test(m[1])
      && !splitTop(m[2], ",").some((arg) => mayMatchRoot(lastCompound(normSel(arg))))) return false;
  }
  let c = compound.replace(FN_PSEUDO, "").replace(/\[[^\]]*\]/g, "");
  const isRoot = /:root\b/i.test(c);
  c = c.replace(/:[\w-]+/g, "");
  const tag = c.match(/^([a-z][\w-]*)/i)?.[1]?.toLowerCase();
  const ids = [...c.matchAll(/#([\w-]+)/g)].map((m) => m[1]);
  const cls = [...c.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  return ROOT_EL.some((e) => (!tag || tag === e.tag) && (!isRoot || e.tag === "html")
    && ids.every((i) => i === e.id) && cls.every((k) => e.classes.includes(k)));
}
const setsImage = (r, prop) => r.decls.some(([p, v]) => bare(p) === prop
  || (prop === "background-image" && p === "background" && /url\(/i.test(v))
  || (prop === "mask-image" && bare(p) === "mask" && /url\(/i.test(v)));
const resetsImage = (r, prop) => r.decls.some(([p, v]) => (bare(p) === prop && v === "none")
  || (prop === "background-image" && p === "background" && !/url\(/i.test(v))
  || (prop === "mask-image" && bare(p) === "mask" && v === "none"));
const themeTokens = () => [...new Set(themeRules().flatMap((r) => r.decls.map(([p]) => p))
  .filter((p) => p.startsWith("--")))];

export {
  read,
  strip,
  THEME_FILE,
  HTML,
  STYLE,
  themeCss,
  TOKENS,
  CONTEXTS,
  FORBIDDEN,
  RESET_MEDIA,
  IMAGE_PROPS,
  GRAIN_MAX,
  norm,
  parseRules,
  decl,
  bare,
  compounds,
  lastCompound,
  where,
  STYLE_RULES,
  themeRules,
  isReset,
  contextDecls,
  modes,
  resolveVars,
  COLOR_RE,
  URL_RE,
  noUrls,
  parseColor,
  over,
  ratio,
  tokenColor,
  urls,
  decodeData,
  parseSvg,
  grainAlpha,
  linkedSheets,
  HTML_TAGS,
  HTML_IDS,
  HTML_CLASSES,
  inJs,
  usesVar,
  sheetRules,
  resolved,
  mayMatchRoot,
  setsImage,
  resetsImage,
  themeTokens,
};
