// Fake DOM for static/tour.test.mjs (MEM-095, MEM-112, MEM-117, MEM-130). Not a test file itself (no describe/test).
//
// DOM contract static/tour.js may rely on (mirrors docs/design/tutorial/preview.html, which index.html adopts):
//   #tab-routes, #tab-landmarks, #tab-recall, #tab-settings section.tab-panel; #tab-settings holds button#tour-replay.
//   nav.tabbar > ul > li > a.tab[href="#routes|#landmarks|#recall|#settings"]; #tab-routes holds details#drawer >
//   summary.drawer-handle (omitted with { drawerHandle: false } to exercise the missing-target path).
//   div#tour.tour[role=dialog][aria-modal=true][aria-labelledby=tour-title][hidden] >
//     div.tour-spot[aria-hidden=true]
//     div.tour-card > img.tour-pal, div.tour-head > (p.tour-count > span.sr-only, span#tour-n, span#tour-total),
//       ol.tour-dots (empty; tour.js builds one li per step), button#tour-skip.tour-skip;
//       h2#tour-title, p#tour-body, div#tour-house.tour-house[hidden], ol#tour-fig.tour-fig[hidden],
//       p#tour-after[hidden],
//       div.btn-row.tour-actions > button#tour-roll.btn[hidden] "New sticker" (MEM-117, MEM-130),
//         button#tour-roll-undo.btn[hidden] "Undo" (MEM-130), button#tour-back, button#tour-next
//   p#tour-toast.tour-toast[role=status][hidden] "Tour skipped. Replay it any time in Settings."
// APIs supported: document.getElementById/querySelector/querySelectorAll/createElement/createElementNS/createTextNode/
//   addEventListener/activeElement/body/defaultView; element textContent, hidden, id, className, classList
//   (add/remove/toggle/contains), get/set/remove/has/toggleAttribute, style (+setProperty), children,
//   firstElementChild, parentNode/parentElement, appendChild/append/prepend/replaceChildren/removeChild/remove,
//   contains, matches, closest, querySelector(All), addEventListener/removeEventListener/dispatchEvent, click,
//   focus/blur (focus is a no-op on a hidden element or one inside a hidden ancestor, as in a browser),
//   getBoundingClientRect, namespaceURI (createElementNS keeps the tag's case, as a browser does for SVG). window (defaultView): addEventListener, setTimeout/clearTimeout (delegate to globalThis
//   at call time, so node:test mock timers apply), innerWidth/innerHeight.
// Selectors: comma lists, descendant and ">" combinators, compounds of tag, #id, .class, [attr], [attr="v"].
//   Anything else (pseudo-classes, ~, +) throws so a gap shows up as a clear error, not a silent miss.
// innerHTML/outerHTML/insertAdjacentHTML throw: MEM-095 bans HTML parsing for step text.
// Events bubble target -> ancestors -> document -> window; preventDefault sets defaultPrevented.

const NO_HTML = "innerHTML/outerHTML/insertAdjacentHTML are banned (MEM-095 NFR: textContent/createElement only)";

class Text {
  constructor(text) { this.nodeType = 3; this.parentNode = null; this.data = String(text); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v ?? ""); }
}

class El {
  constructor(doc, tag, ns = null) {
    this.nodeType = 1;
    this.ownerDocument = doc;
    this.namespaceURI = ns ?? "http://www.w3.org/1999/xhtml";
    this.tagName = ns ? tag : tag.toUpperCase();
    this.parentNode = null;
    this.childNodes = [];
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.rect = { top: 100, left: 50, width: 80, height: 40 };
    this.style = { setProperty(k, v) { this[k] = String(v); }, removeProperty(k) { delete this[k]; } };
    const cls = () => (this.attrs.class ?? "").split(/\s+/).filter(Boolean);
    const set = (list) => { this.attrs.class = list.join(" "); };
    const add = (...cs) => set([...new Set([...cls(), ...cs])]);
    const remove = (...cs) => set(cls().filter((c) => !cs.includes(c)));
    this.classList = {
      contains: (c) => cls().includes(c),
      add,
      remove,
      toggle: (c, force) => {
        const on = force === undefined ? !cls().includes(c) : Boolean(force);
        if (on) add(c); else remove(c);
        return on;
      },
    };
  }

  get id() { return this.attrs.id ?? ""; }
  set id(v) { this.attrs.id = String(v); }
  get className() { return this.attrs.class ?? ""; }
  set className(v) { this.attrs.class = String(v); }
  get hidden() { return "hidden" in this.attrs; }
  set hidden(v) { if (v) this.attrs.hidden = ""; else delete this.attrs.hidden; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] ?? null; }
  get childElementCount() { return this.children.length; }
  get parentElement() { return this.parentNode instanceof El ? this.parentNode : null; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) {
    for (const n of this.childNodes) n.parentNode = null;
    const s = v == null ? "" : String(v);
    this.childNodes = s ? [this.adopt(new Text(s))] : [];
  }
  get innerHTML() { throw new Error(NO_HTML); }
  set innerHTML(_) { throw new Error(NO_HTML); }
  get outerHTML() { throw new Error(NO_HTML); }
  set outerHTML(_) { throw new Error(NO_HTML); }
  insertAdjacentHTML() { throw new Error(NO_HTML); }

  adopt(n) {
    const node = typeof n === "string" ? new Text(n) : n;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    return node;
  }
  appendChild(n) { this.childNodes.push(this.adopt(n)); return n; }
  append(...ns) { for (const n of ns) this.childNodes.push(this.adopt(n)); }
  prepend(...ns) { this.childNodes.unshift(...ns.map((n) => this.adopt(n))); }
  replaceChildren(...ns) { this.textContent = ""; this.append(...ns); }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i < 0) throw new Error("removeChild: not a child");
    this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() { this.parentNode?.removeChild(this); }
  contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }

  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  toggleAttribute(k, force) {
    const on = force === undefined ? !(k in this.attrs) : Boolean(force);
    if (on) this.attrs[k] = ""; else delete this.attrs[k];
    return on;
  }

  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  matches(sel) { return matchSelector(this, sel); }
  closest(sel) { for (let n = this; n instanceof El; n = n.parentNode) if (matchSelector(n, sel)) return n; return null; }
  querySelectorAll(sel) { return this.descendants().filter((e) => matchSelector(e, sel)); }
  querySelector(sel) { return this.descendants().find((e) => matchSelector(e, sel)) ?? null; }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  dispatchEvent(ev) { return dispatch(this.ownerDocument, this, ev); }
  click() { return this.dispatchEvent(makeEvent("click")); }
  focus() {
    for (let n = this; n instanceof El; n = n.parentNode) if (n.hidden) return;
    this.ownerDocument.activeElement = this;
  }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  getBoundingClientRect() {
    const { top, left, width, height } = this.rect;
    return { top, left, width, height, right: left + width, bottom: top + height, x: left, y: top };
  }
}

function matchCompound(el, c) {
  if (!(el instanceof El)) return false;
  const bare = c.replace(/\[[^\]]*\]/g, "");
  if (/[:~+]/.test(bare)) throw new Error(`tour fake DOM: unsupported selector part "${c}"`);
  const tag = bare.match(/^[a-z][\w-]*|^\*/i)?.[0];
  if (tag && tag !== "*" && tag.toUpperCase() !== el.tagName.toUpperCase()) return false;
  for (const [, k] of bare.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(k)) return false;
  for (const [, k] of bare.matchAll(/#([\w-]+)/g)) if (el.id !== k) return false;
  for (const [, k, dq, sq, raw] of c.matchAll(/\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/g)) {
    if (!(k in el.attrs)) return false;
    const v = dq ?? sq ?? raw;
    if (v !== undefined && el.attrs[k] !== v) return false;
  }
  return true;
}

function matchTokens(el, toks, i) {
  if (!matchCompound(el, toks[i])) return false;
  if (i === 0) return true;
  if (toks[i - 1] === ">") return matchTokens(el.parentNode, toks, i - 2);
  for (let p = el.parentNode; p instanceof El; p = p.parentNode) if (matchTokens(p, toks, i - 1)) return true;
  return false;
}

function matchSelector(el, sel) {
  return String(sel).split(",").some((part) => {
    const toks = part.trim().replace(/\s*>\s*/g, " > ").split(/\s+/).filter(Boolean);
    return toks.length > 0 && matchTokens(el, toks, toks.length - 1);
  });
}

/** A plain event object; `init` may carry key, shiftKey, etc. */
export function makeEvent(type, init = {}) {
  return {
    type, bubbles: true, defaultPrevented: false, target: null, currentTarget: null, stopped: false, ...init,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
}

function dispatch(doc, target, ev) {
  ev.target = target;
  const path = [];
  for (let n = target; n instanceof El; n = n.parentNode) path.push(n);
  path.push(doc, doc.defaultView);
  for (const n of path) {
    ev.currentTarget = n;
    for (const fn of [...(n.listeners[ev.type] ?? [])]) fn.call(n, ev);
    if (ev.stopped) break;
  }
  return !ev.defaultPrevented;
}

function listenerHost() {
  return {
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); },
  };
}

/**
 * The index.html shell plus Pal's tour markup.
 * @param {{ drawerHandle?: boolean, tab?: string }} [opts] tab: the panel shown at start (default "routes").
 */
export function makeTourDom({ drawerHandle = true, tab = "routes" } = {}) {
  const win = Object.assign(listenerHost(), {
    innerWidth: 400,
    innerHeight: 800,
    setTimeout: (...a) => globalThis.setTimeout(...a),
    clearTimeout: (...a) => globalThis.clearTimeout(...a),
  });
  const doc = Object.assign(listenerHost(), {
    nodeType: 9,
    defaultView: win,
    location: { hash: "" },
    activeElement: null,
    createElement: (tag) => new El(doc, tag),
    createElementNS: (ns, tag) => new El(doc, tag, String(ns)),
    createTextNode: (t) => new Text(t),
    getElementById: (id) => [doc.documentElement, ...doc.documentElement.descendants()].find((e) => e.id === id) ?? null,
    querySelectorAll: (sel) => [doc.documentElement, ...doc.documentElement.descendants()].filter((e) => e.matches(sel)),
    querySelector: (sel) => doc.querySelectorAll(sel)[0] ?? null,
    contains: (n) => doc.documentElement.contains(n),
    dispatchEvent: (ev) => dispatch(doc, doc.documentElement, ev),
  });
  win.document = doc;

  /** h(tag, attrs, ...children): attrs keys are attribute names; strings become text nodes. */
  const h = (tag, attrs = {}, ...kids) => {
    const e = new El(doc, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    e.append(...kids.filter((k) => k != null));
    return e;
  };
  const panel = (name, ...kids) => h("section", { id: `tab-${name}`, class: "tab-panel", hidden: name !== tab }, ...kids);
  const tabLink = (name, label) =>
    h("li", {}, h("a", { class: "tab", href: `#${name}`, "aria-current": name === tab ? "page" : null },
      h("svg", { "aria-hidden": "true" }), label));

  const body = h("body", { class: "map-shell" },
    h("header", { class: "topbar" }, h("h1", { class: "brand" }, "MemriPal")),
    h("main", {},
      panel("routes",
        h("div", { class: "map-wrap" }, h("svg", { id: "route-map", class: "route-map" })),
        h("details", { id: "drawer", class: "drawer" },
          drawerHandle ? h("summary", { class: "drawer-handle" }, "Route settings") : null)),
      panel("landmarks", h("h2", {}, "Landmarks")),
      panel("recall", h("h2", {}, "Recall")),
      panel("settings",
        h("section", { class: "panel" },
          h("h2", {}, "Pal's tour"),
          h("button", { id: "tour-replay", class: "btn", type: "button" }, "Replay Pal's tour")))),
    h("nav", { class: "tabbar", "aria-label": "Main" },
      h("ul", {}, tabLink("routes", "Routes"), tabLink("landmarks", "Landmarks"), tabLink("recall", "Recall"),
        tabLink("settings", "Settings"))),
    h("div", { id: "tour", class: "tour", role: "dialog", "aria-modal": "true", "aria-labelledby": "tour-title",
      hidden: true },
      h("div", { class: "tour-spot", "aria-hidden": "true" }),
      h("div", { class: "tour-card" },
        h("img", { class: "tour-pal", src: "/static/assets/pal-idle.svg", alt: "" }),
        h("div", { class: "tour-head" },
          h("p", { class: "tour-count", "aria-live": "polite" },
            h("span", { class: "sr-only" }, "Step "), h("span", { id: "tour-n" }, "1"), " of ",
            h("span", { id: "tour-total" })),
          h("ol", { class: "tour-dots", "aria-hidden": "true" }),
          h("button", { id: "tour-skip", class: "tour-skip", type: "button" }, "Skip tour")),
        h("h2", { id: "tour-title" }),
        h("p", { id: "tour-body" }),
        h("div", { id: "tour-house", class: "tour-house", hidden: true }),
        h("ol", { id: "tour-fig", class: "tour-fig", hidden: true }),
        h("p", { id: "tour-after", hidden: true }),
        h("div", { class: "btn-row tour-actions" },
          h("button", { id: "tour-roll", class: "btn", type: "button", hidden: true }, "New sticker"),
          h("button", { id: "tour-roll-undo", class: "btn", type: "button", hidden: true }, "Undo"),
          h("button", { id: "tour-back", class: "btn", type: "button" }, "Back"),
          h("button", { id: "tour-next", class: "btn btn-primary", type: "button" }, "Next")))),
    h("p", { id: "tour-toast", class: "tour-toast", role: "status", hidden: true },
      "Tour skipped. Replay it any time in Settings."));
  doc.documentElement = h("html", { lang: "en" }, h("head", {}), body);
  doc.body = body;
  doc.activeElement = body;

  const $ = (id) => doc.getElementById(id);
  /** Click an element (bubbles to document and window). */
  const click = (el) => el.dispatchEvent(makeEvent("click"));
  /** Keydown at the focused element (or body); returns the event so callers can read defaultPrevented. */
  const key = (k, init = {}) => {
    const ev = makeEvent("keydown", { key: k, ...init });
    (doc.activeElement ?? body).dispatchEvent(ev);
    return ev;
  };
  return { doc, win, $, click, key };
}
