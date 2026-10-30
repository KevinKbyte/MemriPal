// Covers: MEM-044
// Requirement: the live components take the v6 look (MEM-044 A3; F6, F7, F12, F15): each said-vs-palace
// row reads "You said:" before the said text and "In your palace:" before the palace quote, with
// span.said-label/.said-text/.said-quote on their own lines and 0 classes added to the OL/LI; each
// #route li shows its number and keeps its label + controls on one row at 360 px; the #loci numbers match
// the canvas badges, whose fill and text are exported app.js constants at >= 4.5:1; the Show/Hide
// toggles, the history delete status line and the native file input are styled from tokens; the
// lit live-board row takes its colours from tokens; nothing that would trap #scene-overlay or the
// scenes sits on #scene-wrap, #scenes, #walk, #recall, #recall-live or their ancestors.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as app from "./app.js";
import * as reh from "./rehearsals.js";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const HTML = read("./index.html");
const CSS = read("./style.css").replace(/\/\*[\s\S]*?\*\//g, "");

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
const decl = (rule, prop) => rule.decls.filter(([p]) => p === prop).map(([, v]) => v).pop();
const rulesWhere = (re) => RULES.filter((r) => r.parts.some((p) => re.test(p)));
// Cascade (source order, no media) of every top-level rule with a part matching re.
const effective = (re) => Object.fromEntries(TOP.filter((r) => r.parts.some((p) => re.test(p)))
  .flatMap((r) => r.decls));
const usesToken = (rule) => rule.decls.some(([, v]) => /var\(\s*--[\w-]+/.test(v));

const ROUTE_LI = /^#route (> )?li$/;

/** Fake document: elements with children, text nodes, and a log of every HTML-string write. */
function fakeDoc() {
  const htmlWrites = [];
  const created = [];
  const textOf = (n) => n.textContent;
  function el(tag) {
    let own = "";
    const e = {
      tagName: String(tag).toUpperCase(), nodeType: 1, children: [], className: "", attrs: {},
      get textContent() { return own + this.children.map(textOf).join(""); },
      set textContent(v) { own = String(v); this.children = []; },
      append(...c) { this.children.push(...c.map(wrap)); },
      prepend(...c) { this.children.unshift(...c.map(wrap)); },
      appendChild(c) { this.children.push(wrap(c)); return c; },
      replaceChildren(...c) { own = ""; this.children = c.map(wrap); },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      insertAdjacentHTML(pos, html) { htmlWrites.push(String(html)); },
    };
    for (const prop of ["innerHTML", "outerHTML"]) {
      Object.defineProperty(e, prop, { get: () => "", set: (v) => htmlWrites.push(String(v)) });
    }
    created.push(e.tagName);
    return e;
  }
  const text = (t) => ({ nodeType: 3, textContent: String(t), children: [] });
  const wrap = (c) => (typeof c === "string" ? text(c) : c);
  const doc = { createElement: el, createTextNode: text, createDocumentFragment: () => el("#fragment"),
    getElementById: () => null };
  return { doc, htmlWrites, created };
}

const descendants = (n) => (n.children ?? []).flatMap((c) => [c, ...descendants(c)]);
const byClass = (row, cls) => descendants(row).find((n) => n.className === cls);

const run = (points) => ({ id: "r1", palace_id: "p1", timestamp: "2026-10-30T09:00:00.000Z",
  transcript: "", points });
const POINTS = [
  { label: "loci origin", source_quote: "The method of loci dates back 2,500 years.", got: true,
    override: false, span: "it is about 2500 years old" },
  { label: "exam use", source_quote: "Students can use it for exams.", got: false, override: false,
    span: null },
];

// Covers: MEM-044
// Requirement: F6 - a said-vs-palace row says which text is yours and which is the palace's: "You said:"
// comes before the said text and "In your palace:" before the palace quote, each span on its own line,
// so a results row never reads as one run-on string ("...years oldthe method of loci...").
describe("MEM-044 A3 F6 said-vs-palace labels", () => {
  test('each row reads label, "You said:", said text, "In your palace:", quote, in that order', () => {
    const { doc } = fakeDoc();
    const view = reh.renderSaidVsPalace(run(POINTS), doc);
    assert.equal(view.children.length, 2);
    view.children.forEach((row, i) => {
      const said = byClass(row, "said-text");
      const quote = byClass(row, "said-quote");
      assert.ok(said && quote, `row ${i} lost its said-text or said-quote span`);
      const t = row.textContent;
      const at = (s, from = 0) => t.indexOf(s, from);
      const youSaid = at("You said:");
      const inPalace = at("In your palace:");
      assert.ok(youSaid >= 0, `row ${i} has no "You said:" label: ${JSON.stringify(t)}`);
      assert.ok(inPalace >= 0, `row ${i} has no "In your palace:" label: ${JSON.stringify(t)}`);
      assert.equal(t.split("You said:").length, 2, `row ${i} repeats "You said:"`);
      assert.equal(t.split("In your palace:").length, 2, `row ${i} repeats "In your palace:"`);
      const saidText = said.textContent.replace("You said:", "").trim();
      const quoteText = quote.textContent.replace("In your palace:", "").trim();
      assert.ok(youSaid < at(saidText, youSaid), `row ${i}: "You said:" is not before the said text`);
      assert.ok(at(saidText, youSaid) < inPalace, `row ${i}: said text is not before "In your palace:"`);
      assert.ok(inPalace < at(quoteText, inPalace), `row ${i}: "In your palace:" is not before the quote`);
    });
  });

  test("the OL and LI classes are unchanged: said-vs-palace, said-got, said-missed", () => {
    const { doc } = fakeDoc();
    const view = reh.renderSaidVsPalace(run(POINTS), doc);
    assert.equal(view.className, "said-vs-palace");
    assert.deepEqual(view.children.map((r) => r.className), ["said-got", "said-missed"]);
  });

  test("hostile said text and quote stay literal text beside the labels; no HTML is written", () => {
    const { doc, htmlWrites, created } = fakeDoc();
    const evil = '<img src=x onerror="alert(1)">';
    const view = reh.renderSaidVsPalace(run([{ label: `<b>${evil}</b>`, source_quote: `</li>${evil}`,
      got: true, override: false, span: `said ${evil}<script>alert(2)</script>` }]), doc);
    const t = view.children[0].textContent;
    assert.ok(t.includes(`said ${evil}<script>alert(2)</script>`), `hostile said text not literal: ${t}`);
    assert.ok(t.includes(`</li>${evil}`), `hostile quote not literal: ${t}`);
    assert.ok(t.includes("You said:") && t.includes("In your palace:"), `labels missing: ${t}`);
    assert.deepEqual(htmlWrites, []);
    assert.deepEqual(created.filter((tag) => ["IMG", "SCRIPT", "B"].includes(tag)), []);
  });

  for (const cls of ["said-label", "said-text", "said-quote"]) {
    test(`span.${cls} is display: block, so the row never runs its texts together`, () => {
      const re = new RegExp(`(^| |> )(span)?\\.${cls}$`);
      const hits = rulesWhere(re).filter((r) => decl(r, "display") === "block");
      assert.ok(hits.length, `no style.css rule sets .${cls} { display: block }`);
    });
  }
});

// Covers: MEM-044
// Requirement: F12 - every #route li shows its route number (a CSS counter or the list-item marker)
// while #route li > span:first-child stays the place label, and the #loci list numbers its places
// exactly as the canvas badges do.
describe("MEM-044 A3 F12 route and loci numbering", () => {
  test("each #route li shows its number via a counter ::before/::marker or a list-item marker", () => {
    const pseudo = rulesWhere(/^#route (> )?li::(before|marker)$/)
      .filter((r) => /counter\(/.test(decl(r, "content") ?? ""));
    const counters = pseudo.flatMap((r) => [...decl(r, "content").matchAll(/counter\(\s*([\w-]+)/g)])
      .map((m) => m[1]);
    const incremented = (name) => name === "list-item" || TOP.some((r) => r.parts.some((p) =>
      ROUTE_LI.test(p)) && new RegExp(`\\b${name}\\b`).test(decl(r, "counter-increment") ?? ""));
    const viaCounter = counters.length > 0 && counters.every(incremented);
    const li = effective(ROUTE_LI);
    const listStyle = `${li["list-style"] ?? ""} ${li["list-style-type"] ?? ""}`;
    const viaMarker = /list-item/.test(li.display ?? "list-item") && !/\bnone\b/.test(listStyle);
    assert.ok(viaCounter || viaMarker,
      `#route li shows no number: display ${li.display}, list-style "${listStyle.trim()}", ` +
      `counters [${counters.join(", ")}]`);
  });

  test("#route li > span:first-child is still the label rule", () => {
    assert.ok(rulesWhere(/^#route (> )?li > span:first-child$/).length,
      "the #route li > span:first-child rule is gone");
  });

  test("#loci keeps its ordered-list numbering (the canvas badge numbers 1..n)", () => {
    assert.match(HTML, /<ol id="loci">/, "#loci is no longer a plain <ol>");
    // No #loci rule is fine (default <ol> decimal) only if no #loci, ol or li rule hides the markers.
    for (const r of rulesWhere(/#loci|(^|[ >])(ol|li)$/)) {
      const style = `${decl(r, "list-style") ?? ""} ${decl(r, "list-style-type") ?? ""}`;
      assert.doesNotMatch(style, /none/, `${r.parts.join(", ")} hides the #loci numbers`);
    }
    for (const r of rulesWhere(/(^|[ >])#loci( > | )?(li)?$/)) {
      const style = `${decl(r, "list-style") ?? ""} ${decl(r, "list-style-type") ?? ""}`;
      assert.doesNotMatch(style, /\bnone\b/, `${r.parts.join(", ")} hides the #loci numbers`);
      const display = decl(r, "display");
      if (r.parts.some((p) => /li$/.test(p)) && display) {
        assert.match(display, /list-item/, `${r.parts.join(", ")} display ${display} drops the marker`);
      }
    }
  });
});

const hex = (s) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s).trim());
  assert.ok(m, `${s} is not a #rgb/#rrggbb colour`);
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16));
};
const lum = (c) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** Fake upload page whose 2D context records the fillStyle in force at each fillRect / fillText. */
function canvasPage() {
  const fills = [], texts = [];
  const ctx = { fillStyle: "", strokeStyle: "", drawImage() {}, strokeRect() {}, clearRect() {},
    fillRect() { fills.push(this.fillStyle); }, fillText(t) { texts.push([String(t), this.fillStyle]); } };
  const canvas = { width: 0, height: 0, parentElement: { clientWidth: 800 }, getContext: () => ctx };
  const list = { children: [], replaceChildren(...c) { this.children = c; }, append(...c) {
    this.children.push(...c); } };
  const els = { "upload-status": { textContent: "" }, scene: canvas, loci: list };
  const doc = { getElementById: (id) => els[id] ?? null,
    createElement: (tag) => ({ tagName: String(tag).toUpperCase(), textContent: "" }) };
  return { doc, fills, texts, list };
}

// Covers: MEM-044
// Requirement: F15 - the canvas locus badge fill and text colours are exported app.js constants that
// meet WCAG 4.5:1 (today #ff3b30 on #fff is 3.55:1), the badges are drawn with them, and app.js stays
// <= 500 lines.
describe("MEM-044 A3 F15 badge contrast", () => {
  test("app.js exports BADGE_FILL and BADGE_TEXT at >= 4.5:1", () => {
    assert.equal(typeof app.BADGE_FILL, "string", "app.js does not export BADGE_FILL");
    assert.equal(typeof app.BADGE_TEXT, "string", "app.js does not export BADGE_TEXT");
    const r = contrast(app.BADGE_FILL, app.BADGE_TEXT);
    assert.ok(r >= 4.5, `badge ${app.BADGE_TEXT} on ${app.BADGE_FILL} is ${r.toFixed(2)}:1 < 4.5:1`);
  });

  test("each badge is filled with BADGE_FILL, numbered in BADGE_TEXT, in #loci order", async () => {
    const page = canvasPage();
    const loci = ["lamp", "door", "desk"].map((label, i) => ({ n: i + 1, label,
      box: { x1: 10 + i * 60, y1: 10, x2: 50 + i * 60, y2: 50 } }));
    const body = JSON.stringify({ image: "data:image/png;base64,QQ==", width: 800, height: 600, loci });
    const headers = { "content-type": "application/json" };
    const send = async () => new Response(body, { status: 200, headers });
    await app.showUpload(send, "failed", { doc: page.doc, loadImage: async (src) => ({ src }),
      fetch: async () => { throw new Error("fetch not expected"); }, encode: async () => new Uint8Array() });
    assert.deepEqual(page.list.children.map((c) => c.textContent), ["lamp", "door", "desk"]);
    assert.deepEqual(page.texts.map(([t]) => t), ["1", "2", "3"], "badge numbers differ from #loci order");
    const lc = (s) => String(s).toLowerCase();
    assert.deepEqual(page.fills.map(lc), loci.map(() => lc(app.BADGE_FILL)), "badge fill is not BADGE_FILL");
    assert.deepEqual(page.texts.map(([, s]) => lc(s)), loci.map(() => lc(app.BADGE_TEXT)),
      "badge text is not BADGE_TEXT");
  });

  test("app.js is <= 500 lines", () => {
    const lines = read("./app.js").split("\n").length;
    assert.ok(lines <= 500, `app.js has ${lines} lines`);
  });
});

// Covers: MEM-044
// Requirement: F7 and the other live controls take the v6 look from tokens: the association/scene
// Show/Hide toggles, the history "Could not delete" status line, the native file input button, and a
// #route li row that keeps its label and Up/Down/Drop controls together (Drop never wraps alone at
// 360 px); the lit live-board row takes background and color from tokens.
describe("MEM-044 A3 component styling from tokens", () => {
  test("a token rule styles the Show/Hide toggles (button[aria-expanded], #associations > button)", () => {
    const hits = rulesWhere(/button\[aria-expanded|^#(associations|scenes) > button/).filter(usesToken);
    assert.ok(hits.length, "no style.css rule styles the Show/Hide toggles from tokens");
  });

  test('a token-using rule styles the history delete status line (#history > [role="status"])', () => {
    const hits = rulesWhere(/^#history > (p)?(\[role="?status"?\]|$)/).filter((r) =>
      ["color", "background", "background-color", "border", "border-color"].some((p) =>
        /var\(\s*--/.test(decl(r, p) ?? "")));
    assert.ok(hits.length, "no style.css rule styles the #history status line from tokens");
  });

  test("the native file input button has a v6 ::file-selector-button rule using tokens", () => {
    const hits = rulesWhere(/::file-selector-button$/).filter(usesToken);
    assert.ok(hits.length, "no ::file-selector-button rule using var(--...) tokens");
  });

  test("Drop never wraps alone", () => {
    const li = effective(ROUTE_LI);
    const label = effective(/^#route (> )?li > span:first-child$/);
    const display = li.display ?? "";
    const wrap = `${li["flex-wrap"] ?? ""} ${li["flex-flow"] ?? ""}`;
    const grid = /grid/.test(display) && Boolean(li["grid-template-columns"]);
    const shrinks = /^0(px)?$/.test(label["min-width"] ?? "");
    const nowrap = /flex/.test(display) && /\bnowrap\b/.test(wrap) && shrinks;
    const basis = `${label.flex ?? ""} ${label["flex-basis"] ?? ""}`;
    const fullLabel = /flex/.test(display) && /\bwrap\b/.test(wrap) && /\b100%/.test(basis);
    assert.ok(grid || nowrap || fullLabel,
      `#route li { display: ${display}; wrap: ${wrap.trim()} } label { flex: ${basis.trim()}; ` +
      `min-width: ${label["min-width"]} } lets Drop wrap alone`);
  });

  test(".live-board li.lit takes background and color from tokens", () => {
    const lit = effective(/^\.live-board li\.lit$/);
    const bg = lit.background ?? lit["background-color"] ?? "";
    assert.match(bg, /var\(\s*--[\w-]+/, `.live-board li.lit background is "${bg}"`);
    assert.match(lit.color ?? "", /^var\(\s*--[\w-]+\s*\)$/, `.live-board li.lit color is "${lit.color}"`);
  });
});

// index.html elements as { tag, id, classes, parent }.
function parseHtml(src) {
  const VOID = new Set(["img", "input", "link", "meta", "br", "hr", "source", "wbr"]);
  const root = { tag: "#root", id: null, classes: [], parent: null, children: [] };
  const all = [];
  let cur = root;
  const body = src.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype[^>]*>/i, "");
  for (const [, close, raw, rest] of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    const tag = raw.toLowerCase();
    if (close) {
      let n = cur;
      while (n !== root && n.tag !== tag) n = n.parent;
      if (n !== root) cur = n.parent;
      continue;
    }
    const id = /\sid="([^"]*)"/.exec(rest)?.[1] ?? null;
    const classes = (/\sclass="([^"]*)"/.exec(rest)?.[1] ?? "").split(/\s+/).filter(Boolean);
    const el = { tag, id, classes, parent: cur, children: [] };
    cur.children.push(el);
    all.push(el);
    if (!VOID.has(tag)) cur = el;
  }
  return all;
}

const ELS = parseHtml(HTML);
// Whether a compound selector (tag#id.class[...]:...) can match el; attributes and pseudo-classes are
// treated as possibly matching, so the check errs toward flagging.
function compoundMatches(compound, el) {
  const base = compound.replace(/\[[^\]]*\]/g, "").replace(/:(?!:)[\w-]+(\([^)]*\))?/g, "");
  const tag = /^[a-z][\w-]*/i.exec(base)?.[0];
  const id = /#([\w-]+)/.exec(base)?.[1];
  const classes = [...base.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  return (!tag || tag.toLowerCase() === el.tag) && (!id || id === el.id)
    && classes.every((c) => el.classes.includes(c));
}
const lastCompound = (part) => splitTop(part.replace(/\s*[>+~]\s*/g, " "), " ").filter(Boolean).pop() ?? "";

// Covers: MEM-044
// Requirement: the scene and recall surfaces keep their structure and stay free of containing-block
// traps: 0 filter/transform on #scene-wrap, #scenes, #walk, #recall, #recall-live or any ancestor, and
// the association and scene cards stay direct section children of #associations and #scenes.
describe("MEM-044 A3 scene and recall surfaces", () => {
  test("0 filter/transform on #scene-wrap, #scenes, #walk, #recall, #recall-live or ancestors", () => {
    const targets = ["scene-wrap", "scenes", "walk", "recall", "recall-live"].map((id) => {
      const el = ELS.find((e) => e.id === id);
      assert.ok(el, `index.html lost #${id}`);
      return el;
    });
    const guarded = new Set();
    for (let el of targets) for (; el && el.tag !== "#root"; el = el.parent) guarded.add(el);
    for (const r of RULES) {
      const bad = r.decls.filter(([p]) => /^(-webkit-)?(filter|backdrop-filter|transform)$/.test(p));
      if (!bad.length) continue;
      for (const part of r.parts.filter((p) => !p.includes("::"))) {
        const hit = [...guarded].find((el) => compoundMatches(lastCompound(part), el));
        assert.ok(!hit, `${part} sets ${bad.map(([p]) => p).join(", ")} on ${hit?.tag}#${hit?.id ?? ""}`);
      }
    }
  });

  test("#associations and #scenes are empty containers the cards render into directly as <section>", () => {
    for (const id of ["associations", "scenes"]) {
      const el = ELS.find((e) => e.id === id);
      assert.ok(el, `index.html lost #${id}`);
      assert.deepEqual(el.children.map((c) => c.tag), [], `#${id} has markup children in index.html`);
    }
    assert.match(read("./app.js"), /createElement\("section"\)/, "association cards are not <section>");
    assert.match(read("./scenes.js"), /createElement\("section"\)/, "scene cards are no longer <section>");
  });
});
