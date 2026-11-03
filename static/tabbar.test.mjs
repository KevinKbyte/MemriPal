// Covers: MEM-072
// Requirement: the map-first shell's bottom tab bar (static/tabbar.js) switches the four home panels.
// showTab(name, doc) puts aria-current="page" on the matching a.tab only, un-hides #tab-<name> and hides
// the other three panels; an unknown name changes nothing. initTabbar(doc) wires each tab: a click (also on
// its icon) shows that tab and calls preventDefault; it honours the initial location hash (#recall opens
// Recall) and later hashchange events; with no or an unknown hash it shows Routes. app.js calls initTabbar.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mod = await import("./tabbar.js").catch((err) => ({ __missing: String(err) }));
const NAMES = ["routes", "landmarks", "recall", "settings"];

function need(name) {
  assert.equal(typeof mod[name], "function", `static/tabbar.js must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

/** Minimal element: attributes, [hidden], classes, listeners, parent chain, closest(). */
function node(tag, { id, cls = [], attrs = {}, hidden = false } = {}) {
  const listeners = {};
  const e = {
    tagName: tag.toUpperCase(), id: id ?? "", attrs: { ...attrs }, hidden, parent: null, children: [],
    classList: { contains: (c) => cls.includes(c) },
    className: cls.join(" "),
    getAttribute: (k) => (k in e.attrs ? e.attrs[k] : null),
    setAttribute: (k, v) => { e.attrs[k] = String(v); if (k === "hidden") e.hidden = true; },
    removeAttribute: (k) => { delete e.attrs[k]; if (k === "hidden") e.hidden = false; },
    hasAttribute: (k) => k in e.attrs,
    toggleAttribute: (k, force) => {
      const on = force === undefined ? !(k in e.attrs) : Boolean(force);
      if (on) e.setAttribute(k, ""); else e.removeAttribute(k);
      return on;
    },
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
    _listeners: listeners,
    matches: (sel) => matches(e, sel),
    closest: (sel) => { for (let n = e; n; n = n.parent) if (matches(n, sel)) return n; return null; },
    append: (...kids) => kids.forEach((k) => { k.parent = e; e.children.push(k); }),
  };
  return e;
}

// One compound per comma part (descendant combinators: last compound only): tag, .class, #id, [attr], [attr="v"].
function matches(el, sel) {
  return sel.split(",").some((part) => {
    const c = part.trim().split(/\s+|>/).filter(Boolean).pop() ?? "";
    const tag = c.match(/^[a-z][\w-]*/i)?.[0];
    if (tag && tag.toUpperCase() !== el.tagName) return false;
    for (const [, k] of c.replace(/\[[^\]]*\]/g, "").matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(k)) return false;
    for (const [, k] of c.replace(/\[[^\]]*\]/g, "").matchAll(/#([\w-]+)/g)) if (el.id !== k) return false;
    for (const [, k, v] of c.matchAll(/\[\s*([\w-]+)\s*(?:=\s*["']?([^"'\]]*)["']?)?\s*\]/g)) {
      if (!(k in el.attrs)) return false;
      if (v !== undefined && el.attrs[k] !== v) return false;
    }
    return true;
  });
}

/** The shell as index.html ships it: 4 panels (Routes visible), nav.tabbar with 4 a.tab (Routes current). */
function shell(hash = "") {
  const panels = NAMES.map((n, i) => node("section", { id: `tab-${n}`, cls: ["tab-panel"], hidden: i > 0, attrs: i > 0 ? { hidden: "" } : {} }));
  const nav = node("nav", { cls: ["tabbar"], attrs: { "aria-label": "Main" } });
  const ul = node("ul");
  nav.append(ul);
  const tabs = NAMES.map((n, i) => {
    const li = node("li");
    const a = node("a", { cls: ["tab"], attrs: { href: `#${n}`, ...(i === 0 ? { "aria-current": "page" } : {}) } });
    const icon = node("svg", { attrs: { "aria-hidden": "true" } });
    a.append(icon);
    li.append(a);
    ul.append(li);
    return a;
  });
  const all = [...panels, nav, ul, ...tabs, ...tabs.map((a) => a.parent), ...tabs.map((a) => a.children[0])];
  const winListeners = {};
  const docListeners = {};
  const win = {
    location: { hash },
    addEventListener: (type, fn) => (winListeners[type] ??= []).push(fn),
    removeEventListener() {},
  };
  const doc = {
    location: win.location,
    defaultView: win,
    getElementById: (id) => all.find((e) => e.id === id) ?? null,
    querySelectorAll: (sel) => all.filter((e) => matches(e, sel)),
    querySelector: (sel) => all.find((e) => matches(e, sel)) ?? null,
    addEventListener: (type, fn) => (docListeners[type] ??= []).push(fn),
    removeEventListener() {},
  };
  /** Click target (a tab or its icon); bubbles to doc. Returns the event. */
  const click = (target) => {
    const ev = { type: "click", target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    for (let n = target; n; n = n.parent) for (const fn of [...(n._listeners.click ?? [])]) fn.call(n, { ...ev, currentTarget: n, preventDefault: () => (ev.defaultPrevented = true) });
    for (const fn of [...(docListeners.click ?? [])]) fn.call(doc, { ...ev, currentTarget: doc, preventDefault: () => (ev.defaultPrevented = true) });
    return ev;
  };
  /** Change the hash and fire hashchange on window (and doc, for a doc-level listener). */
  const hashTo = (h) => {
    win.location.hash = h;
    for (const fn of [...(winListeners.hashchange ?? []), ...(docListeners.hashchange ?? [])]) fn({ type: "hashchange" });
  };
  const tab = (n) => tabs[NAMES.indexOf(n)];
  const panel = (n) => panels[NAMES.indexOf(n)];
  return { doc, tabs, panels, tab, panel, click, hashTo };
}

/** Exactly `name` is current and visible; the other three tabs have no aria-current and their panels are hidden. */
function assertShown(s, name) {
  for (const n of NAMES) {
    const want = n === name;
    assert.equal(s.tab(n).getAttribute("aria-current"), want ? "page" : null, `a.tab #${n} aria-current`);
    assert.equal(s.panel(n).hidden, !want, `#tab-${n} hidden`);
  }
}

// Covers: MEM-072
// Requirement: showTab(name, doc) shows one panel and marks one tab current; unknown names are a no-op.
describe("tabbar.js showTab (MEM-072)", () => {
  for (const name of NAMES) {
    test(`showTab("${name}") sets aria-current on its tab only and shows only #tab-${name}`, () => {
      const showTab = need("showTab");
      const s = shell();
      showTab(name, s.doc);
      assertShown(s, name);
    });
  }

  test("switching away and back to routes restores Routes as the only current tab", () => {
    const showTab = need("showTab");
    const s = shell();
    showTab("settings", s.doc);
    showTab("routes", s.doc);
    assertShown(s, "routes");
  });

  for (const bad of ["maps", "", "Routes", "tab-routes", undefined]) {
    test(`unknown name ${JSON.stringify(bad)} is a no-op (state after showTab("recall") kept)`, () => {
      const showTab = need("showTab");
      const s = shell();
      showTab("recall", s.doc);
      showTab(bad, s.doc);
      assertShown(s, "recall");
    });
  }
});

// Covers: MEM-072
// Requirement: initTabbar(doc) wires tab clicks, the initial hash and hashchange; default tab is Routes.
describe("tabbar.js initTabbar (MEM-072)", () => {
  test("no hash: Routes is shown and current", () => {
    const s = shell("");
    need("initTabbar")(s.doc);
    assertShown(s, "routes");
  });

  test("an unknown initial hash falls back to Routes", () => {
    const s = shell("#nope");
    need("initTabbar")(s.doc);
    assertShown(s, "routes");
  });

  for (const name of ["landmarks", "recall", "settings"]) {
    test(`initial hash #${name} opens that tab`, () => {
      const s = shell(`#${name}`);
      need("initTabbar")(s.doc);
      assertShown(s, name);
    });
  }

  for (const name of NAMES) {
    test(`clicking a.tab ${name} shows it and calls preventDefault`, () => {
      const s = shell();
      need("initTabbar")(s.doc);
      if (name === "routes") s.click(s.tab("settings"));
      const ev = s.click(s.tab(name));
      assertShown(s, name);
      assert.equal(ev.defaultPrevented, true, "tab click default prevented");
    });
  }

  test("clicking a tab's svg icon switches like clicking the tab", () => {
    const s = shell();
    need("initTabbar")(s.doc);
    s.click(s.tab("landmarks").children[0]);
    assertShown(s, "landmarks");
  });

  test("hashchange to #settings then #routes follows the hash", () => {
    const s = shell();
    need("initTabbar")(s.doc);
    s.hashTo("#settings");
    assertShown(s, "settings");
    s.hashTo("#routes");
    assertShown(s, "routes");
  });

  test("hashchange to an unknown hash keeps the current tab", () => {
    const s = shell();
    need("initTabbar")(s.doc);
    s.hashTo("#recall");
    s.hashTo("#bogus");
    assertShown(s, "recall");
  });
});

// Covers: MEM-072
// Requirement: the page boots the tab bar: app.js imports initTabbar from ./tabbar.js and calls it.
describe("app.js boots the tab bar (MEM-072)", () => {
  test("app.js imports initTabbar from ./tabbar.js and calls initTabbar(document)", () => {
    const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
    assert.match(src, /import\s*\{[^}]*\binitTabbar\b[^}]*\}\s*from\s*["']\.\/tabbar\.js["']/, "no initTabbar import from ./tabbar.js");
    assert.match(src, /\binitTabbar\(\s*document\s*\)/, "initTabbar(document) never called");
  });
});
