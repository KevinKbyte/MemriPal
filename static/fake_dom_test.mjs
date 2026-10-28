// Shared fake page for the scene panel and encode UI tests (MEM-029, MEM-030). Not a test file
// itself (no describe/test); the *.test.mjs files import it.
//
// DOM surface the code under test may use (anything else is absent, as a test failure, not a
// silent pass): doc.getElementById / createElement / createTextNode / createDocumentFragment /
// addEventListener / removeEventListener; element children via append / appendChild / prepend /
// replaceChildren / remove; textContent; hidden; disabled; dataset (setAttribute("data-x") mirrors
// into dataset); style (plain object; style.setProperty sets the camelCase key); classList;
// setAttribute / getAttribute / removeAttribute / toggleAttribute; addEventListener /
// removeEventListener / on<type> handlers; img.src; canvas getContext("2d") (no-op context).
// No querySelector: page elements are found by id, created elements by reference.
//
// Every innerHTML / outerHTML write and insertAdjacentHTML call is logged in htmlWrites; every
// img src assignment (property or attribute) is logged in srcWrites. fire() dispatches an event
// that bubbles target -> parents -> doc, honours stopPropagation, and drops clicks on a disabled
// element, like the browser.

/** @param {any} node */
export function textOf(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  return node.textContent;
}

/** Text a user can see: hidden subtrees are skipped. */
export function visibleText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (node.hidden) return "";
  return node._own + node.children.map(visibleText).join("");
}

/** Depth-first search of element descendants (root included). */
export function findAll(root, pred, { visibleOnly = false } = {}) {
  const out = [];
  const walk = (n) => {
    if (n == null || typeof n === "string") return;
    if (visibleOnly && n.hidden) return;
    if (pred(n)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

export function find(root, pred, opts) {
  return findAll(root, pred, opts)[0] ?? null;
}

const noopCtx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: () => true });

function camel(prop) {
  return String(prop).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * @param {string[]} ids page element ids (index.html roots)
 * @param {{hidden?: string[]}} [opts] ids that start hidden, as in index.html
 */
export function fakePage(ids, opts = {}) {
  const created = [];
  const htmlWrites = [];
  const srcWrites = [];
  const docListeners = {};

  function detach(child) {
    if (child && typeof child === "object" && child.parent) {
      const sib = child.parent.children;
      const at = sib.indexOf(child);
      if (at >= 0) sib.splice(at, 1);
      child.parent = null;
    }
  }

  function adopt(parent, list) {
    for (const c of list) {
      if (c && typeof c === "object") {
        detach(c);
        if (c.tagName === "#FRAGMENT") {
          const kids = [...c.children];
          c.children = [];
          adopt(parent, kids);
          continue;
        }
        c.parent = parent;
      }
      parent.children.push(c);
    }
  }

  function el(tag) {
    const listeners = {};
    const classes = new Set();
    let src = "";
    const e = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parent: null,
      _own: "",
      attrs: {},
      dataset: {},
      style: {
        setProperty(k, v) {
          this[camel(k)] = String(v);
        },
        removeProperty(k) {
          delete this[camel(k)];
        },
      },
      hidden: false,
      disabled: false,
      className: "",
      id: "",
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        toggle: (c, force) => {
          const on = force === undefined ? !classes.has(c) : Boolean(force);
          if (on) classes.add(c);
          else classes.delete(c);
          return on;
        },
        contains: (c) => classes.has(c),
      },
      get parentElement() {
        return this.parent;
      },
      get parentNode() {
        return this.parent;
      },
      get textContent() {
        return this._own + this.children.map(textOf).join("");
      },
      set textContent(v) {
        this._own = v == null ? "" : String(v);
        for (const c of this.children) if (c && typeof c === "object") c.parent = null;
        this.children = [];
      },
      append(...c) {
        adopt(this, c);
      },
      appendChild(c) {
        adopt(this, [c]);
        return c;
      },
      prepend(...c) {
        const rest = this.children;
        this.children = [];
        adopt(this, c);
        this.children.push(...rest);
      },
      replaceChildren(...c) {
        this._own = "";
        for (const old of this.children) if (old && typeof old === "object") old.parent = null;
        this.children = [];
        adopt(this, c);
      },
      remove() {
        detach(this);
      },
      setAttribute(k, v) {
        const key = String(k).toLowerCase();
        this.attrs[key] = String(v);
        if (key === "hidden") this.hidden = true;
        else if (key === "disabled") this.disabled = true;
        else if (key === "src") this.src = String(v);
        else if (key.startsWith("data-")) this.dataset[camel(key.slice(5))] = String(v);
      },
      getAttribute(k) {
        return this.attrs[String(k).toLowerCase()] ?? null;
      },
      removeAttribute(k) {
        const key = String(k).toLowerCase();
        delete this.attrs[key];
        if (key === "hidden") this.hidden = false;
        else if (key === "disabled") this.disabled = false;
      },
      toggleAttribute(k, force) {
        const key = String(k).toLowerCase();
        const on = force === undefined ? !(key in this.attrs) : Boolean(force);
        if (on) this.setAttribute(key, "");
        else this.removeAttribute(key);
        return on;
      },
      addEventListener(type, fn) {
        (listeners[type] ??= []).push(fn);
      },
      removeEventListener(type, fn) {
        listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
      },
      _listeners: listeners,
      focus() {},
      blur() {},
      getContext: () => noopCtx,
      insertAdjacentHTML(pos, html) {
        htmlWrites.push(["insertAdjacentHTML", String(html)]);
      },
    };
    Object.defineProperty(e, "src", {
      get: () => src,
      set: (v) => {
        src = String(v);
        srcWrites.push(src);
      },
    });
    for (const prop of ["innerHTML", "outerHTML"]) {
      Object.defineProperty(e, prop, {
        get: () => "",
        set: (v) => htmlWrites.push([prop, String(v)]),
      });
    }
    created.push(e);
    return e;
  }

  const els = {};
  for (const id of ids) {
    const root = el(id === "generate" || id.endsWith("-prev") || id.endsWith("-next") || id.endsWith("-undo") ? "button" : "div");
    root.id = id;
    if ((opts.hidden ?? []).includes(id)) root.hidden = true;
    els[id] = root;
  }
  const createdBefore = created.length;

  const doc = {
    getElementById: (id) => els[id] ?? null,
    createElement: (tag) => el(tag),
    createTextNode: (t) => String(t),
    createDocumentFragment: () => el("#fragment"),
    addEventListener(type, fn) {
      (docListeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      docListeners[type] = (docListeners[type] ?? []).filter((f) => f !== fn);
    },
  };

  /**
   * Dispatch `type` at target (an element or doc); bubbles to doc. Returns the event.
   * @param {any} target
   * @param {string} type
   * @param {Record<string, any>} [init]
   */
  function fire(target, type, init = {}) {
    let stopped = false;
    const ev = {
      type,
      target,
      currentTarget: target,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
      stopImmediatePropagation() {
        stopped = true;
      },
      ...init,
    };
    if (type === "click" && target && target !== doc && target.disabled) return ev;
    const chain = [];
    for (let n = target === doc ? null : target; n; n = n.parent) chain.push(n);
    for (const node of chain) {
      ev.currentTarget = node;
      for (const fn of [...(node._listeners[type] ?? [])]) fn.call(node, ev);
      const handler = node[`on${type}`];
      if (typeof handler === "function") handler.call(node, ev);
      if (stopped) return ev;
    }
    ev.currentTarget = doc;
    for (const fn of [...(docListeners[type] ?? [])]) fn.call(doc, ev);
    const handler = doc[`on${type}`];
    if (typeof handler === "function") handler.call(doc, ev);
    return ev;
  }

  /** Elements the code under test created (page roots excluded). */
  const madeByCode = () => created.slice(createdBefore);

  return { doc, els, created, madeByCode, htmlWrites, srcWrites, fire };
}

export const tick = () => new Promise((r) => setImmediate(r));

/** Turn the event loop until cond() holds; bounded by turns, never by wall-clock time. */
export async function until(cond, label, turns = 300) {
  for (let i = 0; i < turns; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`never reached: ${label}`);
}

/** Let pending work run for a fixed number of event-loop turns (no wall-clock sleep). */
export async function settle(turns = 30) {
  for (let i = 0; i < turns; i++) await tick();
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function memoryAdapter() {
  const map = new Map();
  const puts = [];
  return {
    map,
    puts,
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : undefined;
    },
    async put(key, value) {
      puts.push(key);
      map.set(key, structuredClone(value));
    },
    async list() {
      return [...map.values()].map((v) => structuredClone(v));
    },
  };
}

export const CHANNELS = ["kinesthetic", "auditory", "visual", "emotional", "conceptual", "olfactory", "gustatory", "spatial"];

/** A validator-clean association record for item at label. */
export function record(item, label, overrides = {}) {
  const r = { item, locus: label, question: `Why ${item} at ${label}?`, answer: `Because ${item} ${label}` };
  for (const c of CHANNELS) r[c] = `${c}-text ${item} ${label}`;
  return { ...r, ...overrides };
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Safe image src as MEM-029/MEM-030 define it, restated independently of the code under test. */
export const SAFE_SRC = /^(data:image\/(png|jpeg|webp);base64,|blob:)/;
