// Covers: MEM-033
// Requirement: every recall run is kept as a human-readable rehearsal record (never audio), shown as
// "what you said vs what is in the palace", summed into per-point hit rates across runs with chronic
// misses flagged, and deleted only after a confirm with an Undo (D18).
// Contract (RED; GREEN implements in static/rehearsals.js):
//   createRehearsalStore(adapter, {now, newId}) -> {save(palaceId, run), get(id), list(palaceId)}, all async
//     adapter = {get(key), put(key, value), delete(key), list() -> value[]}, all async (IndexedDB in the
//     browser, an in-memory Map here). Every stored value is a JSON string.
//     run = {transcript, results} (results = recall_match results(); extra fields such as audio are ignored).
//     save -> the record {id: newId(), palace_id, timestamp: new Date(now()).toISOString(), transcript,
//       points: [{label, source_quote, got, override, span}]} and nothing else; transcript stored verbatim.
//     get(id) -> that record, or null/undefined when absent; list(palaceId) -> that palace's records,
//       oldest first.
//   hitRates(records) -> [{label, hits, runs, rate, chronic}] in first-seen order: runs = records holding
//     the label, hits = runs where the point was got (an override counts), rate = hits / runs,
//     chronic = runs >= 2 && rate < 0.5.
//   renderSaidVsPalace(record, doc) -> element whose children are one row per point in palace order; each
//     row shows the short label, a got row its span and source_quote, a miss "not said" and source_quote;
//     text via textContent only (no innerHTML / outerHTML / insertAdjacentHTML).
//   deleteRehearsalWithUndo(id, {store, confirm, showUndo}) -> Promise<boolean>: awaits confirm(); declined
//     -> deletes nothing, returns false; accepted -> deletes the record, calls showUndo(undo), returns true;
//     awaiting undo() restores the identical record.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as reh from "./rehearsals.js";

const T0 = Date.UTC(2026, 9, 31, 9, 30, 0);
const AUDIO_B64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=SENTINEL";

/** In-memory stand-in for the IndexedDB adapter. */
function memoryAdapter() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : undefined;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    async list() {
      return [...map.values()];
    },
  };
}

function clockAndIds(step = 60_000) {
  let t = T0;
  let n = 0;
  return {
    now: () => (t += step),
    newId: () => `reh-${++n}`,
  };
}

const point = (label, source_quote, got, override = false, span = null) => ({
  label,
  source_quote,
  got,
  override,
  span,
});

function demoRun() {
  return {
    transcript: '  um "vivid" images stick better than plain facts\n and <b>students</b> can use it  ',
    audio: new Uint8Array([82, 73, 70, 70, 1, 2, 3]),
    audio_b64: AUDIO_B64,
    wav: AUDIO_B64,
    results: [
      { ...point("Vivid images", "Vivid images stick better than plain facts.", true, false, "vivid images stick better than plain facts"), audio: AUDIO_B64 },
      { ...point("Students", "Students can use it for exams", false, true, null), pcm: [1, 2, 3] },
      point("Engage every sense", "Imagine how the scene sounds, smells, tastes and feels", false),
    ],
  };
}

const POINT_KEYS = ["got", "label", "override", "source_quote", "span"];
const RECORD_KEYS = ["id", "palace_id", "points", "timestamp", "transcript"];

function keysDeep(value, out = []) {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysDeep(v, out);
    }
  }
  return out;
}

/** Fake page with a recording createElement; every HTML-string write is logged. */
function fakePage() {
  const htmlWrites = [];
  const textOf = (node) => (typeof node === "string" ? node : node.textContent);
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
    return e;
  }
  const doc = {
    getElementById: () => null,
    createElement: (tag) => el(tag),
    createTextNode: (t) => String(t),
    createDocumentFragment: () => el("#fragment"),
  };
  return { doc, htmlWrites };
}

const record = (id, points) => ({
  id,
  palace_id: "p1",
  timestamp: new Date(T0).toISOString(),
  transcript: "",
  points,
});

// Covers: MEM-033
// Requirement: rehearsals.js exports the store, hit rates, said-vs-palace view and confirm+Undo delete.
describe("rehearsals exports", () => {
  test("exports createRehearsalStore, hitRates, renderSaidVsPalace, deleteRehearsalWithUndo", () => {
    for (const name of ["createRehearsalStore", "hitRates", "renderSaidVsPalace", "deleteRehearsalWithUndo"]) {
      assert.equal(typeof reh[name], "function", name);
    }
  });
});

// Covers: MEM-033
// Requirement: a finished recall run is saved and is still there after a reload (D18 saved + reloaded).
describe("rehearsal store: saved and reloaded", () => {
  test("save returns the record and a new store over the same adapter reads it back", async () => {
    const adapter = memoryAdapter();
    const saved = await reh.createRehearsalStore(adapter, clockAndIds(0)).save("p1", demoRun());
    assert.match(saved.id, /^reh-\d+$/);
    assert.equal(saved.palace_id, "p1");
    assert.equal(saved.timestamp, new Date(T0).toISOString());
    assert.equal(saved.transcript, demoRun().transcript);
    const reloaded = reh.createRehearsalStore(adapter, clockAndIds());
    assert.deepEqual(await reloaded.get("reh-1"), saved);
    assert.deepEqual(await reloaded.list("p1"), [saved]);
  });

  test("list returns only that palace's rehearsals, oldest first", async () => {
    const store = reh.createRehearsalStore(memoryAdapter(), clockAndIds());
    const a = await store.save("p1", demoRun());
    await store.save("p2", demoRun());
    const c = await store.save("p1", demoRun());
    assert.deepEqual((await store.list("p1")).map((r) => r.id), [a.id, c.id]);
    assert.deepEqual(await store.list("nope"), []);
  });

  test("get of an unknown id returns nothing", async () => {
    const store = reh.createRehearsalStore(memoryAdapter(), clockAndIds());
    assert.ok((await store.get("missing")) == null);
  });
});

// Covers: MEM-033
// Requirement: the stored rehearsal is human-readable JSON with only the D18 fields; the transcript is kept
// verbatim and no audio ever reaches the store (D18, D4 audio never persisted).
describe("rehearsal store: record shape and no audio", () => {
  test("each stored value is a JSON string with exactly the record fields", async () => {
    const adapter = memoryAdapter();
    await reh.createRehearsalStore(adapter, clockAndIds()).save("p1", demoRun());
    const values = await adapter.list();
    assert.equal(values.length, 1);
    assert.equal(typeof values[0], "string");
    const parsed = JSON.parse(values[0]);
    assert.deepEqual(Object.keys(parsed).sort(), RECORD_KEYS);
    assert.equal(parsed.points.length, 3);
    for (const p of parsed.points) assert.deepEqual(Object.keys(p).sort(), POINT_KEYS);
    assert.ok(!Number.isNaN(Date.parse(parsed.timestamp)));
    assert.equal(parsed.timestamp, new Date(Date.parse(parsed.timestamp)).toISOString());
  });

  test("the transcript and per-point results are stored verbatim", async () => {
    const adapter = memoryAdapter();
    await reh.createRehearsalStore(adapter, clockAndIds()).save("p1", demoRun());
    const parsed = JSON.parse((await adapter.list())[0]);
    const run = demoRun();
    assert.equal(parsed.transcript, run.transcript);
    assert.deepEqual(
      parsed.points,
      run.results.map(({ label, source_quote, got, override, span }) => ({ label, source_quote, got, override, span })),
    );
  });

  test("no audio field or audio bytes survive into the store", async () => {
    const adapter = memoryAdapter();
    await reh.createRehearsalStore(adapter, clockAndIds()).save("p1", demoRun());
    const raw = (await adapter.list())[0];
    assert.ok(!raw.includes("SENTINEL"), "audio base64 reached the store");
    assert.ok(!raw.includes("UklGR"), "WAV header reached the store");
    const keys = keysDeep(JSON.parse(raw));
    assert.deepEqual(keys.filter((k) => /audio|wav|pcm|blob/i.test(k)), []);
  });
});

// Covers: MEM-033
// Requirement: history shows each point's hit rate across runs and flags chronically missed points (D18).
describe("rehearsal history: hit rate per point", () => {
  const runs = [
    record("r1", [point("lamp", "q1", true, false, "a"), point("door", "q2", false), point("desk", "q4", false)]),
    record("r2", [point("lamp", "q1", true, false, "a"), point("door", "q2", false), point("desk", "q4", true, true)]),
    record("r3", [point("lamp", "q1", true, false, "a"), point("door", "q2", true, false, "b"), point("clock", "q3", false)]),
  ];

  test("hits, runs and rate per label across three runs, in first-seen order", () => {
    const rates = reh.hitRates(runs);
    assert.deepEqual(rates.map((r) => r.label), ["lamp", "door", "desk", "clock"]);
    const by = Object.fromEntries(rates.map((r) => [r.label, r]));
    assert.deepEqual([by.lamp.hits, by.lamp.runs], [3, 3]);
    assert.equal(by.lamp.rate, 1);
    assert.deepEqual([by.door.hits, by.door.runs], [1, 3]);
    assert.ok(Math.abs(by.door.rate - 1 / 3) < 1e-9);
  });

  test('a "mark got it" override counts as a hit', () => {
    const desk = reh.hitRates(runs).find((r) => r.label === "desk");
    assert.deepEqual([desk.hits, desk.runs, desk.rate], [1, 2, 0.5]);
  });

  test("chronic = at least 2 runs and rate below 0.5 (0.5 exactly is not chronic)", () => {
    const by = Object.fromEntries(reh.hitRates(runs).map((r) => [r.label, r.chronic]));
    assert.deepEqual(by, { lamp: false, door: true, desk: false, clock: false });
  });

  test("a point missed in its only run is not chronic yet", () => {
    const [only] = reh.hitRates([record("r1", [point("clock", "q3", false)])]);
    assert.deepEqual([only.hits, only.runs, only.rate, only.chronic], [0, 1, 0, false]);
  });

  test("no runs, no rates", () => {
    assert.deepEqual(reh.hitRates([]), []);
  });
});

// Covers: MEM-033
// Requirement: the per-run view shows, for each point, what was said beside what is in the palace, or
// "not said" for a miss, with stored text rendered literally (never as HTML) (D18).
describe("rehearsal view: said vs palace", () => {
  const hostile = "<img src=x onerror=1>";
  const rec = record("r1", [
    point("Vivid images", "Vivid images stick better than plain facts.", true, false, "vivid images stick better"),
    point(hostile, "Students can use it for exams", false),
    point("Engage every sense", `smells ${hostile}`, true, false, `tastes ${hostile}`),
  ]);

  test("one row per point in palace order", () => {
    const { doc } = fakePage();
    const view = reh.renderSaidVsPalace(rec, doc);
    assert.equal(view.children.length, 3);
  });

  test("a got row shows the matched span and the source quote", () => {
    const { doc } = fakePage();
    const row = reh.renderSaidVsPalace(rec, doc).children[0].textContent;
    assert.ok(row.includes("vivid images stick better"), row);
    assert.ok(row.includes("Vivid images stick better than plain facts."), row);
    assert.ok(!row.includes("not said"), row);
  });

  test('a missed row shows "not said" and the source quote', () => {
    const { doc } = fakePage();
    const row = reh.renderSaidVsPalace(rec, doc).children[1].textContent;
    assert.ok(row.includes("not said"), row);
    assert.ok(row.includes("Students can use it for exams"), row);
  });

  test("hostile label, span and quote render literally via textContent only", () => {
    const { doc, htmlWrites } = fakePage();
    const view = reh.renderSaidVsPalace(rec, doc);
    assert.ok(view.children[1].textContent.includes(hostile), "hostile label not shown literally");
    assert.ok(view.children[2].textContent.includes(`tastes ${hostile}`), "hostile span not shown literally");
    assert.ok(view.children[2].textContent.includes(`smells ${hostile}`), "hostile quote not shown literally");
    assert.deepEqual(htmlWrites, []);
  });
});

// Covers: MEM-033
// Requirement: deleting a rehearsal takes a confirm, and an Undo after the delete restores it exactly (D18).
describe("rehearsal delete: confirm + Undo", () => {
  async function seeded() {
    const adapter = memoryAdapter();
    const store = reh.createRehearsalStore(adapter, clockAndIds());
    const saved = await store.save("p1", demoRun());
    return { adapter, store, saved };
  }

  test("a declined confirm deletes nothing and offers no Undo", async () => {
    const { adapter, store, saved } = await seeded();
    const before = [...adapter.map.entries()];
    const undos = [];
    const result = await reh.deleteRehearsalWithUndo(saved.id, {
      store,
      confirm: async () => false,
      showUndo: (undo) => undos.push(undo),
    });
    assert.equal(result, false);
    assert.deepEqual([...adapter.map.entries()], before);
    assert.deepEqual(await store.get(saved.id), saved);
    assert.equal(undos.length, 0);
  });

  test("an accepted confirm deletes the rehearsal and shows an Undo", async () => {
    const { store, saved } = await seeded();
    let confirms = 0;
    const undos = [];
    const result = await reh.deleteRehearsalWithUndo(saved.id, {
      store,
      confirm: () => {
        confirms += 1;
        return true;
      },
      showUndo: (undo) => undos.push(undo),
    });
    assert.equal(result, true);
    assert.equal(confirms, 1);
    assert.ok((await store.get(saved.id)) == null);
    assert.deepEqual(await store.list("p1"), []);
    assert.equal(undos.length, 1);
    assert.equal(typeof undos[0], "function");
  });

  test("Undo restores the identical record, also after a reload", async () => {
    const { adapter, store, saved } = await seeded();
    const rawBefore = (await adapter.list())[0];
    const undos = [];
    await reh.deleteRehearsalWithUndo(saved.id, { store, confirm: async () => true, showUndo: (u) => undos.push(u) });
    await undos[0]();
    assert.deepEqual(await store.get(saved.id), saved);
    assert.deepEqual(JSON.parse((await adapter.list())[0]), JSON.parse(rawBefore));
    assert.deepEqual(await reh.createRehearsalStore(adapter, clockAndIds()).list("p1"), [saved]);
  });
});
