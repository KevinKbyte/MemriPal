// Covers: MEM-127
// Requirement: the Landmarks tab carries the gallery markup (MEM-127, ADR 0081): inside #tab-landmarks a labelled
// input#landmarks-search (type=search), a labelled input#landmarks-route-input wired to datalist#landmarks-route-options
// (list=), ul#landmarks-route-chips, two radios name="landmarks-show" (#landmarks-show-on-routes value on-routes,
// checked; #landmarks-show-candidates value candidates), p#landmarks-count role=status, ul#landmarks-grid and
// p#landmarks-empty.lg-empty; ol#landmarks-list stays in the tab but hidden; index.html links
// /static/landmark_gallery.css.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source",
  "track", "wbr"]);

// Element tree of index.html: { tag, attrs, children, parent } (text nodes as { tag: "#text", text }).
function parseHtml(src) {
  const root = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root, last = 0;
  const body = src.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype[^>]*>/i, "");
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    const text = body.slice(last, m.index);
    if (text.trim()) cur.children.push({ tag: "#text", text, attrs: {}, children: [], parent: cur });
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
    const el = { tag, attrs, children: [], parent: cur };
    cur.children.push(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(rest)) cur = el;
  }
  return root;
}

const DOC = parseHtml(HTML);
const kids = (el) => (el ? el.children.filter((c) => c.tag !== "#text") : []);
const all = (n = DOC) => kids(n).flatMap((c) => [c, ...all(c)]);
const ELS = all();
const byId = (id) => ELS.find((e) => e.attrs.id === id);
const classes = (el) => (el?.attrs.class ?? "").split(/\s+/).filter(Boolean);
const inside = (el, ancestorId) => {
  for (let p = el?.parent; p; p = p.parent) if (p.attrs?.id === ancestorId) return true;
  return false;
};
const inTab = (id) => {
  const el = byId(id);
  assert.ok(el, `#${id} exists`);
  assert.ok(inside(el, "tab-landmarks"), `#${id} inside #tab-landmarks`);
  return el;
};

// Covers: MEM-127
describe("Landmarks gallery markup (static/index.html #tab-landmarks)", () => {
  test("index.html links /static/landmark_gallery.css as a stylesheet", () => {
    const link = ELS.find((e) => e.tag === "link" && e.attrs.rel === "stylesheet"
      && /(^|\/)landmark_gallery\.css$/.test(e.attrs.href ?? ""));
    assert.ok(link, "no <link rel=stylesheet href=.../landmark_gallery.css>");
  });

  test("#landmarks-search is a labelled type=search input", () => {
    const el = inTab("landmarks-search");
    assert.equal(el.tag, "input");
    assert.equal(el.attrs.type, "search");
    assert.ok(ELS.some((e) => e.tag === "label" && e.attrs.for === "landmarks-search"), "label for=landmarks-search");
  });

  test("#landmarks-route-input is a labelled input with list=landmarks-route-options, a datalist", () => {
    const el = inTab("landmarks-route-input");
    assert.equal(el.tag, "input");
    assert.equal(el.attrs.list, "landmarks-route-options");
    assert.ok(ELS.some((e) => e.tag === "label" && e.attrs.for === "landmarks-route-input"),
      "label for=landmarks-route-input");
    assert.equal(inTab("landmarks-route-options").tag, "datalist");
  });

  test("#landmarks-route-chips is a ul", () => {
    assert.equal(inTab("landmarks-route-chips").tag, "ul");
  });

  test("radios name=landmarks-show: on-routes (checked) and candidates (unchecked)", () => {
    const on = inTab("landmarks-show-on-routes");
    const cand = inTab("landmarks-show-candidates");
    for (const [el, value] of [[on, "on-routes"], [cand, "candidates"]]) {
      assert.equal(el.tag, "input");
      assert.equal(el.attrs.type, "radio");
      assert.equal(el.attrs.name, "landmarks-show");
      assert.equal(el.attrs.value, value);
    }
    assert.equal(on.attrs.checked, "", "On routes is the default");
    assert.equal(cand.attrs.checked, undefined, "Candidates starts unchecked");
  });

  test("p#landmarks-count role=status, ul#landmarks-grid, p#landmarks-empty.lg-empty", () => {
    const countEl = inTab("landmarks-count");
    assert.equal(countEl.tag, "p");
    assert.equal(countEl.attrs.role, "status");
    assert.equal(inTab("landmarks-grid").tag, "ul");
    const emptyEl = inTab("landmarks-empty");
    assert.equal(emptyEl.tag, "p");
    assert.ok(classes(emptyEl).includes("lg-empty"), "#landmarks-empty has class lg-empty");
  });

  test("ol#landmarks-list stays inside #tab-landmarks and carries hidden", () => {
    const list = inTab("landmarks-list");
    assert.equal(list.tag, "ol");
    assert.equal(list.attrs.hidden, "", "#landmarks-list is hidden (the gallery replaces it on screen)");
  });
});
