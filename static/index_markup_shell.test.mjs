// Covers: MEM-072
// Requirement: static/index.html is a map-first shell (MEM-072, ADR 0038): main holds exactly four .tab-panel
// sections in order (#tab-routes visible; #tab-landmarks, #tab-recall, #tab-settings hidden) plus
// #scene-overlay as a direct child; #tab-routes is the full-screen map (.map-wrap > svg#route-map), the live
// #map-chip and the #drawer (summary.drawer-handle "Route settings"/"Close" + .drawer-body holding the routes
// home, route view, capture and station card); Landmarks is an h2 + ol#landmarks-list; Recall holds the walk,
// recall, history and legacy room-photo panels; Settings holds the live, place and backup settings. After main,
// nav.tabbar[aria-label=Main] lists four a.tab links (Routes/Landmarks/Recall/Settings, aria-hidden svg icons),
// only Routes carrying aria-current="page" at load. No inline style= attributes anywhere.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source",
  "track", "wbr"]);

// Element tree of index.html with text nodes: { tag, attrs, children, parent } / { tag: "#text", text }.
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
const text = (el) => (el ? el.children.map((c) => (c.tag === "#text" ? c.text : text(c))).join(" ") : "");
const norm = (s) => s.replace(/\s+/g, " ").trim();
const inside = (el, ancestorId) => {
  for (let p = el?.parent; p; p = p.parent) if (p.attrs?.id === ancestorId) return true;
  return false;
};
const desc = (el) => (el ? `<${el.tag}${el.attrs.id ? `#${el.attrs.id}` : ""}${classes(el).map((c) => `.${c}`).join("")}>`
  : "none");
const MAIN = ELS.find((e) => e.tag === "main");

describe("map-first shell: main holds four tab panels and the scene overlay", () => {
  test("main's element children are #tab-routes, #tab-landmarks, #tab-recall, #tab-settings, #scene-overlay", () => {
    assert.ok(MAIN, "index.html has a <main>");
    assert.deepEqual(kids(MAIN).map(desc), [
      "<section#tab-routes.tab-panel>", "<section#tab-landmarks.tab-panel>", "<section#tab-recall.tab-panel>",
      "<section#tab-settings.tab-panel>", "<div#scene-overlay>",
    ]);
  });

  test("only #tab-routes (the map home) starts visible; the other three panels carry hidden", () => {
    assert.equal(byId("tab-routes")?.attrs.hidden, undefined, "#tab-routes visible at load");
    for (const id of ["tab-landmarks", "tab-recall", "tab-settings"]) {
      assert.equal(byId(id)?.attrs.hidden, "", `#${id} starts hidden`);
    }
  });
});

describe("map-first shell: #tab-routes is the map, chip and route drawer", () => {
  test("#tab-routes children in order: div.map-wrap, p#map-chip.map-chip, details#drawer.drawer", () => {
    assert.deepEqual(kids(byId("tab-routes")).map(desc),
      ["<div.map-wrap>", "<p#map-chip.map-chip>", "<details#drawer.drawer>"]);
  });

  test("svg#route-map sits inside .map-wrap", () => {
    const map = byId("route-map");
    assert.equal(map?.tag, "svg", "#route-map is an <svg>");
    assert.ok(classes(map.parent).includes("map-wrap"), `#route-map parent is .map-wrap, got ${desc(map.parent)}`);
  });

  test("#map-chip announces politely (aria-live=polite)", () => {
    assert.equal(byId("map-chip")?.attrs["aria-live"], "polite");
  });

  test("#drawer = summary.drawer-handle (when-closed 'Route settings', when-open 'Close') + div.drawer-body", () => {
    const [handle, bodyEl, ...extra] = kids(byId("drawer"));
    assert.equal(desc(handle), "<summary.drawer-handle>");
    assert.equal(desc(bodyEl), "<div.drawer-body>");
    assert.deepEqual(extra.map(desc), [], "#drawer has only the handle and the body");
    const spans = kids(handle).filter((e) => e.tag === "span");
    const closed = spans.find((s) => classes(s).includes("when-closed"));
    const open = spans.find((s) => classes(s).includes("when-open"));
    assert.equal(norm(text(closed)), "Route settings");
    assert.equal(norm(text(open)), "Close");
  });

  test(".drawer-body holds the routes home, route view, capture and station card screens", () => {
    for (const id of ["public-banner", "status", "route-view", "routes-home", "capture-session", "station-card"]) {
      const el = byId(id);
      assert.ok(el, `#${id} exists`);
      const body = kids(byId("drawer")).find((e) => classes(e).includes("drawer-body"));
      let p = el.parent;
      while (p && p !== body) p = p.parent;
      assert.ok(p, `#${id} inside #drawer .drawer-body`);
    }
  });

  test("#routes-home holds #routes-list, #routes-new ('Map a new route') and #load-demo", () => {
    for (const id of ["routes-list", "routes-new", "load-demo"]) {
      assert.ok(inside(byId(id), "routes-home"), `#${id} inside #routes-home`);
    }
    assert.equal(norm(text(byId("routes-new"))), "Map a new route");
  });
});

describe("map-first shell: Landmarks, Recall and Settings panels", () => {
  test("#tab-landmarks = h2 'Landmarks' + ol#landmarks-list", () => {
    const panel = byId("tab-landmarks");
    const h2 = kids(panel).find((e) => e.tag === "h2");
    assert.equal(norm(text(h2)), "Landmarks");
    const list = byId("landmarks-list");
    assert.equal(list?.tag, "ol", "#landmarks-list is an <ol>");
    assert.ok(inside(list, "tab-landmarks"), "#landmarks-list inside #tab-landmarks");
  });

  test("#tab-recall holds walk, recall, history, the legacy room-photo panel, route review and scenes", () => {
    for (const id of ["walk", "recall", "history", "upload-status", "empty-state", "scene-wrap", "loci",
      "assoc-status", "associations", "route-review", "scenes"]) {
      assert.ok(inside(byId(id), "tab-recall"), `#${id} inside #tab-recall`);
    }
  });

  test("#tab-settings holds #routes-settings, #place-settings and #backup", () => {
    for (const id of ["routes-settings", "place-settings", "backup"]) {
      assert.ok(inside(byId(id), "tab-settings"), `#${id} inside #tab-settings`);
    }
  });
});

describe("map-first shell: nav.tabbar after main", () => {
  const TABS = [["#routes", "Routes"], ["#landmarks", "Landmarks"], ["#recall", "Recall"], ["#settings", "Settings"]];
  const nav = () => {
    const sibs = MAIN ? kids(MAIN.parent) : [];
    return sibs.slice(sibs.indexOf(MAIN) + 1).find((e) => e.tag === "nav" && classes(e).includes("tabbar"));
  };

  test("a nav.tabbar[aria-label=Main] follows main as a sibling", () => {
    assert.ok(nav(), "nav.tabbar after <main>");
    assert.equal(nav().attrs["aria-label"], "Main");
  });

  test("nav > ul > li > a.tab x4: hrefs #routes/#landmarks/#recall/#settings, labels Routes/Landmarks/Recall/Settings", () => {
    const ul = kids(nav()).find((e) => e.tag === "ul");
    assert.ok(ul, "nav.tabbar > ul");
    const lis = kids(ul);
    assert.deepEqual(lis.map((e) => e.tag), ["li", "li", "li", "li"]);
    const links = lis.map((li) => kids(li).find((e) => e.tag === "a"));
    assert.deepEqual(links.map((a) => [a?.attrs.href, norm(text(a))]), TABS);
    for (const a of links) assert.ok(classes(a).includes("tab"), `${desc(a)} carries .tab`);
  });

  test("each tab icon is an svg with aria-hidden=true", () => {
    const links = all(nav() ?? { children: [] }).filter((e) => e.tag === "a");
    assert.equal(links.length, 4);
    for (const a of links) {
      const svg = all(a).find((e) => e.tag === "svg");
      assert.ok(svg, `${a.attrs.href} has an svg icon`);
      assert.equal(svg.attrs["aria-hidden"], "true", `${a.attrs.href} icon aria-hidden`);
    }
  });

  test("only the Routes tab carries aria-current=page at load", () => {
    const links = all(nav() ?? { children: [] }).filter((e) => e.tag === "a");
    assert.deepEqual(links.map((a) => [a.attrs.href, a.attrs["aria-current"] ?? null]),
      [["#routes", "page"], ["#landmarks", null], ["#recall", null], ["#settings", null]]);
  });
});

describe("map-first shell: no inline styles", () => {
  test("no element in index.html carries a style= attribute", () => {
    const styled = ELS.filter((e) => "style" in e.attrs).map(desc);
    assert.deepEqual(styled, [], `inline style= on: ${styled.join(" ")}`);
  });
});
