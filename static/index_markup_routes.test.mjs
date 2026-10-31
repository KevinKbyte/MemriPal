// Covers: MEM-048
// Requirement: static/index.html keeps all 44 live ids, each exactly once, and gains the final Part A
// markup for S1 Routes home (#routes-home #routes-list #routes-new #routes-settings, which holds
// #passcode and #auto, the only home of #auto), S2 Walking: capture (#capture-session #capture-safety
// #capture-safety-ok #capture-strip #capture-locate #capture-finish #capture-count) and S4 Finish walk
// (#finish-name #finish-kind #finish-save inside the existing #route-review). Per decision-graph node
// DGN-001 (select-or-add), #finish-kind is a select of the existing kinds (daily, occasional) with an
// explicit add-new option that reveals a labelled text input #finish-kind-new (hidden until chosen),
// never a free-text-only field.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");

const LIVE_IDS = [
  "public-banner", "status", "meta-notice", "photo", "passcode", "auto", "load-demo", "place-settings",
  "place-toggle", "place-typed", "places", "upload-status", "empty-state", "scene-wrap", "scene", "loci",
  "assoc-status", "associations", "route-review", "route", "route-undo", "generate", "scenes", "walk",
  "walk-step", "walk-prev", "walk-next", "recall", "recall-start", "recall-replay", "recall-typed",
  "recall-submit", "recall-live", "recall-results", "history", "rehearsals", "rehearsal-undo",
  "history-view", "hit-rates", "backup", "backup-export", "backup-import", "backup-status", "scene-overlay",
];
const NEW_IDS = [
  "routes-home", "routes-list", "routes-new", "routes-settings",
  "capture-session", "capture-safety", "capture-safety-ok", "capture-strip", "capture-locate",
  "capture-finish", "capture-count",
  "finish-name", "finish-kind", "finish-save", "finish-kind-new",
];
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source",
  "track", "wbr"]);

// Element tree: { tag, attrs, children, parent, text }.
function parseHtml(src) {
  const root = { tag: "#root", attrs: {}, children: [], parent: null, text: "" };
  let cur = root;
  const body = src.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype[^>]*>/i, "");
  let last = 0;
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    cur.text += body.slice(last, m.index);
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

const ROOT = parseHtml(HTML);
const all = (n = ROOT, out = []) => {
  for (const c of n.children) {
    out.push(c);
    all(c, out);
  }
  return out;
};
const byId = (id) => all().find((e) => e.attrs.id === id) ?? null;
const textOf = (n) => n.text + n.children.map(textOf).join("");
const inside = (el, ancestorId) => {
  for (let p = el?.parent; p; p = p.parent) if (p.attrs.id === ancestorId) return true;
  return false;
};
const idCount = (id) => all().filter((e) => e.attrs.id === id).length;

// Covers: MEM-048
// Requirement: every live id survives exactly once and every new Part A id exists exactly once.
describe("index.html: 44 live ids kept + S1/S2/S4 ids added (criterion 8)", () => {
  test("the live id list has 44 entries", () => {
    assert.equal(LIVE_IDS.length, 44);
    assert.equal(new Set(LIVE_IDS).size, 44);
  });

  for (const id of LIVE_IDS) {
    test(`live id #${id} present exactly once`, () => {
      assert.equal(idCount(id), 1, `#${id} count`);
    });
  }

  for (const id of NEW_IDS) {
    test(`new id #${id} present exactly once`, () => {
      assert.equal(idCount(id), 1, `#${id} count`);
    });
  }
});

// Covers: MEM-048
// Requirement: S1/S2/S4 elements have the roles Part A gives them.
describe("index.html: S1/S2/S4 structure", () => {
  test("#routes-home is a section holding #routes-list (ol) and #routes-new (button)", () => {
    assert.equal(byId("routes-home")?.tag, "section");
    assert.equal(byId("routes-list")?.tag, "ol");
    assert.ok(inside(byId("routes-list"), "routes-home"));
    assert.equal(byId("routes-new")?.tag, "button");
    assert.ok(inside(byId("routes-new"), "routes-home"));
  });

  test("#routes-settings is a details holding #passcode and #auto (the only home of #auto)", () => {
    assert.equal(byId("routes-settings")?.tag, "details");
    assert.ok(inside(byId("passcode"), "routes-settings"), "#passcode inside #routes-settings");
    assert.ok(inside(byId("auto"), "routes-settings"), "#auto inside #routes-settings");
    assert.equal(byId("auto").attrs.type, "checkbox");
  });

  test("#capture-session is a section holding the capture controls", () => {
    assert.equal(byId("capture-session")?.tag, "section");
    for (const id of ["capture-safety", "capture-safety-ok", "capture-strip", "capture-locate", "capture-finish",
      "capture-count"]) {
      assert.ok(inside(byId(id), "capture-session"), `#${id} inside #capture-session`);
    }
    assert.equal(byId("capture-safety-ok")?.tag, "button");
    assert.equal(byId("capture-strip")?.tag, "ol");
    assert.equal(byId("capture-locate")?.tag, "input");
    assert.equal(byId("capture-locate").attrs.type, "checkbox");
    assert.equal(byId("capture-finish")?.tag, "button");
  });

  test("#finish-name, #finish-kind and #finish-save sit inside the existing #route-review", () => {
    for (const id of ["finish-name", "finish-kind", "finish-save"]) {
      assert.ok(inside(byId(id), "route-review"), `#${id} inside #route-review`);
    }
    assert.equal(byId("finish-name")?.tag, "input");
    assert.equal(byId("finish-save")?.tag, "button");
  });
});

// Covers: MEM-048
// Requirement: DGN-001 select-or-add for the route kind: a select of existing kinds plus an explicit
// add-new path, labelled, with the add-new input hidden until chosen.
describe("index.html: #finish-kind is select-or-add (DGN-001)", () => {
  const kind = () => byId("finish-kind");
  const options = () => (kind()?.children ?? []).flatMap((c) => (c.tag === "optgroup" ? c.children : [c]))
    .filter((c) => c.tag === "option");

  test("#finish-kind is a select", () => {
    assert.equal(kind()?.tag, "select");
  });

  test("it offers the existing kinds daily and occasional", () => {
    const values = options().map((o) => o.attrs.value);
    assert.ok(values.includes("daily"), `options ${JSON.stringify(values)} include daily`);
    assert.ok(values.includes("occasional"), `options ${JSON.stringify(values)} include occasional`);
  });

  test("it has exactly one add-new option, distinct from the existing kinds", () => {
    const addNew = options().filter((o) => /add|new/i.test(textOf(o)) && !["daily", "occasional"].includes(o.attrs.value));
    assert.equal(addNew.length, 1, "one add-new option");
    assert.ok(addNew[0].attrs.value, "the add-new option has a non-empty value");
  });

  test("the add-new text input #finish-kind-new is in #route-review, hidden, and labelled", () => {
    const input = byId("finish-kind-new");
    assert.equal(input?.tag, "input");
    assert.equal(input.attrs.type ?? "text", "text");
    assert.ok(inside(input, "route-review"));
    const hiddenSelfOrWrapper = "hidden" in input.attrs || (() => {
      for (let p = input.parent; p && p.attrs.id !== "route-review"; p = p.parent) if ("hidden" in p.attrs) return true;
      return false;
    })();
    assert.ok(hiddenSelfOrWrapper, "#finish-kind-new (or its wrapper) starts hidden");
    const labelled = all().some((e) => e.tag === "label" && e.attrs.for === "finish-kind-new") || "aria-label" in input.attrs;
    assert.ok(labelled, "#finish-kind-new has a label");
  });

  test("#finish-kind has a label", () => {
    assert.ok(all().some((e) => e.tag === "label" && e.attrs.for === "finish-kind"), "label for=finish-kind");
  });
});
