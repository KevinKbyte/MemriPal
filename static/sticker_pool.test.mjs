// Covers: MEM-045
// Requirement: static/sticker_pool.js (pure, no DOM) is the searchable sticker pool. Base emoji stickers seed it
// (one entry per BASE_STICKERS item, in order, id "emoji:<name>", desc = name + words, created_at SEED_TIME);
// uploadError(file, desc) gives a Pal-voiced message for a missing file, a type outside UPLOAD_TYPES (jpeg, png,
// webp, gif), a size of 0 or over MAX_UPLOAD_BYTES (2 MiB), or a trimmed desc that is empty or over MAX_DESC (60),
// else null. createStickerPool(kv, {now, newId}) stores uploads/generated stickers (desc trimmed, image only a
// raster jpeg/png/webp base64 data URL, so javascript:, svg and https are refused) and one placement per locus of
// a place (place replaces, unplace returns the removed placement or null, restore puts it back for Undo).
// Everything persists in the kv, so a second pool over the same kv (a reload) sees it all.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { BASE_STICKERS } from "./stickers.js";

const mod = await import("./sticker_pool.js").catch((err) => ({ __missing: String(err) }));

function need(name) {
  assert.ok(name in mod, `static/sticker_pool.js must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

const MIB2 = 2 * 1024 * 1024;
const SEED = "1970-01-01T00:00:00.000Z";
const JPEG = "data:image/jpeg;base64,QUJD";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const WEBP = "data:image/webp;base64,UklGRg==";

/** idb_adapter-shaped in-memory kv: get / put / delete / list (list resolves every stored value). */
function memoryKv() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : undefined;
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async list() {
      return [...map.values()].map((v) => structuredClone(v));
    },
  };
}

function counterIds() {
  let i = 0;
  return () => `id-${++i}`;
}

const T1 = "2026-11-04T10:00:00.000Z";

function makePool(kv = memoryKv(), now = () => T1) {
  return { kv, pool: need("createStickerPool")(kv, { now, newId: counterIds() }) };
}

const FIRST_EMOJI_ID = `emoji:${BASE_STICKERS[0].name}`;

// Covers: MEM-045
// Requirement: the pool's limits are exported constants matching the contract.
describe("sticker_pool constants (MEM-045)", () => {
  test("MAX_UPLOAD_BYTES, MAX_DESC, UPLOAD_TYPES, SEED_TIME", () => {
    assert.equal(need("MAX_UPLOAD_BYTES"), MIB2);
    assert.equal(need("MAX_DESC"), 60);
    assert.deepEqual([...need("UPLOAD_TYPES")], ["image/jpeg", "image/png", "image/webp", "image/gif"]);
    assert.equal(need("SEED_TIME"), SEED);
  });
});

// Covers: MEM-045
// Requirement: emoji are the base stickers: one pool entry per BASE_STICKERS item, in that order.
describe("sticker_pool emojiEntries (MEM-045)", () => {
  test("one entry per BASE_STICKERS item, same order, contract shape", () => {
    const entries = need("emojiEntries")();
    assert.equal(entries.length, BASE_STICKERS.length);
    BASE_STICKERS.forEach((s, i) => {
      assert.deepEqual(entries[i], {
        id: `emoji:${s.name}`,
        kind: "emoji",
        desc: [s.name, ...s.words].join(" "),
        image: s.emoji,
        created_at: SEED,
      });
    });
  });

  test("ids are unique", () => {
    const ids = need("emojiEntries")().map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

// Covers: MEM-045
// Requirement: uploadError refuses a missing file, a non-raster or unknown type, an empty or over-2-MiB file and
// an empty or over-60-char description with a user-facing message; a valid upload gives null.
describe("sticker_pool uploadError (MEM-045)", () => {
  const ok = { type: "image/png", size: 1000 };
  const err = (file, desc) => need("uploadError")(file, desc);
  const isMessage = (v, label) => {
    assert.equal(typeof v, "string", `${label}: expected a message, got ${JSON.stringify(v)}`);
    assert.notEqual(v.trim(), "", `${label}: message is empty`);
  };

  test("a valid png with a short desc is accepted", () => {
    assert.equal(err(ok, "a red umbrella"), null);
  });

  test("every UPLOAD_TYPES type is accepted", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "image/gif"]) {
      assert.equal(err({ type, size: 1000 }, "x"), null, type);
    }
  });

  test("size exactly MAX_UPLOAD_BYTES is accepted, one byte more is refused", () => {
    assert.equal(err({ type: "image/jpeg", size: MIB2 }, "big"), null);
    isMessage(err({ type: "image/jpeg", size: MIB2 + 1 }, "big"), "over limit");
  });

  test("a missing file is refused", () => {
    isMessage(err(null, "a red umbrella"), "null file");
    isMessage(err(undefined, "a red umbrella"), "undefined file");
  });

  test("a type outside UPLOAD_TYPES is refused (incl. svg and empty)", () => {
    for (const type of ["text/plain", "image/svg+xml", "", "image/bmp", "IMAGE/PNG"]) {
      isMessage(err({ type, size: 1000 }, "a red umbrella"), `type ${JSON.stringify(type)}`);
    }
    isMessage(err({ size: 1000 }, "a red umbrella"), "no type");
  });

  test("an empty file is refused", () => {
    isMessage(err({ type: "image/png", size: 0 }, "a red umbrella"), "size 0");
  });

  test("desc empty, blank, missing or over 60 chars is refused; 60 chars (trimmed) is accepted", () => {
    isMessage(err(ok, ""), "empty desc");
    isMessage(err(ok, "   "), "blank desc");
    isMessage(err(ok, undefined), "missing desc");
    isMessage(err(ok, "x".repeat(61)), "61-char desc");
    assert.equal(err(ok, "x".repeat(60)), null);
    assert.equal(err(ok, `  ${"x".repeat(60)}  `), null, "length is measured after trim");
  });
});

// Covers: MEM-045
// Requirement: list shows the emoji seeds first, then stored stickers in created_at order.
describe("sticker_pool list (MEM-045)", () => {
  test("a fresh pool lists exactly the emoji entries", async () => {
    const { pool } = makePool();
    assert.deepEqual(await pool.list(), need("emojiEntries")());
  });

  test("stored stickers follow the seeds, sorted by created_at", async () => {
    const times = ["2026-11-04T12:00:00.000Z", "2026-11-04T09:00:00.000Z"];
    const { pool } = makePool(memoryKv(), () => times.shift());
    const later = await pool.add({ kind: "upload", desc: "later", image: JPEG });
    const earlier = await pool.add({ kind: "generated", desc: "earlier", image: PNG });
    const all = await pool.list();
    const seeds = need("emojiEntries")();
    assert.deepEqual(all.slice(0, seeds.length), seeds);
    assert.deepEqual(all.slice(seeds.length).map((e) => e.id), [earlier.id, later.id]);
  });
});

// Covers: MEM-045
// Requirement: add stores an upload/generated sticker with a trimmed desc and a raster data URL image, and refuses
// everything else without storing it.
describe("sticker_pool add (MEM-045)", () => {
  test("stores the entry with newId, trimmed desc and now()", async () => {
    const { pool } = makePool();
    const entry = await pool.add({ kind: "upload", desc: "  kendall umbrella  ", image: JPEG });
    assert.deepEqual(entry, { id: "id-1", kind: "upload", desc: "kendall umbrella", image: JPEG, created_at: T1 });
    assert.deepEqual(await pool.get("id-1"), entry);
  });

  test("generated kind and png / webp images are accepted", async () => {
    const { pool } = makePool();
    assert.equal((await pool.add({ kind: "generated", desc: "a", image: PNG })).kind, "generated");
    assert.equal((await pool.add({ kind: "upload", desc: "b", image: WEBP })).image, WEBP);
  });

  test("a 60-char desc is accepted", async () => {
    const { pool } = makePool();
    const entry = await pool.add({ kind: "upload", desc: "d".repeat(60), image: JPEG });
    assert.equal(entry.desc.length, 60);
  });

  const BAD = [
    ["javascript: url", { kind: "upload", desc: "x", image: "javascript:alert(1)" }],
    ["svg data url", { kind: "upload", desc: "x", image: "data:image/svg+xml;base64,PHN2Zz4=" }],
    ["https url", { kind: "upload", desc: "x", image: "https://example.com/a.png" }],
    ["gif data url (stored stickers are re-encoded rasters)", { kind: "upload", desc: "x", image: "data:image/gif;base64,R0lGOD=" }],
    ["data url with markup after base64", { kind: "upload", desc: "x", image: "data:image/png;base64,QUJD<script>" }],
    ["non-base64 data url", { kind: "upload", desc: "x", image: "data:image/png,QUJD" }],
    ["missing image", { kind: "upload", desc: "x" }],
    ["kind emoji", { kind: "emoji", desc: "x", image: JPEG }],
    ["bogus kind", { kind: "bogus", desc: "x", image: JPEG }],
    ["missing kind", { desc: "x", image: JPEG }],
    ["empty desc", { kind: "upload", desc: "", image: JPEG }],
    ["blank desc", { kind: "upload", desc: "    ", image: JPEG }],
    ["61-char desc", { kind: "upload", desc: "d".repeat(61), image: JPEG }],
    ["non-string desc", { kind: "upload", desc: 42, image: JPEG }],
  ];
  for (const [label, input] of BAD) {
    test(`rejects ${label} and stores nothing`, async () => {
      const { pool } = makePool();
      await assert.rejects(pool.add(input));
      assert.deepEqual(await pool.list(), need("emojiEntries")());
    });
  }
});

// Covers: MEM-045
// Requirement: get finds an emoji or stored sticker by id, null for an unknown id.
describe("sticker_pool get (MEM-045)", () => {
  test("emoji id, stored id, unknown id", async () => {
    const { pool } = makePool();
    const stored = await pool.add({ kind: "upload", desc: "u", image: JPEG });
    assert.deepEqual(await pool.get(FIRST_EMOJI_ID), need("emojiEntries")()[0]);
    assert.deepEqual(await pool.get(stored.id), stored);
    assert.equal(await pool.get("nope"), null);
  });
});

// Covers: MEM-045
// Requirement: place puts one sticker on one locus of a place (re-placing the same locus replaces it) and refuses
// an unknown sticker, a non-positive-integer locus number or an empty place key.
describe("sticker_pool place / placements (MEM-045)", () => {
  test("place returns the placement and placements lists it", async () => {
    const { pool } = makePool();
    const p = await pool.place("demo", 1, FIRST_EMOJI_ID);
    assert.deepEqual(p, { placeKey: "demo", n: 1, stickerId: FIRST_EMOJI_ID, placed_at: T1 });
    assert.deepEqual(await pool.placements("demo"), [p]);
  });

  test("placing again on the same locus replaces the sticker", async () => {
    const { pool } = makePool();
    const up = await pool.add({ kind: "upload", desc: "u", image: JPEG });
    await pool.place("demo", 2, FIRST_EMOJI_ID);
    await pool.place("demo", 2, up.id);
    const list = await pool.placements("demo");
    assert.equal(list.length, 1);
    assert.equal(list[0].stickerId, up.id);
  });

  test("placements are per place and sorted by n", async () => {
    const { pool } = makePool();
    await pool.place("demo", 3, FIRST_EMOJI_ID);
    await pool.place("other", 2, FIRST_EMOJI_ID);
    await pool.place("demo", 1, FIRST_EMOJI_ID);
    assert.deepEqual((await pool.placements("demo")).map((p) => p.n), [1, 3]);
    assert.deepEqual((await pool.placements("other")).map((p) => [p.placeKey, p.n]), [["other", 2]]);
    assert.deepEqual(await pool.placements("empty"), []);
  });

  test("rejects an unknown sticker id", async () => {
    const { pool } = makePool();
    await assert.rejects(pool.place("demo", 1, "nope"));
    assert.deepEqual(await pool.placements("demo"), []);
  });

  for (const n of [0, -1, 1.5, "1", Number.NaN, null]) {
    test(`rejects locus n ${typeof n} ${String(n)}`, async () => {
      const { pool } = makePool();
      await assert.rejects(pool.place("demo", n, FIRST_EMOJI_ID));
      assert.deepEqual(await pool.placements("demo"), []);
    });
  }

  for (const key of ["", 5, null, undefined]) {
    test(`rejects place key ${typeof key} ${JSON.stringify(key) ?? String(key)}`, async () => {
      const { pool } = makePool();
      await assert.rejects(pool.place(key, 1, FIRST_EMOJI_ID));
    });
  }
});

// Covers: MEM-045
// Requirement: unplace removes a locus's sticker and returns the removed placement (null when empty); restore
// puts a removed placement back (Undo).
describe("sticker_pool unplace / restore (MEM-045)", () => {
  test("unplace returns the removed placement, then null", async () => {
    const { pool } = makePool();
    const p = await pool.place("demo", 1, FIRST_EMOJI_ID);
    await pool.place("demo", 2, FIRST_EMOJI_ID);
    assert.deepEqual(await pool.unplace("demo", 1), p);
    assert.deepEqual((await pool.placements("demo")).map((x) => x.n), [2]);
    assert.equal(await pool.unplace("demo", 1), null);
  });

  test("unplace of a never-placed locus or unknown place is null", async () => {
    const { pool } = makePool();
    assert.equal(await pool.unplace("demo", 4), null);
    assert.equal(await pool.unplace("nowhere", 1), null);
  });

  test("restore puts the removed placement back", async () => {
    const { pool } = makePool();
    await pool.place("demo", 1, FIRST_EMOJI_ID);
    const removed = await pool.unplace("demo", 1);
    await pool.restore(removed);
    assert.deepEqual(await pool.placements("demo"), [removed]);
  });
});

// Covers: MEM-045
// Requirement: stickers and placements persist in the kv: a second pool over the same kv (a reload) sees them.
describe("sticker_pool persistence (MEM-045)", () => {
  test("a second pool over the same kv sees entries and placements", async () => {
    const { kv, pool } = makePool();
    const up = await pool.add({ kind: "upload", desc: "kendall", image: JPEG });
    await pool.place("demo", 2, up.id);
    await pool.place("demo", 1, FIRST_EMOJI_ID);
    const again = need("createStickerPool")(kv, { now: () => T1, newId: counterIds() });
    assert.deepEqual(await again.list(), await pool.list());
    assert.deepEqual(await again.get(up.id), up);
    assert.deepEqual(await again.placements("demo"), await pool.placements("demo"));
  });

  test("an unplace persists too", async () => {
    const { kv, pool } = makePool();
    await pool.place("demo", 1, FIRST_EMOJI_ID);
    await pool.unplace("demo", 1);
    const again = need("createStickerPool")(kv, { now: () => T1, newId: counterIds() });
    assert.deepEqual(await again.placements("demo"), []);
  });
});
