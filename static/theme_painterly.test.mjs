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
import { read, strip, THEME_FILE, HTML, STYLE, themeCss, TOKENS, CONTEXTS, FORBIDDEN, RESET_MEDIA,
  IMAGE_PROPS, GRAIN_MAX, norm, parseRules, decl, bare, compounds, lastCompound, where, STYLE_RULES,
  themeRules, isReset, contextDecls, modes, resolveVars, COLOR_RE, URL_RE, noUrls, parseColor, over, ratio,
  tokenColor, urls, decodeData, parseSvg, grainAlpha, linkedSheets, HTML_TAGS, HTML_IDS, HTML_CLASSES, inJs,
  usesVar, sheetRules, resolved, mayMatchRoot, setsImage, resetsImage, themeTokens } from "./theme_painterly_css_test.mjs";
import { existsSync } from "node:fs";

// Serif families a --body token must not lead with (lowercased, unquoted); generic `serif`/`ui-serif` included.
const SERIF_FAMILIES = new Set([
  "serif", "ui-serif", "fraunces", "georgia", "times", "times new roman", "iowan old style", "palatino",
  "palatino linotype", "book antiqua", "garamond", "eb garamond", "baskerville", "libre baskerville", "cambria",
  "constantia", "charter", "bitstream charter", "didot", "bodoni moda", "merriweather", "lora", "playfair display",
  "source serif pro", "source serif 4", "noto serif", "pt serif", "crimson text", "literata", "newsreader",
]);
const firstFamily = (v) => (v.split(",")[0] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim().toLowerCase();

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

  // MEM-044 P3, amended by MEM-102: --body may be set only with a non-serif first family; serif only via --display.
  test("tokens live only under the 3 A1 selectors, each with color-scheme; --body only non-serif (P3 amended by MEM-102)", () => {
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
    for (const r of tr) {
      const body = decl(r, "--body");
      if (body === undefined) continue;
      const first = firstFamily(body);
      assert.ok(first, `${where(r)} --body has no font family`);
      assert.ok(!SERIF_FAMILIES.has(first), `${where(r)} --body first family "${first}" is a serif (serif only via --display)`);
    }
    for (const r of tr) {
      const ff = decl(r, "font-family");
      if (ff !== undefined) {
        assert.ok(["var(--display)", "var(--body)"].includes(ff), `${where(r)} font-family is ${ff}, not var(--display) or var(--body)`);
      }
    }
  });

  test("token contrast >= 4.5:1 (text) and >= 3:1 (focus, line) with the theme in light and dark", () => {
    const pairs = [
      ["--ink", "--bg", 4.5], ["--ink", "--surface", 4.5], ["--muted", "--bg", 4.5],
      ["--muted", "--surface", 4.5], ["--muted", "--surface-2", 4.5], ["--on-primary", "--primary", 4.5],
      ["--primary", "--surface", 4.5], ["--lamp-ink", "--lamp-soft", 4.5], ["--ink", "--lamp-soft", 4.5],
      ["--ok", "--ok-soft", 4.5], ["--bad", "--bad-soft", 4.5], ["--on-bad", "--bad", 4.5],
      ["--on-lamp", "--lamp", 4.5], ["--focus", "--bg", 3], ["--line", "--surface", 3],
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

  test("overlay-safe: no A1-forbidden property on any selector that can match html, :root, body, main", () => {
    for (const r of themeRules()) {
      if (!r.parts.some((p) => mayMatchRoot(lastCompound(p)))) continue;
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
    const tr = themeRules(), sets = setsImage, resets = resetsImage;
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

  test("each forced-colors / more-contrast / print reset comes AFTER the rule it resets (source order)", () => {
    const tr = themeRules();
    tr.forEach((r, i) => {
      if (isReset(r)) return;
      for (const prop of IMAGE_PROPS.filter((p) => setsImage(r, p))) {
        for (const part of r.parts) {
          for (const [name, re] of Object.entries(RESET_MEDIA)) {
            const later = tr.some((x, j) => j > i && x.media.some((m) => re.test(m)) && x.parts.includes(part)
              && resetsImage(x, prop));
            assert.ok(later, `${part} ${prop}: no ${name} reset after it in source order (an earlier one loses)`);
          }
        }
      }
    });
  });

  test("sticky .topbar stacks above every later positioned stacking context and below #scene-overlay", () => {
    themeCss();
    const all = sheetRules();
    const after = HTML.slice(HTML.search(/class="[^"]*\btopbar\b/));
    const laterInDom = (part) => {
      const s = lastCompound(part).replace(/::?[\w-]+(\((?:[^()]|\([^()]*\))*\))?/g, "").replace(/\[[^\]]*\]/g, "");
      const tag = s.match(/^([a-z][\w-]*)/i)?.[1];
      return (!tag || new RegExp(`<${tag}\\b`, "i").test(after))
        && [...s.matchAll(/#([\w-]+)/g)].every((m) => after.includes(`id="${m[1]}"`))
        && [...s.matchAll(/\.([\w-]+)/g)].every((m) => new RegExp(`class="[^"]*\\b${m[1]}\\b`).test(after)
          || inJs(m[1]));
    };
    const stackers = [...new Set(all.flatMap((r) => r.parts))]
      .filter((p) => !/\.topbar\b|#scene-overlay\b/.test(p) && laterInDom(p))
      .filter((p) => /^(relative|absolute|sticky|fixed)$/.test(resolved(all, p, "position") ?? "")
        && (resolved(all, p, "isolation") === "isolate" || !/^(auto)?$/.test(resolved(all, p, "z-index") ?? "")));
    if (!stackers.length) return;
    const oz = Number(resolved(all, "#scene-overlay", "z-index"));
    assert.ok(Number.isInteger(oz) && oz >= 10, `#scene-overlay z-index is ${oz}, expected an integer >= 10`);
    assert.match(resolved(all, ".topbar", "position") ?? "", /^(sticky|fixed)$/, ".topbar is no longer sticky");
    const tz = resolved(all, ".topbar", "z-index");
    assert.ok(Number.isInteger(Number(tz)) && Number(tz) >= 1,
      `.topbar z-index is ${tz ?? "auto"}: later stacking contexts (${stackers.join(", ")}) paint over the sticky bar`);
    assert.ok(Number(tz) < oz, `.topbar z-index ${tz} must stay below #scene-overlay ${oz}`);
  });

  test(".panel::before keeps the panel's rounded corners (border-radius inherit or equal), incl. more contrast", () => {
    themeCss();
    const all = sheetRules().filter((r) => r.media.length === 0
      || r.media.some((m) => RESET_MEDIA["prefers-contrast"].test(m)));
    if (!all.some((r) => r.parts.includes(".panel::before"))) return;
    const last = (part) => all.filter((r) => r.parts.includes(part)).map((r) => decl(r, "border-radius"))
      .filter((v) => v !== undefined).pop();
    const panel = last(".panel"), before = last(".panel::before");
    assert.ok(before === "inherit" || (before !== undefined && before === panel),
      `.panel::before border-radius is ${before ?? "unset (square)"} vs .panel ${panel}: its corners poke past the border`);
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

// Covers: MEM-102
// Requirement: MEM-102 Paper Crown theme. Fraunces and Nunito are self-hosted (every @font-face src is a
// /static/fonts/*.woff2 file that exists, with its OFL licence beside it; no remote fonts under font-src 'self');
// the new --on-lamp and --glow tokens are declared in all 3 A1 token contexts and actually read by a rule; gold
// marks only recalled stations (.live-board li.lit background var(--lamp)); said-vs-palace labels carry check /
// cross glyphs; forced-colors, more-contrast and print drop the crown edge and the lantern glow; the topbar
// carries one tagline "Find a home for every memory" right after the brand, coloured var(--muted).
const CHECK_GLYPHS = new Set(["\u2713", "\u2714"]);
const CROSS_GLYPHS = new Set(["\u2715", "\u2716", "\u2717", "\u2718", "\u00d7"]);
const cssContent = (v) => (v ?? "").replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
const fontFaces = () => [...themeCss().matchAll(/@font-face\s*\{([^}]*)\}/gi)].map((m) => m[1]);
const ruleFor = (part, pred) => themeRules().filter((r) => r.parts.includes(part) && pred(r));

describe("MEM-102 Paper Crown theme (static/theme-painterly.css)", () => {
  test("Fraunces and Nunito are self-hosted: every @font-face src is an existing /static/fonts/*.woff2", () => {
    const faces = fontFaces();
    assert.ok(faces.length >= 2, `theme declares ${faces.length} @font-face rules, expected Fraunces and Nunito`);
    const families = faces.map((f) => (f.match(/font-family\s*:\s*([^;]+)/i)?.[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2"));
    for (const fam of ["Fraunces", "Nunito"]) assert.ok(families.includes(fam), `no @font-face for ${fam}: ${families.join(", ")}`);
    for (const f of faces) {
      const src = f.match(/src\s*:\s*([^;]+)/i)?.[1] ?? "";
      const us = urls(src);
      assert.ok(us.length, `@font-face has no src url(): ${norm(f)}`);
      for (const u of us) {
        assert.match(u, /^\/static\/fonts\/[\w.-]+\.woff2$/, `@font-face src url(${u}) is not /static/fonts/*.woff2`);
        assert.ok(existsSync(new URL(`.${u.slice("/static".length)}`, import.meta.url)), `font file ${u} is missing on disk`);
      }
      assert.match(f, /font-display\s*:\s*swap/i, `@font-face lacks font-display: swap: ${norm(f)}`);
    }
  });

  test("each self-hosted font ships its OFL licence text beside it", () => {
    for (const f of ["OFL-fraunces.txt", "OFL-nunito.txt"]) {
      assert.ok(existsSync(new URL(`./fonts/${f}`, import.meta.url)), `static/fonts/${f} is missing`);
    }
  });

  test("--on-lamp and --glow are declared in all 3 A1 token contexts and each is read by a rule", () => {
    const tr = themeRules();
    for (const t of ["--on-lamp", "--glow"]) {
      for (const [label, ctx] of Object.entries(CONTEXTS)) {
        assert.ok(contextDecls(tr, ctx)[t] !== undefined, `${label} (${ctx.sel}) does not declare ${t}`);
      }
      const readers = tr.filter((r) => r.decls.some(([p, v]) => !p.startsWith("--") && usesVar(v, t)));
      assert.ok(readers.length, `no theme rule reads ${t} via var()`);
    }
  });

  test("gold marks recalled stations: .live-board li.lit background is var(--lamp)", () => {
    const lit = ruleFor(".live-board li.lit", (r) => !isReset(r)
      && [decl(r, "background"), decl(r, "background-color")].includes("var(--lamp)"));
    assert.ok(lit.length, ".live-board li.lit has no background / background-color var(--lamp)");
  });

  test("said-vs-palace labels: said-got shows a check glyph, said-missed a cross glyph", () => {
    for (const [part, glyphs, name] of [
      ["li.said-got > .said-label::before", CHECK_GLYPHS, "check"],
      ["li.said-missed > .said-label::before", CROSS_GLYPHS, "cross"],
    ]) {
      const contents = ruleFor(part, (r) => decl(r, "content") !== undefined).map((r) => cssContent(decl(r, "content")));
      assert.ok(contents.length, `${part} sets no content`);
      assert.ok(glyphs.has([...contents.at(-1)][0]), `${part} content "${contents.at(-1)}" does not start with a ${name} glyph`);
    }
  });

  test("forced-colors, more-contrast and print clear the crown edge and the lantern glow", () => {
    const tr = themeRules();
    for (const [name, re] of Object.entries(RESET_MEDIA)) {
      const inMedia = (part) => tr.filter((r) => r.media.some((m) => re.test(m)) && r.parts.includes(part));
      assert.ok(inMedia(".topbar::after").some((r) => [decl(r, "background"), decl(r, "background-image")].includes("none")),
        `${name}: .topbar::after background is not reset to none`);
      assert.ok(inMedia(".live-board li.lit").some((r) => decl(r, "box-shadow") === "none"),
        `${name}: .live-board li.lit box-shadow is not reset to none`);
    }
  });

  // MEM-102 tagline: the topbar reads "Find a home for every memory" right under the brand, in muted theme type.
  test("tagline: header.topbar has exactly one <p class=\"tagline\"> right after the brand h1, exact text", () => {
    const header = HTML.match(/<header\s+class="topbar"[^>]*>([\s\S]*?)<\/header>/i)?.[1];
    assert.ok(header !== undefined, "index.html has no <header class=\"topbar\">");
    const taglines = [...HTML.matchAll(/<p\b[^>]*\bclass="[^"]*\btagline\b[^"]*"[^>]*>/gi)];
    assert.equal(taglines.length, 1, `index.html has ${taglines.length} .tagline elements, expected exactly 1`);
    assert.match(header, /<h1 class="brand">MemriPal<\/h1>\s*<p class="tagline">Find a home for every memory<\/p>/,
      `header.topbar lacks <p class="tagline">Find a home for every memory</p> immediately after the brand h1: ${norm(header)}`);
  });

  test("tagline: theme .tagline rule sets color var(--muted) and font-family (if set) var(--display) or var(--body)", () => {
    const rules = ruleFor(".tagline", (r) => r.media.length === 0 && !isReset(r));
    assert.ok(rules.length, "theme has no unconditional .tagline rule");
    const color = rules.map((r) => decl(r, "color")).filter((v) => v !== undefined).pop();
    assert.equal(color, "var(--muted)", `.tagline color is ${color ?? "unset"}, expected var(--muted)`);
    for (const r of rules) {
      const ff = decl(r, "font-family");
      if (ff !== undefined) assert.ok(["var(--display)", "var(--body)"].includes(ff), `${where(r)} font-family is ${ff}`);
    }
  });
});
