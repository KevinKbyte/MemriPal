// Covers: MEM-042
// Requirement: a palace backup is one JSON file {v: 1, palace_id: "demo", route, associations,
// rehearsals} rebuilt from allow-lists; import parses it with JSON.parse, rejects the whole file on a
// cap (I1) or shape (I2) failure, skips only the bad entry on an I3 / I4 / route failure, merges
// additively (an existing entry wins) and round-trips an app-written store.
// Contract (RED; GREEN implements static/palace_export.js, the module flow.js's handlers call):
//   MAX_IMPORT_BYTES = 1048576, MAX_IMPORT_ASSOCIATIONS = 500, MAX_IMPORT_REHEARSALS = 1000.
//   buildBackup({store, rehearsals}) -> Promise<backup object>; rejects when the backup would break
//     an I1 cap (so every exported file imports).
//   importBackup(text, {store, rehearsals}) -> Promise<{imported, skipped}>; rejects (Error, message =
//     reason) on an I1 / I2 failure with nothing written. imported / skipped count association and
//     rehearsal entries; the route is not counted.
//   rehearsals.js exports pointOf.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  FIELDS, POINT, SIG, associationKey, backup, entry, fullRecord, locus, rehearsal, stores, uuid,
} from "./backup_fixtures_test.mjs";

const mod = await import("./palace_export.js").catch((err) => ({ __missing: String(err) }));
const reh = await import("./rehearsals.js");

function api(name) {
  assert.ok(name in mod, `static/palace_export.js must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

const importText = (text, s) => api("importBackup")(text, { store: s.store, rehearsals: s.rehearsals });
const importObj = (obj, s) => importText(JSON.stringify(obj), s);
const written = (s) => s.palaceAdapter.map.size + s.rehAdapter.map.size;

// Covers: MEM-042
// Requirement: I1 caps are named in palace_export.js with the server's limits; pointOf is reused.
describe("MEM-042 I1: named caps", () => {
  test("caps equal the server limits", () => {
    assert.equal(api("MAX_IMPORT_BYTES"), 1048576);
    assert.equal(api("MAX_IMPORT_ASSOCIATIONS"), 500);
    assert.equal(api("MAX_IMPORT_REHEARSALS"), 1000);
  });

  test("rehearsals.js exports pointOf, which whitelists the five point fields", () => {
    assert.equal(typeof reh.pointOf, "function", "rehearsals.js must export pointOf");
    assert.deepEqual(reh.pointOf({ ...POINT, audio: "x" }), POINT);
  });
});

// Covers: MEM-042
// Requirement: E1 export body is {v: 1, palace_id: "demo", route, associations, rehearsals}: the
// stored route ([] when none), every palace value but the route, the demo palace's rehearsals, each
// object rebuilt from its allow-list (no image, no storage key); an empty store exports empty lists.
describe("MEM-042 E1: export format", () => {
  test("empty store exports the empty backup", async () => {
    const s = stores();
    assert.deepEqual(await api("buildBackup")(s), backup());
  });

  test("route, associations and demo rehearsals are exported, rebuilt from allow-lists", async () => {
    const s = stores();
    const route = [locus(1, "lamp"), locus(2, "door")];
    await s.store.saveRoute(route);
    await s.store.put(associationKey("milk", "lamp"), entry("milk", "lamp", { image: "data:image/png;base64,AAAA" }));
    await s.store.put(associationKey("eggs", "door"), { record: fullRecord("eggs", "door"), status: "invalid" });
    const r = await s.rehearsals.save("demo", { transcript: "milk eggs", results: [{ ...POINT, audio: "pcm" }] });
    await s.rehearsals.save("other", { transcript: "elsewhere", results: [] });
    const out = await api("buildBackup")(s);
    assert.deepEqual(Object.keys(out).sort(), ["associations", "palace_id", "rehearsals", "route", "v"]);
    assert.equal(out.v, 1);
    assert.equal(out.palace_id, "demo");
    assert.deepEqual(out.route, route);
    const byItem = Object.fromEntries(out.associations.map((a) => [a.record.item, a]));
    assert.equal(out.associations.length, 2, "the route is not an association");
    assert.deepEqual(byItem.milk, entry("milk", "lamp"), "no image key exported");
    assert.deepEqual(byItem.eggs, { record: fullRecord("eggs", "door"), status: "invalid" });
    assert.deepEqual(out.rehearsals, [{ ...r, points: [POINT] }], "only the demo palace; point rebuilt by pointOf");
    assert.ok(!JSON.stringify(out).includes(associationKey("milk", "lamp")), "no storage key in the file");
  });

  test("export skips entries failing I3, so the file never carries an entry import would skip", async () => {
    const s = stores();
    const failing = {
      "extra record key": { record: fullRecord("a", "lamp", { mood: "x" }), status: "valid" },
      "non-string field": { record: fullRecord("b", "lamp", { visual: 3 }), status: "valid" },
      "item over 100": { record: fullRecord("i".repeat(101), "lamp"), status: "valid" },
      "status pending": { record: fullRecord("c", "lamp"), status: "pending" },
      "sig uppercase": entry("d", "lamp", { sig: "AB".repeat(32) }),
      "record not object": { record: "x", status: "valid" },
    };
    for (const [name, value] of Object.entries(failing)) await s.store.put(`bad ${name}`, value);
    await s.store.put(associationKey("good", "door"), entry("good", "door"));
    const out = await api("buildBackup")(s);
    assert.deepEqual(out.associations, [entry("good", "door")], "only the I3-valid entry is exported");
  });

  test("a store over an I1 cap is refused, so every exported file imports", async () => {
    const many = stores();
    for (let i = 0; i < 501; i++) await many.store.put(associationKey(`item ${i}`, "lamp"), entry(`item ${i}`, "lamp"));
    await assert.rejects(api("buildBackup")(many), "501 associations");

    const big = stores();
    const long = "x".repeat(2000);
    const bigEntry = (i) => ({
      record: fullRecord(`item ${i}`, "lamp", { question: long, answer: long, walk_cue: long, reencode_hint: long }),
      status: "valid",
      sig: SIG,
    });
    // Entry i only grows with i, so count entries of at least entry 0's size exceed the byte cap.
    const count = Math.floor(api("MAX_IMPORT_BYTES") / JSON.stringify(bigEntry(0)).length) + 1;
    assert.ok(count <= api("MAX_IMPORT_ASSOCIATIONS"), "the byte cap, not the count cap, must be what trips");
    for (let i = 0; i < count; i++) await big.store.put(associationKey(`item ${i}`, "lamp"), bigEntry(i));
    await assert.rejects(api("buildBackup")(big), "over MAX_IMPORT_BYTES serialized");
  });
});

// Covers: MEM-042
// Requirement: I1 + I2 failures reject the whole file and write nothing: not JSON (empty file),
// not an object, v !== 1, palace_id !== "demo", a missing or unknown top-level key (incl.
// __proto__), a non-array list, or a list / route / points count over its cap.
describe("MEM-042 I1/I2: whole-file rejection", () => {
  const good = () => backup({ associations: [entry("milk", "lamp")], rehearsals: [rehearsal()] });
  const cases = [
    ["empty file", ""],
    ["not JSON", "{v: 1"],
    ["array top level", "[]"],
    ["null top level", "null"],
    ["v 2", { ...good(), v: 2 }],
    ["v string", { ...good(), v: "1" }],
    ["palace_id other", { ...good(), palace_id: "other" }],
    ["unknown top-level key", { ...good(), extra: 1 }],
    ["missing rehearsals", (() => { const b = good(); delete b.rehearsals; return b; })()],
    ["associations not array", { ...good(), associations: {} }],
    ["route not array", { ...good(), route: null }],
    ["rehearsals not array", { ...good(), rehearsals: "x" }],
    ["501 associations", { ...good(), associations: Array.from({ length: 501 }, (_, i) => entry(`i${i}`, "lamp")) }],
    ["1001 rehearsals", { ...good(), rehearsals: Array.from({ length: 1001 }, () => rehearsal()) }],
    ["13 loci", { ...good(), route: Array.from({ length: 13 }, (_, i) => locus(i + 1, `l${i}`)) }],
    ["13 points", { ...good(), rehearsals: [rehearsal({ points: Array.from({ length: 13 }, () => ({ ...POINT })) })] }],
  ];
  for (const [name, value] of cases) {
    test(`rejects: ${name}`, async () => {
      const s = stores();
      const text = typeof value === "string" ? value : JSON.stringify(value);
      await assert.rejects(importText(text, s), Error);
      assert.equal(written(s), 0, "nothing written");
    });
  }

  test("rejects a top-level __proto__ key", async () => {
    const s = stores();
    const text = JSON.stringify(good()).replace(/^\{/, '{"__proto__":{"polluted":true},');
    await assert.rejects(importText(text, s), Error);
    assert.equal(written(s), 0);
    assert.equal({}.polluted, undefined);
  });

  test("exactly at the caps is accepted", async () => {
    const s = stores();
    const file = backup({
      route: Array.from({ length: 12 }, (_, i) => locus(i + 1, `l${i}`)),
      associations: Array.from({ length: 500 }, (_, i) => entry(`i${i}`, "lamp")),
      rehearsals: [rehearsal({ points: Array.from({ length: 12 }, () => ({ ...POINT })) })],
    });
    assert.deepEqual(await importObj(file, s), { imported: 501, skipped: 0 });
  });
});

// Covers: MEM-042
// Requirement: I3 an association entry is exactly {record, status[, sig]} with a 15-field all-string
// record within the item/locus/scene/field caps, status valid|invalid, sig 64 lowercase hex; any
// failure skips that entry only, an unknown key is never stripped, and the key comes from the record.
describe("MEM-042 I3: association entries", () => {
  const bad = {
    "extra entry key": entry("a", "lamp", { image: "x" }),
    "missing status": { record: fullRecord("a", "lamp") },
    "extra record key": { record: fullRecord("a", "lamp", { mood: "x" }), status: "valid" },
    "missing record field": (() => { const r = fullRecord("a", "lamp"); delete r.walk_cue; return { record: r, status: "valid" }; })(),
    "non-string field": { record: fullRecord("a", "lamp", { visual: 3 }), status: "valid" },
    "blank item": { record: fullRecord("   ", "lamp"), status: "valid" },
    "item over 100": { record: fullRecord("i".repeat(101), "lamp"), status: "valid" },
    "locus over 100": { record: fullRecord("a", "l".repeat(101)), status: "valid" },
    "spatial over 300": { record: fullRecord("a", "lamp", { spatial: "s".repeat(301) }), status: "valid" },
    "answer over 2000": { record: fullRecord("a", "lamp", { answer: "s".repeat(2001) }), status: "valid" },
    "status pending": { record: fullRecord("a", "lamp"), status: "pending" },
    "sig uppercase": entry("a", "lamp", { sig: "AB".repeat(32) }),
    "sig 63 chars": entry("a", "lamp", { sig: "a".repeat(63) }),
    "record not object": { record: "x", status: "valid" },
  };
  for (const [name, value] of Object.entries(bad)) {
    test(`skips: ${name}; the good entry beside it still imports`, async () => {
      const s = stores();
      assert.deepEqual(await importObj(backup({ associations: [value, entry("good", "door")] }), s), { imported: 1, skipped: 1 });
      assert.deepEqual([...s.palaceAdapter.map.keys()], [associationKey("good", "door")], "never stripped and stored");
    });
  }

  test("a __proto__ key in an entry or record skips it and pollutes nothing", async () => {
    const s = stores();
    const text = JSON.stringify(backup({ associations: [entry("a", "lamp"), entry("b", "lamp"), entry("c", "door")] }))
      .replace('{"record":', '{"__proto__":{"polluted":true},"record":')
      .replace('"item":"b"', '"__proto__":{"polluted":true},"item":"b"');
    assert.deepEqual(await importText(text, s), { imported: 1, skipped: 2 });
    assert.equal({}.polluted, undefined);
    assert.deepEqual(await s.store.get(associationKey("c", "door")), entry("c", "door"));
  });

  test("boundaries accepted: item and locus 100 chars trimmed, spatial 300, question 2000, no sig", async () => {
    const s = stores();
    const rec = fullRecord(` ${"i".repeat(100)} `, "l".repeat(100), { spatial: "s".repeat(300), question: "q".repeat(2000) });
    assert.deepEqual(await importObj(backup({ associations: [{ record: rec, status: "invalid" }] }), s), { imported: 1, skipped: 0 });
    assert.deepEqual(await s.store.get(associationKey(rec.item, rec.locus)), { record: rec, status: "invalid" });
  });

  test("stored under associationKey(record.item, record.locus), exactly as in the file", async () => {
    const s = stores();
    await importObj(backup({ associations: [entry("milk", "lamp")] }), s);
    assert.deepEqual([...s.palaceAdapter.map.keys()], [associationKey("milk", "lamp")]);
    const got = await s.store.get(associationKey("milk", "lamp"));
    assert.deepEqual(got, entry("milk", "lamp"));
    assert.deepEqual(Object.keys(got.record).sort(), [...FIELDS].sort());
  });
});

// Covers: MEM-042
// Requirement: I4 a rehearsal is exactly {id, palace_id, timestamp, transcript, points}: lowercase
// UUID id, palace "demo", an ISO timestamp that round-trips, string transcript, array points rebuilt
// by pointOf; any failure skips that rehearsal only; stored so the history store reads it back.
describe("MEM-042 I4: rehearsal entries", () => {
  const bad = {
    "uppercase id": () => rehearsal({ id: uuid().toUpperCase().replace(/0/g, "A") }),
    "non-UUID id": () => rehearsal({ id: "reh-1" }),
    "other palace": () => rehearsal({ palace_id: "other" }),
    "timestamp without millis": () => rehearsal({ timestamp: "2026-10-28T09:00:00Z" }),
    "invalid date timestamp": () => rehearsal({ timestamp: "not a date" }),
    "number timestamp": () => rehearsal({ timestamp: 1761642000000 }),
    "non-string transcript": () => rehearsal({ transcript: 7 }),
    "non-array points": () => rehearsal({ points: { 0: POINT } }),
    "extra key": () => rehearsal({ audio: "pcm" }),
  };
  for (const [name, make] of Object.entries(bad)) {
    test(`skips: ${name}`, async () => {
      const s = stores();
      const ok = rehearsal();
      assert.deepEqual(await importObj(backup({ rehearsals: [make(), ok] }), s), { imported: 1, skipped: 1 });
      assert.deepEqual(await s.rehearsals.list("demo"), [ok]);
    });
  }

  test("points are rebuilt by pointOf; a constructor key skips the rehearsal; nothing is polluted", async () => {
    const s = stores();
    const ok = rehearsal();
    const text = JSON.stringify(backup({ rehearsals: [rehearsal(), ok] }))
      .replace('"transcript"', '"constructor":{"polluted":true},"transcript"')
      .replace('"label":"Lamp point"', '"__proto__":{"polluted":true},"label":"Lamp point","extra":"x"');
    assert.deepEqual(await importText(text, s), { imported: 1, skipped: 1 });
    const [stored] = await s.rehearsals.list("demo");
    assert.equal(stored.id, ok.id);
    assert.deepEqual(stored.points, [POINT]);
    assert.equal({}.polluted, undefined);
  });
});

// Covers: MEM-042
// Requirement: Route: each locus exactly {n, label, phrase, box {x1, y1, x2, y2}, outline [[x, y]]}
// with an integer n, string label/phrase and finite coordinates, else the route alone is skipped.
describe("MEM-042 Route", () => {
  test("a valid route is stored and reads back equal", async () => {
    const s = stores();
    const route = [locus(1, "lamp"), locus(2, "door")];
    await importObj(backup({ route }), s);
    assert.deepEqual(await s.store.loadRoute(), route);
  });

  const bad = {
    "extra locus key": { ...locus(1, "lamp"), image: "x" },
    "missing phrase": (() => { const l = locus(1, "lamp"); delete l.phrase; return l; })(),
    "non-integer n": { ...locus(1, "lamp"), n: 1.5 },
    "string coordinate": { ...locus(1, "lamp"), box: { x1: "1", y1: 2, x2: 3, y2: 4 } },
    "extra box key": { ...locus(1, "lamp"), box: { x1: 1, y1: 2, x2: 3, y2: 4, z: 5 } },
    "outline point not a pair": { ...locus(1, "lamp"), outline: [[1, 2, 3]] },
    "non-number outline": { ...locus(1, "lamp"), outline: [[1, "2"]] },
  };
  for (const [name, bad1] of Object.entries(bad)) {
    test(`skips the route: ${name}; associations still import`, async () => {
      const s = stores();
      const res = await importObj(backup({ route: [locus(2, "door"), bad1], associations: [entry("milk", "door")] }), s);
      assert.equal(res.imported, 1);
      assert.equal(await s.store.loadRoute(), null, "route skipped");
    });
  }
});

// Covers: MEM-042
// Requirement: I5 merge is additive: an existing association (by key), rehearsal (by id) or route
// wins and is never overwritten or deleted; skipped counts include existing and invalid entries.
describe("MEM-042 I5: additive merge", () => {
  test("existing entries win; only new ones are written", async () => {
    const s = stores();
    const mine = { record: fullRecord("milk", "lamp", { answer: "mine" }), status: "valid", sig: SIG };
    await s.store.put(associationKey("milk", "lamp"), mine);
    const myRun = await s.rehearsals.save("demo", { transcript: "mine", results: [POINT] });
    const myRoute = [locus(1, "lamp")];
    await s.store.saveRoute(myRoute);
    const newRun = rehearsal();
    const file = backup({
      route: [locus(1, "lamp"), locus(2, "door")],
      associations: [entry("milk", "lamp"), entry("eggs", "door"), { record: "bad", status: "valid" }],
      rehearsals: [{ ...myRun, transcript: "theirs" }, newRun],
    });
    assert.deepEqual(await importObj(file, s), { imported: 2, skipped: 3 });
    assert.deepEqual(await s.store.get(associationKey("milk", "lamp")), mine);
    assert.deepEqual(await s.store.get(associationKey("eggs", "door")), entry("eggs", "door"));
    assert.deepEqual(await s.store.loadRoute(), myRoute, "existing route wins");
    assert.deepEqual((await s.rehearsals.get(myRun.id)).transcript, "mine");
    assert.deepEqual(await s.rehearsals.get(newRun.id), newRun);
  });

  test("duplicates inside one file: the first wins, the second is skipped", async () => {
    const s = stores();
    const r = rehearsal();
    const file = backup({ associations: [entry("a", "lamp"), entry("a", "lamp", { status: "invalid" })], rehearsals: [r, { ...r, transcript: "dup" }] });
    assert.deepEqual(await importObj(file, s), { imported: 2, skipped: 2 });
    assert.equal((await s.store.get(associationKey("a", "lamp"))).status, "valid");
    assert.equal((await s.rehearsals.get(r.id)).transcript, r.transcript);
  });
});

// Covers: MEM-042
// Requirement: R1 export of an app-written store imported into an empty store gives equal
// associations (by key), route and rehearsals; importing the same file again imports 0.
describe("MEM-042 R1: round trip", () => {
  test("export -> import into empty -> equal; re-import -> imported 0, skipped all", async () => {
    const src = stores();
    await src.store.saveRoute([locus(1, "lamp"), locus(2, "door")]);
    await src.store.put(associationKey("milk", "lamp"), entry("milk", "lamp"));
    await src.store.put(associationKey("eggs", "door"), { record: fullRecord("eggs", "door"), status: "invalid" });
    await src.rehearsals.save("demo", { transcript: "milk", results: [POINT, { ...POINT, got: false, span: null }] });
    await src.rehearsals.save("demo", { transcript: "eggs", results: [] });
    const text = JSON.stringify(await api("buildBackup")(src));

    const dst = stores();
    assert.deepEqual(await importText(text, dst), { imported: 4, skipped: 0 });
    assert.deepEqual(new Map([...dst.palaceAdapter.map].sort()), new Map([...src.palaceAdapter.map].sort()));
    assert.deepEqual(await dst.store.loadRoute(), await src.store.loadRoute());
    assert.deepEqual(await dst.rehearsals.list("demo"), await src.rehearsals.list("demo"));
    assert.deepEqual(await importText(text, dst), { imported: 0, skipped: 4 });
  });
});

// Covers: MEM-042
// Requirement: I4 a hostile point inside a rehearsal (a label or source_quote that is not a string
// and cannot be turned into one: {"toString": 1}, [{"toString": 1}], or a 20000-deep nested array)
// skips that rehearsal only: importBackup still resolves {imported, skipped}, never throws, and the
// associations and the other rehearsals in the file are all imported.
describe("MEM-042 I4: hostile rehearsal points are skipped, never thrown", () => {
  const MARK = "@@HOSTILE@@";
  const hostile = {
    "label {toString: 1}": ["label", '{"toString":1}'],
    "source_quote [{toString: 1}]": ["source_quote", '[{"toString":1}]'],
    "label nested 20000 arrays deep": ["label", `${"[".repeat(20000)}${"]".repeat(20000)}`],
  };
  for (const [name, [field, json]] of Object.entries(hostile)) {
    test(`skips: ${name}; the rest of the file imports`, async () => {
      const s = stores();
      const before = rehearsal();
      const bad = rehearsal({ points: [{ ...POINT, [field]: MARK }] });
      const after = rehearsal();
      const file = backup({ associations: [entry("milk", "lamp")], rehearsals: [before, bad, after] });
      const text = JSON.stringify(file).replace(`"${MARK}"`, json);
      let res;
      await assert.doesNotReject(async () => { res = await importText(text, s); }, "importBackup must not throw");
      assert.deepEqual(res, { imported: 3, skipped: 1 });
      assert.deepEqual(await s.store.get(associationKey("milk", "lamp")), entry("milk", "lamp"));
      assert.deepEqual(await s.rehearsals.list("demo"), [before, after], "only the hostile rehearsal is skipped");
      assert.equal(await s.rehearsals.get(bad.id), null);
    });
  }
});

// Covers: MEM-042
// Requirement: I3 + I7 an imported entry claiming status "valid" with no sig can never reach /scenes
// (scenes.js reports it "unsigned" and no 403 ever demotes it), so it is stored with status
// "invalid" (record kept) and the next run regenerates a signed record; a signed "valid" entry and
// an unsigned "invalid" entry are stored as in the file.
describe("MEM-042 I3: unsigned valid entries import as invalid", () => {
  test("{record, status: 'valid'} without sig is stored as {record, status: 'invalid'}", async () => {
    const s = stores();
    const unsigned = { record: fullRecord("milk", "lamp"), status: "valid" };
    const file = backup({ associations: [unsigned, entry("eggs", "door"), { record: fullRecord("jam", "rug"), status: "invalid" }] });
    assert.deepEqual(await importObj(file, s), { imported: 3, skipped: 0 });
    assert.deepEqual(await s.store.get(associationKey("milk", "lamp")), { record: fullRecord("milk", "lamp"), status: "invalid" });
    assert.deepEqual(await s.store.get(associationKey("eggs", "door")), entry("eggs", "door"), "signed valid entry unchanged");
    assert.deepEqual(await s.store.get(associationKey("jam", "rug")), { record: fullRecord("jam", "rug"), status: "invalid" });
  });
});
