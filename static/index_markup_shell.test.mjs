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

// Covers: MEM-088
// Requirement: the route builder markup exists where the page script expects it (MEM-088). #route-new (start
// hidden) sits inside #drawer .drawer-body and holds the Start / End text inputs (#route-from, #route-to), each
// with a <label for> in a .field, the Find and Cancel buttons, a role=alert #route-new-error and the result
// block (#route-distance, #route-new-stations, a 40-character #route-new-name, #route-new-save). #map-empty
// (the empty-map message) sits inside .map-wrap and starts visible.
describe("route builder markup (MEM-088)", () => {
  const drawerBody = () => kids(byId("drawer")).find((e) => classes(e).includes("drawer-body"));
  const within = (el, ancestor) => {
    for (let p = el?.parent; p; p = p.parent) if (p === ancestor) return true;
    return false;
  };
  const fieldOf = (el) => {
    for (let p = el?.parent; p; p = p.parent) if (classes(p).includes("field")) return p;
    return null;
  };

  test("#route-new is inside #drawer .drawer-body and starts hidden", () => {
    const form = byId("route-new");
    assert.ok(form, "#route-new exists");
    assert.ok(within(form, drawerBody()), "#route-new inside #drawer .drawer-body");
    assert.equal(form.attrs.hidden, "", "#route-new starts hidden");
  });

  test("#route-from, #route-to and #route-new-name are text inputs with a <label for> in the same .field", () => {
    for (const id of ["route-from", "route-to", "route-new-name"]) {
      const input = byId(id);
      assert.equal(input?.tag, "input", `#${id} is an <input>`);
      assert.equal((input.attrs.type ?? "text").toLowerCase(), "text", `#${id} is a text input`);
      assert.ok(within(input, byId("route-new")), `#${id} inside #route-new`);
      const label = ELS.find((e) => e.tag === "label" && e.attrs.for === id);
      assert.ok(label, `#${id} has a <label for="${id}">`);
      assert.ok(fieldOf(input), `#${id} is inside a .field`);
      assert.equal(fieldOf(label), fieldOf(input), `the #${id} label shares its .field`);
    }
  });

  test("#route-find, #route-new-cancel and #route-new-save are buttons inside #route-new", () => {
    for (const id of ["route-find", "route-new-cancel", "route-new-save"]) {
      const b = byId(id);
      assert.equal(b?.tag, "button", `#${id} is a <button>`);
      assert.ok(within(b, byId("route-new")), `#${id} inside #route-new`);
    }
  });

  test("#route-new-name limits the route name to 40 characters", () => {
    assert.equal(byId("route-new-name")?.attrs.maxlength, "40");
  });

  test("#route-new-error is role=alert and starts hidden", () => {
    const err = byId("route-new-error");
    assert.ok(err, "#route-new-error exists");
    assert.equal(err.attrs.role, "alert");
    assert.equal(err.attrs.hidden, "", "#route-new-error starts hidden");
  });

  test("#route-new-result starts hidden and holds the distance, station list, name and Save", () => {
    const result = byId("route-new-result");
    assert.ok(result, "#route-new-result exists");
    assert.equal(result.attrs.hidden, "", "#route-new-result starts hidden");
    for (const id of ["route-distance", "route-new-stations", "route-new-name", "route-new-save"]) {
      assert.ok(within(byId(id), result), `#${id} inside #route-new-result`);
    }
  });

  test("#map-empty is inside .map-wrap and not hidden at load", () => {
    const empty = byId("map-empty");
    assert.ok(empty, "#map-empty exists");
    const wrap = kids(byId("tab-routes")).find((e) => classes(e).includes("map-wrap"));
    assert.ok(within(empty, wrap), `#map-empty inside .map-wrap, parent is ${desc(empty.parent)}`);
    assert.equal(empty.attrs.hidden, undefined, "#map-empty visible at load");
    });
});

// Covers: MEM-095, MEM-112
// Requirement: index.html links tour.css and carries Pal's tour: div#tour (role=dialog, aria-modal=true,
// aria-labelledby=tour-title, hidden at load) holding .tour-spot and .tour-card with #tour-n, #tour-total,
// ol.tour-dots, #tour-skip, h2#tour-title, #tour-body, div#tour-house (hidden; step 3's dog-house figure),
// ol#tour-fig (hidden), #tour-after (hidden), #tour-back and
// #tour-next; p#tour-toast (role=status, hidden) outside #tour; and a "Replay Pal's tour" button#tour-replay
// inside #tab-settings.
describe("Pal's tour markup (MEM-095, MEM-112)", () => {
  test("head links /static/tour.css as a stylesheet", () => {
    const link = ELS.find((e) => e.tag === "link" && e.attrs.rel === "stylesheet" && /tour\.css$/.test(e.attrs.href ?? ""));
    assert.ok(link, "no <link rel=stylesheet href=.../tour.css>");
    assert.equal(link.attrs.href, "/static/tour.css");
  });

  test("#tour is a hidden modal dialog labelled by #tour-title", () => {
    const tour = byId("tour");
    assert.ok(tour, "#tour exists");
    assert.equal(tour.attrs.role, "dialog");
    assert.equal(tour.attrs["aria-modal"], "true");
    assert.equal(tour.attrs["aria-labelledby"], "tour-title");
    assert.equal(tour.attrs.hidden, "", "#tour hidden at load (tour.js opens it)");
  });

  test("#tour holds .tour-spot, .tour-card, ol.tour-dots and every tour control id", () => {
    for (const cls of ["tour-spot", "tour-card", "tour-dots"]) {
      assert.ok(ELS.some((e) => classes(e).includes(cls) && inside(e, "tour")), `.${cls} inside #tour`);
    }
    for (const id of ["tour-n", "tour-total", "tour-skip", "tour-title", "tour-body", "tour-house", "tour-fig",
      "tour-after", "tour-back", "tour-next"]) {
      assert.ok(inside(byId(id), "tour"), `#${id} inside #tour`);
    }
    assert.equal(byId("tour-title").tag, "h2");
    assert.equal(byId("tour-fig").tag, "ol");
    for (const id of ["tour-house", "tour-fig", "tour-after"]) {
      assert.equal(byId(id).attrs.hidden, "", `#${id} hidden at load`);
    }
  });

  test("#tour-toast is a hidden role=status with the skip text, outside #tour", () => {
    const toast = byId("tour-toast");
    assert.ok(toast, "#tour-toast exists");
    assert.equal(toast.attrs.role, "status");
    assert.equal(toast.attrs.hidden, "");
    assert.equal(inside(toast, "tour"), false);
    assert.equal(norm(text(toast)), "Tour skipped. Replay it any time in Settings.");
  });

  test("#tour-replay is a 'Replay Pal's tour' button inside #tab-settings", () => {
    const btn = byId("tour-replay");
    assert.equal(btn?.tag, "button");
    assert.ok(inside(btn, "tab-settings"), "#tour-replay inside #tab-settings");
    assert.equal(norm(text(btn)), "Replay Pal's tour");
  });
});

// Covers: MEM-117
// Requirement: Pal's dog-house step has a "Roll all" button#tour-roll (type=button) inside the tour card's
// .tour-actions row, hidden at load; tour.js shows it only on the house step.
describe("Pal's tour Roll all markup (MEM-117)", () => {
  test("#tour-roll is a hidden 'Roll all' button inside .tour-card > .tour-actions", () => {
    const btn = byId("tour-roll");
    assert.equal(btn?.tag, "button", "no button#tour-roll");
    assert.equal(btn.attrs.type, "button");
    assert.equal(btn.attrs.hidden, "", "#tour-roll hidden at load");
    assert.equal(norm(text(btn)), "Roll all");
    assert.ok(classes(btn.parent).includes("tour-actions"), `#tour-roll parent is ${desc(btn.parent)}`);
    assert.ok(inside(btn, "tour"), "#tour-roll inside #tour");
    let p = btn.parent;
    while (p && !classes(p).includes("tour-card")) p = p.parent;
    assert.ok(p, "#tour-roll inside .tour-card");
  });
});
