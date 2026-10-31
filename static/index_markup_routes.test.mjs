// Covers: MEM-048
// Requirement: static/index.html keeps all 44 live ids, each exactly once, and gains the final Part A
// markup for S1 Routes home (#routes-home #routes-list #routes-new #routes-settings, which holds
// #passcode and #auto, the only home of #auto), S2 Walking: capture (#capture-session #capture-safety
// #capture-safety-ok #capture-strip #capture-locate #capture-finish #capture-count) and S4 Finish walk
// (#finish-name #finish-kind #finish-save inside the existing #route-review). #finish-kind is two
// radios, Daily and Occasional, name="finish-kind" (plan line 253).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MEM048_IDS, MEM050_IDS, MEM050_MAY_START_HIDDEN, MEM051_IDS } from "./index_ids_test.mjs";

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");

const LIVE_IDS = [
  "public-banner", "status", "meta-notice", "photo", "passcode", "auto", "load-demo", "place-settings",
  "place-toggle", "place-typed", "places", "upload-status", "empty-state", "scene-wrap", "scene", "loci",
  "assoc-status", "associations", "route-review", "route", "route-undo", "generate", "scenes", "walk",
  "walk-step", "walk-prev", "walk-next", "recall", "recall-start", "recall-replay", "recall-typed",
  "recall-submit", "recall-live", "recall-results", "history", "rehearsals", "rehearsal-undo",
  "history-view", "hit-rates", "backup", "backup-export", "backup-import", "backup-status", "scene-overlay",
];
const NEW_IDS = MEM048_IDS;
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
// Requirement: the route kind is chosen with two radios, Daily and Occasional, name="finish-kind",
// each labelled. DGN-001 (select-or-add) does not apply: kind is a closed enum with no backing list
// of user-created entities and no add path, and the radios already constrain it before free text.
describe("index.html: #finish-kind is two radios Daily / Occasional", () => {
  const radios = () => all(byId("finish-kind") ?? { children: [] })
    .filter((e) => e.tag === "input" && (e.attrs.type ?? "").toLowerCase() === "radio");

  test("#finish-kind holds exactly two radios named finish-kind", () => {
    assert.ok(byId("finish-kind"), "#finish-kind is missing");
    const rs = radios();
    assert.equal(rs.length, 2, "two radios");
    for (const r of rs) assert.equal(r.attrs.name, "finish-kind");
  });

  test("the radio values are daily and occasional", () => {
    assert.deepEqual(radios().map((r) => r.attrs.value).sort(), ["daily", "occasional"]);
  });

  test("each radio is labelled Daily / Occasional", () => {
    const want = { daily: /daily/i, occasional: /occasional/i };
    for (const r of radios()) {
      let label = null;
      for (let p = r.parent; p; p = p.parent) if (p.tag === "label") label = label ?? p;
      if (!label && r.attrs.id) label = all().find((e) => e.tag === "label" && e.attrs.for === r.attrs.id) ?? null;
      assert.ok(label, `radio ${r.attrs.value} has no label`);
      assert.match(textOf(label), want[r.attrs.value] ?? /^$/, `radio ${r.attrs.value} label text`);
    }
  });
});

// Covers: MEM-050
// Requirement: S3 Station card markup (plan B5, Part A S3): every S3 id exists exactly once next to the 44
// live ids and the MEM-048 ids; #station-card is a section holding #station-name (text input, maxlength
// 40) with #station-name-error, #station-profile (dl), the #station-taps fieldset with its five tap groups
// #tap-sound #tap-smell #tap-feel #tap-mood #tap-turn, and the footer buttons #station-save,
// #station-drop, #station-drop-confirm, #station-drop-cancel and #station-undo. The name error, the
// confirm/cancel pair and Undo start hidden (progressive-disclosure delete). #scene-wrap, #scene and #loci
// stay, each exactly once.
describe("index.html: S3 station card ids and structure (MEM-050)", () => {
  for (const id of MEM050_IDS) {
    test(`S3 id #${id} present exactly once`, () => {
      assert.equal(idCount(id), 1, `#${id} count`);
    });
  }

  test("the S3 ids do not reuse a live or MEM-048 id", () => {
    const overlap = MEM050_IDS.filter((id) => LIVE_IDS.includes(id) || NEW_IDS.includes(id));
    assert.deepEqual(overlap, []);
  });

  test("#station-card is a section holding every other S3 id", () => {
    assert.equal(byId("station-card")?.tag, "section");
    for (const id of MEM050_IDS.filter((x) => x !== "station-card")) {
      assert.ok(inside(byId(id), "station-card"), `#${id} inside #station-card`);
    }
  });

  test("#station-name is a text input with maxlength 40; #station-profile is a dl", () => {
    const name = byId("station-name");
    assert.equal(name?.tag, "input");
    assert.equal((name.attrs.type ?? "text").toLowerCase(), "text");
    assert.equal(name.attrs.maxlength, "40");
    assert.equal(byId("station-profile")?.tag, "dl");
  });

  test("#station-taps is a fieldset holding the five tap groups", () => {
    assert.equal(byId("station-taps")?.tag, "fieldset");
    for (const g of ["sound", "smell", "feel", "mood", "turn"]) {
      assert.ok(inside(byId(`tap-${g}`), "station-taps"), `#tap-${g} inside #station-taps`);
    }
  });

  test("save, drop, confirm, cancel and undo are buttons", () => {
    for (const id of ["station-save", "station-drop", "station-drop-confirm", "station-drop-cancel", "station-undo"]) {
      assert.equal(byId(id)?.tag, "button", `#${id} is a button`);
    }
  });

  test("the name error, drop confirm/cancel and Undo start hidden; save and drop start visible", () => {
    for (const id of ["station-name-error", "station-drop-confirm", "station-drop-cancel", "station-undo"]) {
      assert.ok(byId(id) && "hidden" in byId(id).attrs, `#${id} starts hidden`);
      assert.ok(MEM050_MAY_START_HIDDEN.includes(id));
    }
    for (const id of ["station-save", "station-drop"]) {
      assert.ok(byId(id) && !("hidden" in byId(id).attrs), `#${id} starts visible`);
    }
  });

  test("#scene-wrap > #scene and #loci stay, each exactly once", () => {
    for (const id of ["scene-wrap", "scene", "loci"]) assert.equal(idCount(id), 1, `#${id} count`);
    assert.ok(inside(byId("scene"), "scene-wrap"), "#scene inside #scene-wrap");
  });
});

// Covers: MEM-051
// Requirement: static/index.html gains the B6 Part A markup for S5 Route view (#route-view section with
// the #route-map SVG, #route-view-stations ol, #route-view-practice button and the delete controls
// #route-view-delete / -confirm / -cancel and #route-view-undo) and S8's #recall-map SVG and #recall-mode
// text inside the existing #recall; each id exactly once, both maps on the 320x200 viewBox (plan B6).
describe("index.html: S5 Route view + S8 recall map ids (MEM-051)", () => {
  for (const id of MEM051_IDS) {
    test(`new id #${id} present exactly once`, () => {
      assert.equal(idCount(id), 1, `#${id} count`);
    });
  }

  test("#route-view is a section holding the map, stations, practice and delete controls", () => {
    assert.equal(byId("route-view")?.tag, "section");
    for (const id of ["route-map", "route-view-stations", "route-view-practice", "route-view-delete",
      "route-view-delete-confirm", "route-view-delete-cancel", "route-view-undo"]) {
      assert.ok(inside(byId(id), "route-view"), `#${id} inside #route-view`);
    }
    assert.equal(byId("route-view-stations")?.tag, "ol");
    for (const id of ["route-view-practice", "route-view-delete", "route-view-delete-confirm",
      "route-view-delete-cancel", "route-view-undo"]) {
      assert.equal(byId(id)?.tag, "button", `#${id} is a button`);
    }
  });

  test("#route-map and #recall-map are SVGs on viewBox 0 0 320 200; #recall-map and #recall-mode sit in #recall", () => {
    for (const id of ["route-map", "recall-map"]) {
      assert.equal(byId(id)?.tag, "svg", `#${id} is an svg`);
      assert.equal(byId(id).attrs.viewbox, "0 0 320 200", `#${id} viewBox`);
    }
    assert.ok(inside(byId("recall-map"), "recall"), "#recall-map inside #recall");
    assert.ok(inside(byId("recall-mode"), "recall"), "#recall-mode inside #recall");
  });
});
