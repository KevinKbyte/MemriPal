// Covers: MEM-022
// Requirement: generating associations runs the page's own flow: one POST /associate per
// item+locus, each record saved the moment it arrives, per-item progress shown, a resume only
// regenerates missing or invalid records, and model text reaches the page via textContent only.
// Contract (RED; GREEN implements, ADR 0021):
//   app.js exports
//     KAVE_CHANNELS -- ["kinesthetic", "auditory", "visual", "emotional", "conceptual",
//                       "olfactory", "gustatory", "spatial"], in that order
//     runAssociations(pairs, deps) -> Promise; pairs = [{item, locus: {n, label}}]
//       deps = {doc, fetch, store}: doc offers getElementById/createElement(/createTextNode),
//       fetch is the fetch function, store is a palace_store.js createPalaceStore(adapter).
//       Writes progress "<done> of <total>" to #assoc-status (done counts items with a stored
//       record) and renders one #associations child per pair: item, locus label, the 8 channels
//       in KAVE_CHANNELS order (name + text), then the D16 question and answer.
//       Stored entry per pair under associationKey(item, locus.label): {record, status}.
//       A failed request (non-2xx or network error) stores nothing for that pair.
// ASSUMPTION (POST /associate is defined in parallel by slice S3b; GREEN reconciles):
//   request  = POST "/associate", JSON body carrying at least `item` (the item string);
//   response = 200 JSON {record: {item, locus, <8 channels>, question, answer},
//                        status: "valid" | "invalid"}.
// These tests drive runAssociations (the page's path), never the endpoint directly
// (.claude/rules/client-transform-tests-drive-browser-path.md).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as app from "./app.js";
import { associationKey, createPalaceStore } from "./palace_store.js";

const CHANNELS = ["kinesthetic", "auditory", "visual", "emotional", "conceptual", "olfactory", "gustatory", "spatial"];

const tick = () => new Promise((r) => setImmediate(r));

/** Turn the event loop until cond() holds; bounded by turns, never by wall-clock time. */
async function until(cond, label) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await tick();
  }
  assert.fail(`never reached: ${label}`);
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function memoryAdapter() {
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

/** Text of a fake node the way the DOM computes textContent: own text plus descendants'. */
function textOf(node) {
  if (typeof node === "string") return node;
  return node.textContent;
}

/**
 * Fake page: #assoc-status and #associations plus a recording createElement. Every innerHTML /
 * outerHTML write and insertAdjacentHTML call is logged in htmlWrites; setting textContent
 * replaces the children, as in the DOM.
 */
function fakePage() {
  const created = [];
  const htmlWrites = [];
  function el(tag) {
    let own = "";
    const e = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      dataset: {},
      hidden: false,
      className: "",
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      get textContent() {
        return own + this.children.map(textOf).join("");
      },
      set textContent(v) {
        own = String(v);
        this.children = [];
      },
      append(...c) {
        this.children.push(...c);
      },
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      replaceChildren(...c) {
        own = "";
        this.children = c;
      },
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      insertAdjacentHTML(pos, html) {
        htmlWrites.push(["insertAdjacentHTML", String(html)]);
      },
    };
    for (const prop of ["innerHTML", "outerHTML"]) {
      Object.defineProperty(e, prop, {
        get: () => "",
        set: (v) => htmlWrites.push([prop, String(v)]),
      });
    }
    created.push(e);
    return e;
  }
  const status = el("p");
  const panel = el("div");
  const els = { "assoc-status": status, associations: panel };
  const doc = {
    getElementById: (id) => els[id] ?? null,
    createElement: (tag) => el(tag),
    createTextNode: (t) => String(t),
    createDocumentFragment: () => el("#fragment"),
  };
  return { doc, status, panel, created, htmlWrites };
}

const LABELS = ["lamp", "door", "clock", "frame", "shelf"];
const ITEMS = ["milk", "eggs", "bread", "apples", "cheese"];

function pairsOf(n) {
  return ITEMS.slice(0, n).map((item, i) => ({ item, locus: { n: i + 1, label: LABELS[i] } }));
}

function labelFor(item) {
  return LABELS[ITEMS.indexOf(item)];
}

function record(item, label, overrides = {}) {
  const r = { item, locus: label, question: `Why ${item} at ${label}?`, answer: `Because ${item} ${label}` };
  for (const c of CHANNELS) r[c] = `${c}-text ${item} ${label}`;
  return { ...r, ...overrides };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fetch stub answering every /associate call valid at once; records the requested items. */
function answeringFetch(statusFor = () => "valid") {
  const items = [];
  const fn = async (url, init) => {
    assert.equal(String(url), "/associate");
    assert.equal(init.method, "POST");
    const { item } = JSON.parse(init.body);
    items.push(item);
    return jsonResponse({ record: record(item, labelFor(item)), status: statusFor(item) });
  };
  return { fn, items };
}

function setup() {
  const page = fakePage();
  const adapter = memoryAdapter();
  const store = createPalaceStore(adapter);
  return { page, adapter, store };
}

const stored = (store, item) => store.get(associationKey(item, labelFor(item)));

// Covers: MEM-022
// Requirement: the association panel lists the 8 KAVE COGS channels in order.
describe("association channels", () => {
  test("app.js exports runAssociations and KAVE_CHANNELS in KAVE COGS order", () => {
    assert.equal(typeof app.runAssociations, "function");
    assert.deepEqual(app.KAVE_CHANNELS, CHANNELS);
  });

  test("index.html has the #assoc-status progress line and #associations panel", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    assert.match(html, /\bid="assoc-status"/);
    assert.match(html, /\bid="associations"/);
  });
});

// Covers: MEM-022
// Requirement: each item gets one POST /associate and its record is saved to the palace store as
// soon as it arrives -- before the next item's request is answered -- with per-item progress.
describe("runAssociations: per-item save and progress", () => {
  test("each record is stored before the next request resolves", async () => {
    const { page, adapter, store } = setup();
    const calls = [];
    const fetch = (url, init) => {
      const d = deferred();
      calls.push({ url: String(url), item: JSON.parse(init.body).item, d });
      return d.promise;
    };
    const run = app.runAssociations(pairsOf(3), { doc: page.doc, fetch, store });
    for (let i = 0; i < 3; i++) {
      await until(() => calls.length > i, `request ${i + 1} sent`);
      const c = calls[i];
      assert.equal(c.url, "/associate");
      c.d.resolve(jsonResponse({ record: record(c.item, labelFor(c.item)), status: "valid" }));
      // Later requests stay unanswered until this record has reached storage.
      await until(() => new Set(adapter.puts).size > i, `record ${i + 1} saved while later requests pending`);
    }
    await run;
    assert.deepEqual(calls.map((c) => c.item).sort(), ["bread", "eggs", "milk"]);
    for (const item of ["milk", "eggs", "bread"]) {
      const e = await stored(store, item);
      assert.equal(e.status, "valid", item);
      assert.deepEqual(e.record, record(item, labelFor(item)));
    }
  });

  test("progress shows 1 of 3 after the first record and 3 of 3 at the end", async () => {
    const { page, store } = setup();
    const calls = [];
    const fetch = (url, init) => {
      const d = deferred();
      calls.push({ item: JSON.parse(init.body).item, d });
      return d.promise;
    };
    const run = app.runAssociations(pairsOf(3), { doc: page.doc, fetch, store });
    await until(() => calls.length > 0, "first request sent");
    calls[0].d.resolve(jsonResponse({ record: record(calls[0].item, labelFor(calls[0].item)), status: "valid" }));
    await until(() => /\b1 of 3\b/.test(page.status.textContent), `"1 of 3" shown; got "${page.status.textContent}"`);
    for (let i = 1; i < 3; i++) {
      await until(() => calls.length > i, `request ${i + 1} sent`);
      calls[i].d.resolve(jsonResponse({ record: record(calls[i].item, labelFor(calls[i].item)), status: "valid" }));
    }
    await run;
    assert.match(page.status.textContent, /\b3 of 3\b/);
  });

  test("an invalid response is stored with status invalid", async () => {
    const { page, store } = setup();
    const { fn } = answeringFetch((item) => (item === "eggs" ? "invalid" : "valid"));
    await app.runAssociations(pairsOf(2), { doc: page.doc, fetch: fn, store });
    assert.equal((await stored(store, "milk")).status, "valid");
    assert.equal((await stored(store, "eggs")).status, "invalid");
  });

  test("a failed request stores nothing for that item and keeps earlier records", async () => {
    const { page, store } = setup();
    const fetch = async (url, init) => {
      const { item } = JSON.parse(init.body);
      if (item === "eggs") return jsonResponse({ error: "upstream_failed" }, 502);
      if (item === "bread") throw new TypeError("network down");
      return jsonResponse({ record: record(item, labelFor(item)), status: "valid" });
    };
    await app.runAssociations(pairsOf(3), { doc: page.doc, fetch, store }).catch(() => {});
    assert.equal((await stored(store, "milk")).status, "valid");
    assert.ok((await stored(store, "eggs")) == null, "502 must not store a record");
    assert.ok((await stored(store, "bread")) == null, "network error must not store a record");
  });

  test("an empty list sends no requests", async () => {
    const { page, store } = setup();
    const { fn, items } = answeringFetch();
    await app.runAssociations([], { doc: page.doc, fetch: fn, store });
    assert.deepEqual(items, []);
    assert.equal(page.panel.children.length, 0);
  });
});

// Covers: MEM-022
// Requirement: resuming generation regenerates only records that are missing or invalid; valid
// stored records are reused without a request, and the panel still shows every item once.
describe("runAssociations: resume", () => {
  test("3 valid + 1 invalid + 1 missing -> exactly 2 requests, for the invalid and missing items", async () => {
    const { page, store } = setup();
    for (const item of ["milk", "eggs", "bread"]) {
      await store.put(associationKey(item, labelFor(item)), { record: record(item, labelFor(item)), status: "valid" });
    }
    await store.put(associationKey("apples", labelFor("apples")), {
      record: record("apples", labelFor("apples"), { visual: "" }),
      status: "invalid",
    });
    const { fn, items } = answeringFetch();
    await app.runAssociations(pairsOf(5), { doc: page.doc, fetch: fn, store });
    assert.deepEqual([...items].sort(), ["apples", "cheese"]);
    for (const item of ITEMS) assert.equal((await stored(store, item)).status, "valid", item);
    assert.equal(page.panel.children.length, 5);
    assert.match(page.status.textContent, /\b5 of 5\b/);
  });

  test("a record stored under another locus label is not reused (key includes the label)", async () => {
    const { page, store } = setup();
    await store.put(associationKey("milk", "garage"), { record: record("milk", "garage"), status: "valid" });
    const { fn, items } = answeringFetch();
    await app.runAssociations(pairsOf(1), { doc: page.doc, fetch: fn, store });
    assert.deepEqual(items, ["milk"]);
  });

  test("running again when everything is valid sends no requests and does not duplicate the panel", async () => {
    const { page, store } = setup();
    const first = answeringFetch();
    await app.runAssociations(pairsOf(2), { doc: page.doc, fetch: first.fn, store });
    assert.equal(first.items.length, 2);
    const second = answeringFetch();
    await app.runAssociations(pairsOf(2), { doc: page.doc, fetch: second.fn, store });
    assert.deepEqual(second.items, []);
    assert.equal(page.panel.children.length, 2);
  });
});

// Covers: MEM-022
// Requirement: the panel shows each item's locus, the 8 KAVE COGS channels in order and the D16
// question and answer, and model text is only ever set via textContent: hostile markup in a
// record is shown as literal text and never becomes an element.
describe("association panel rendering", () => {
  test("panel shows item, locus, 8 channels in KAVE order, then question and answer", async () => {
    const { page, store } = setup();
    const { fn } = answeringFetch();
    await app.runAssociations(pairsOf(1), { doc: page.doc, fetch: fn, store });
    assert.equal(page.panel.children.length, 1);
    const text = page.panel.textContent;
    const rec = record("milk", "lamp");
    assert.ok(text.includes("milk"), "item shown");
    assert.ok(text.includes("lamp"), "locus label shown");
    let at = -1;
    for (const c of CHANNELS) {
      const name = text.toLowerCase().indexOf(c, at + 1);
      assert.ok(name > at, `channel name "${c}" shown after the previous channel`);
      const value = text.indexOf(rec[c], name);
      assert.ok(value > name, `channel "${c}" text shown after its name`);
      at = value;
    }
    const q = text.indexOf(rec.question, at);
    assert.ok(q > at, "D16 question shown after the channels");
    assert.ok(text.indexOf(rec.answer, q) > q, "D16 answer shown after the question");
  });

  test("hostile markup in a record is rendered as text, never parsed into elements", async () => {
    const { page, store } = setup();
    const hostile = "<img src=x onerror=alert(1)>";
    const fetch = async (url, init) => {
      const { item } = JSON.parse(init.body);
      const rec = record(item, labelFor(item), { visual: hostile, answer: `${hostile}<script>alert(2)</script>` });
      return jsonResponse({ record: rec, status: "valid" });
    };
    await app.runAssociations(pairsOf(1), { doc: page.doc, fetch, store });
    assert.deepEqual(page.htmlWrites, [], "model text must never go through innerHTML/outerHTML/insertAdjacentHTML");
    const tags = page.created.map((e) => e.tagName);
    assert.ok(!tags.includes("IMG") && !tags.includes("SCRIPT"), `hostile markup became elements: ${tags}`);
    assert.ok(page.panel.textContent.includes(hostile), "hostile channel text shown verbatim");
    assert.ok(page.panel.textContent.includes("<script>alert(2)</script>"), "hostile answer shown verbatim");
  });

  test("app.js and palace_store.js never use HTML-string sinks", () => {
    for (const file of ["./app.js", "./palace_store.js"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.doesNotMatch(src, /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b/, file);
    }
  });
});
