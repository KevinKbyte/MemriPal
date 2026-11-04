// Covers: MEM-045
// Requirement: static/index.html carries the sticker panel in the Recall tab, right after <ol id="loci"></ol>:
// section#sticker-panel.sticker-panel (hidden) with an h3 "Stickers", select#sticker-locus (label "Spot"),
// input#sticker-file type=file accept="image/jpeg,image/png,image/webp,image/gif" (label "Your picture"),
// input#sticker-desc type=text maxlength=60 (label "What it shows"), button#sticker-add.btn.btn-primary
// "Stick it on", p#sticker-error.notice role=alert hidden, ul#sticker-placed and div#sticker-toast role=status
// hidden holding span#sticker-toast-text and button#sticker-undo "Undo".
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { MEM045_IDS, MEM045_MAY_START_HIDDEN } from "./index_ids_test.mjs";

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8").replace(/<!--[\s\S]*?-->/g, "");
const VOID = new Set(["br", "hr", "img", "input", "link", "meta", "source", "wbr"]);

// Element tree: { tag, attrs, children, parent, text }.
function parseHtml(src) {
  const root = { tag: "#root", attrs: {}, children: [], parent: null, text: "" };
  let cur = root;
  let last = 0;
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    const between = src.slice(last, m.index);
    for (let n = cur; n; n = n.parent) n.text += between;
    last = m.index + m[0].length;
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
    const el = { tag, attrs, children: [], parent: cur, text: "" };
    cur.children.push(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(rest)) cur = el;
  }
  return root;
}

const DOC = parseHtml(HTML);
const all = (n = DOC) => n.children.flatMap((c) => [c, ...all(c)]);
const ELS = all();
const byId = (id) => ELS.find((e) => e.attrs.id === id);
const classes = (el) => (el?.attrs.class ?? "").split(/\s+/).filter(Boolean);
const within = (el, anc) => {
  for (let p = el?.parent; p; p = p.parent) if (p === anc) return true;
  return false;
};
const text = (el) => (el?.text ?? "").replace(/\s+/g, " ").trim();
const labelFor = (id) => ELS.find((e) => e.tag === "label" && e.attrs.for === id);

// Covers: MEM-045
// Requirement: the sticker panel markup (see the file header).
describe("index.html sticker panel markup (MEM-045)", () => {
  test("section#sticker-panel.sticker-panel starts hidden inside #tab-recall", () => {
    const panel = byId("sticker-panel");
    assert.ok(panel, "#sticker-panel exists");
    assert.equal(panel.tag, "section");
    assert.ok(classes(panel).includes("sticker-panel"));
    assert.ok("hidden" in panel.attrs, "#sticker-panel starts hidden");
    assert.ok(within(panel, byId("tab-recall")), "#sticker-panel sits in the Recall tab");
  });

  test("#sticker-panel comes right after <ol id=\"loci\"></ol>", () => {
    assert.match(HTML, /<ol id="loci"><\/ol>\s*<section id="sticker-panel"/);
  });

  test("every MEM-045 id is present once and inside #sticker-panel", () => {
    const panel = byId("sticker-panel");
    for (const id of MEM045_IDS) {
      assert.equal(ELS.filter((e) => e.attrs.id === id).length, 1, `#${id} exactly once`);
      if (id !== "sticker-panel") assert.ok(within(byId(id), panel), `#${id} inside #sticker-panel`);
    }
  });

  test("h3 'Stickers' in the panel", () => {
    const h3 = all(byId("sticker-panel") ?? { children: [] }).find((e) => e.tag === "h3");
    assert.equal(text(h3), "Stickers");
  });

  test("select#sticker-locus labelled 'Spot'", () => {
    assert.equal(byId("sticker-locus")?.tag, "select");
    assert.equal(text(labelFor("sticker-locus")), "Spot");
  });

  test("input#sticker-file is a file input accepting exactly jpeg, png, webp, gif; labelled 'Your picture'", () => {
    const f = byId("sticker-file");
    assert.equal(f?.tag, "input");
    assert.equal(f.attrs.type, "file");
    assert.equal(f.attrs.accept, "image/jpeg,image/png,image/webp,image/gif");
    assert.equal(text(labelFor("sticker-file")), "Your picture");
  });

  test("input#sticker-desc is a text input with maxlength 60; labelled 'What it shows'", () => {
    const d = byId("sticker-desc");
    assert.equal(d?.tag, "input");
    assert.equal(d.attrs.type, "text");
    assert.equal(d.attrs.maxlength, "60");
    assert.equal(text(labelFor("sticker-desc")), "What it shows");
  });

  test("button#sticker-add.btn.btn-primary 'Stick it on'", () => {
    const b = byId("sticker-add");
    assert.equal(b?.tag, "button");
    assert.ok(classes(b).includes("btn") && classes(b).includes("btn-primary"), classes(b).join(" "));
    assert.equal(text(b), "Stick it on");
  });

  test("p#sticker-error.notice role=alert starts hidden", () => {
    const e = byId("sticker-error");
    assert.equal(e?.tag, "p");
    assert.ok(classes(e).includes("notice"));
    assert.equal(e.attrs.role, "alert");
    assert.ok("hidden" in e.attrs);
  });

  test("ul#sticker-placed", () => {
    assert.equal(byId("sticker-placed")?.tag, "ul");
  });

  test("div#sticker-toast role=status starts hidden, holds span#sticker-toast-text and button#sticker-undo 'Undo'", () => {
    const t = byId("sticker-toast");
    assert.equal(t?.tag, "div");
    assert.equal(t.attrs.role, "status");
    assert.ok("hidden" in t.attrs);
    assert.equal(byId("sticker-toast-text")?.tag, "span");
    assert.ok(within(byId("sticker-toast-text"), t));
    const u = byId("sticker-undo");
    assert.equal(u?.tag, "button");
    assert.ok(within(u, t));
    assert.equal(text(u), "Undo");
  });

  test("only #sticker-panel, #sticker-error and #sticker-toast start hidden", () => {
    const hidden = MEM045_IDS.filter((id) => byId(id) && "hidden" in byId(id).attrs);
    assert.deepEqual(hidden.sort(), [...MEM045_MAY_START_HIDDEN].sort());
  });
});
