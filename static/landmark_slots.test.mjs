// Covers: MEM-141
// Requirement: SAM 3.1 segments an uploaded landmark photo (POST /loci, unchanged) into 3 Payoff slots the
// user fills by tap or drag. parseSegmentation accepts only a well-formed /loci reply with a safe image
// data URL; pickSlots keeps 3 slots (bad boxes and duplicate labels dropped, renumbered by y1 then x1);
// segmentLandmark never rejects and falls back live -> cached -> sample -> null; placePart is pure, one
// part per slot and one slot per part; createSlotBoard renders photo, slot shapes, source badge, rows and
// chips with every label as text, never HTML.
// Contract assumed beyond the spec (implementer follows these):
//   - placements are a plain object {partId: n}; an unplaced part has NO key.
//   - each .slot-row carries data-n like its .slot-shape.
//   - wireDrag(chipEl, {onDrop(clientX, clientY)}) is called once per .payoff-chip by show().
//   - nearestBox(boxes, x, y) gets the slot boxes in result.slots order and photo-px x/y; it returns an
//     index into result.slots (or -1 for none).
//   - the cached entry is JSON in storage.getItem("memripal.slots.<landmarkId>").
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakePage, find, findAll, jsonResponse } from "./fake_dom_test.mjs";
import {
  PAYOFF_PARTS,
  SLOT_COUNT,
  parseSegmentation,
  pickSlots,
  segmentLandmark,
  placePart,
  createSlotBoard,
} from "./landmark_slots.js";

const IMG = "data:image/jpeg;base64,/9j/AAAA";

function locus(label, x1, y1, x2, y2, outline) {
  return {
    n: 0,
    label,
    phrase: label,
    box: { x1, y1, x2, y2 },
    outline: outline ?? [
      [x1, y1],
      [x2, y1],
      [x2, y2],
    ],
  };
}

function reply(loci, extra = {}) {
  return { image: IMG, width: 400, height: 300, photo_sha: "abc", reask_used: false, loci, ...extra };
}

const THREE = () => [locus("door", 0, 100, 100, 200), locus("sign", 200, 0, 300, 90), locus("bench", 10, 210, 110, 290)];

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

function urlOf(u) {
  return typeof u === "string" ? u : u && typeof u.url === "string" ? u.url : String(u);
}

/** Fake fetch routing /loci vs fixtureUrl; a "hang" handler never resolves unless the signal aborts. */
function fakeFetch({ loci, fixture }) {
  const calls = [];
  const fn = (url, init = {}) => {
    const u = urlOf(url);
    calls.push(u);
    const h = u.endsWith("/loci") ? loci : u === FIXTURE_URL ? fixture : null;
    if (h === "hang") {
      return new Promise((_, reject) => {
        init.signal?.addEventListener?.("abort", () => reject(new Error("aborted")));
      });
    }
    if (h === "network") return Promise.reject(new TypeError("network"));
    if (typeof h === "function") return Promise.resolve(h());
    return Promise.resolve(new Response("nope", { status: 404 }));
  };
  fn.calls = calls;
  return fn;
}

const FIXTURE_URL = "./fixtures/landmark_slots_kendall.json";
const FILE = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
const KEY = "memripal.slots.kendall";

function seg(fetch, storage) {
  return segmentLandmark({ fetch, file: FILE, storage, landmarkId: "kendall", fixtureUrl: FIXTURE_URL, timeoutMs: 20 });
}

function hasClass(n, c) {
  if (!n || typeof n !== "object") return false;
  const names = `${n.className ?? ""} ${n.getAttribute?.("class") ?? ""}`.split(/\s+/);
  return n.classList?.contains(c) || names.includes(c);
}

describe("landmark slots (MEM-141)", () => {
  test("exports the 3 Payoff parts and SLOT_COUNT 3", () => {
    assert.equal(SLOT_COUNT, 3);
    assert.deepEqual(
      PAYOFF_PARTS.map((p) => p.id),
      ["resolve", "useful", "memorable"],
    );
  });

  describe("parseSegmentation", () => {
    test("accepts a valid /loci reply", () => {
      const r = parseSegmentation(reply(THREE()));
      assert.ok(r);
      assert.equal(r.image, IMG);
      assert.equal(r.width, 400);
      assert.equal(r.height, 300);
      assert.equal(r.loci.length, 3);
    });

    test("rejects an unsafe image prefix", () => {
      for (const image of ["javascript:alert(1)", "data:text/html;base64,PGI+", "data:image/svg+xml;base64,AA"]) {
        assert.equal(parseSegmentation(reply(THREE(), { image })), null, image);
      }
    });

    test("rejects non-array loci and bad dimensions", () => {
      assert.equal(parseSegmentation(reply({ length: 3 })), null);
      assert.equal(parseSegmentation(reply(THREE(), { width: 0 })), null);
      assert.equal(parseSegmentation(reply(THREE(), { height: Number.NaN })), null);
      assert.equal(parseSegmentation(null), null);
    });
  });

  describe("pickSlots", () => {
    test(">= 3 loci yield 3 slots, top 3 by area, renumbered by y1 then x1", () => {
      const loci = [
        locus("tiny", 0, 0, 5, 5),
        locus("bench", 10, 200, 110, 290),
        locus("sign", 200, 0, 300, 90),
        locus("door", 0, 0, 100, 100),
      ];
      const slots = pickSlots(loci, 3);
      assert.deepEqual(
        slots.map((s) => [s.n, s.label]),
        [
          [1, "door"],
          [2, "sign"],
          [3, "bench"],
        ],
      );
    });

    test("duplicate label (case-insensitive) keeps the largest box", () => {
      const slots = pickSlots([locus("Door", 0, 0, 10, 10), locus("door", 0, 100, 200, 200), ...THREE().slice(1)], 3);
      const doors = slots.filter((s) => s.label.toLowerCase() === "door");
      assert.equal(doors.length, 1);
      assert.deepEqual(doors[0].box, { x1: 0, y1: 100, x2: 200, y2: 200 });
    });

    test("zero, negative, NaN and missing boxes are dropped", () => {
      const bad = [
        locus("zero", 10, 10, 10, 50),
        locus("neg", 50, 50, 20, 80),
        locus("nan", Number.NaN, 0, 10, 10),
        { n: 9, label: "nobox", outline: [] },
      ];
      const slots = pickSlots([...bad, ...THREE()], 3);
      assert.deepEqual(slots.map((s) => s.label).sort(), ["bench", "door", "sign"]);
    });

    test("outline with < 3 points is replaced by the box rectangle; a good outline is kept", () => {
      const loci = THREE();
      loci[0].outline = [
        [0, 100],
        [100, 200],
      ];
      const slots = pickSlots(loci, 3);
      const door = slots.find((s) => s.label === "door");
      const key = (p) => p.join(",");
      assert.deepEqual(door.outline.map(key).sort(), ["0,100", "0,200", "100,100", "100,200"]);
      const sign = slots.find((s) => s.label === "sign");
      assert.deepEqual(sign.outline, loci[1].outline);
    });

    test("never mutates its input", () => {
      const loci = THREE();
      const before = structuredClone(loci);
      pickSlots(loci, 3);
      assert.deepEqual(loci, before);
    });
  });

  describe("segmentLandmark", () => {
    test("live 200 -> source live, cached under memripal.slots.<landmarkId>; then live 500 -> cached", async () => {
      const storage = memStorage();
      const live = await seg(fakeFetch({ loci: () => jsonResponse(reply(THREE())) }), storage);
      assert.equal(live.source, "live");
      assert.equal(live.image, IMG);
      assert.equal(live.slots.length, 3);
      assert.ok(storage.getItem(KEY), "cached entry written");
      assert.ok(JSON.parse(storage.getItem(KEY)));

      const f = fakeFetch({ loci: () => new Response("boom", { status: 500 }) });
      const cached = await seg(f, storage);
      assert.equal(cached.source, "cached");
      assert.deepEqual(cached.slots, live.slots);
      assert.ok(f.calls.some((u) => u.endsWith("/loci")));
    });

    test("empty storage + live 500 -> sample from fixtureUrl", async () => {
      const f = fakeFetch({ loci: () => new Response("boom", { status: 500 }), fixture: () => jsonResponse(reply(THREE())) });
      const r = await seg(f, memStorage());
      assert.equal(r.source, "sample");
      assert.equal(r.slots.length, 3);
      assert.ok(f.calls.includes(FIXTURE_URL));
    });

    test("bad JSON, too few slots and network error each fall back", async () => {
      for (const loci of [
        () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
        () => jsonResponse(reply(THREE().slice(0, 2))),
        "network",
      ]) {
        const r = await seg(fakeFetch({ loci, fixture: () => jsonResponse(reply(THREE())) }), memStorage());
        assert.equal(r?.source, "sample");
      }
    });

    test("timeout (fetch never resolves) falls back", async () => {
      const r = await seg(fakeFetch({ loci: "hang", fixture: () => jsonResponse(reply(THREE())) }), memStorage());
      assert.equal(r?.source, "sample");
    });

    test("everything failing -> null, never rejects", async () => {
      const r = await seg(fakeFetch({ loci: "network", fixture: "network" }), memStorage());
      assert.equal(r, null);
      const r2 = await seg(fakeFetch({ loci: () => new Response("x", { status: 503 }) }), memStorage());
      assert.equal(r2, null);
    });
  });

  test("bundled fixture is a /loci reply that yields 3 slots", () => {
    const raw = JSON.parse(readFileSync(new URL("./fixtures/landmark_slots_kendall.json", import.meta.url), "utf8"));
    const parsed = parseSegmentation(raw);
    assert.ok(parsed);
    assert.equal(pickSlots(parsed.loci, SLOT_COUNT).length, 3);
  });

  describe("placePart (placements = plain object {partId: n}; unplaced = no key)", () => {
    test("places into an empty slot", () => {
      assert.deepEqual(placePart({}, "resolve", 1), { resolve: 1 });
    });

    test("moving a part frees its old slot", () => {
      assert.deepEqual(placePart({ resolve: 1 }, "resolve", 2), { resolve: 2 });
    });

    test("placing into an occupied slot swaps with the mover's old slot", () => {
      assert.deepEqual(placePart({ resolve: 1, useful: 2 }, "resolve", 2), { resolve: 2, useful: 1 });
    });

    test("an unplaced mover displaces the occupant to unplaced", () => {
      assert.deepEqual(placePart({ useful: 2, memorable: 3 }, "resolve", 2), { resolve: 2, memorable: 3 });
    });

    test("never mutates its input", () => {
      const p = Object.freeze({ resolve: 1, useful: 2 });
      placePart(p, "resolve", 2);
      assert.deepEqual(p, { resolve: 1, useful: 2 });
    });
  });

  describe("createSlotBoard", () => {
    const slotsOf = (labels) =>
      labels.map((label, i) => ({
        n: i + 1,
        label,
        box: { x1: i * 100, y1: 0, x2: i * 100 + 90, y2: 90 },
        outline: [
          [i * 100, 0],
          [i * 100 + 90, 0],
          [i * 100 + 90, 90],
        ],
      }));
    const result = (source, labels = ["door", "sign", "bench"]) => ({
      source,
      image: IMG,
      width: 400,
      height: 200,
      slots: slotsOf(labels),
    });

    function board(extra = {}) {
      const page = fakePage(["slots"]);
      const root = page.els.slots;
      const b = createSlotBoard({ doc: page.doc, root, parts: PAYOFF_PARTS, ...extra });
      return { page, root, b };
    }
    const chips = (root) => findAll(root, (n) => hasClass(n, "payoff-chip"));
    const chipFor = (root, label) => chips(root).find((c) => c.textContent.includes(label));
    const shapeN = (root, n) => find(root, (e) => hasClass(e, "slot-shape") && e.dataset.n === String(n));
    const rowN = (root, n) => find(root, (e) => hasClass(e, "slot-row") && e.dataset.n === String(n));

    test("show renders img, 3 slot shapes with data-n, 3 rows, 3 chips", () => {
      const { root, b } = board();
      b.show(result("live"));
      assert.ok(find(root, (e) => e.tagName === "IMG" && e.src === IMG));
      const shapes = findAll(root, (e) => hasClass(e, "slot-shape"));
      assert.deepEqual(
        shapes.map((s) => s.dataset.n),
        ["1", "2", "3"],
      );
      assert.equal(findAll(root, (e) => hasClass(e, "slot-row")).length, 3);
      assert.equal(chips(root).length, 3);
    });

    test("source badge text per source", () => {
      for (const [source, text] of [
        ["live", "Live SAM 3.1"],
        ["cached", "Cached SAM 3.1"],
        ["sample", "Sample photo"],
      ]) {
        const { root, b } = board();
        b.show(result(source));
        assert.ok(find(root, (e) => e.textContent === text), `${source} badge`);
      }
    });

    test("tap a chip then tap a slot places the part", () => {
      const { page, root, b } = board();
      b.show(result("live"));
      const chip = chipFor(root, "Resolve the question");
      page.fire(chip, "click");
      assert.equal(chip.getAttribute("aria-pressed"), "true");
      page.fire(shapeN(root, 2), "click");
      assert.deepEqual(b.placements(), { resolve: 2 });
      assert.ok(rowN(root, 2).textContent.includes("Resolve the question"));
    });

    test("drag drop maps client px to photo px and places in nearestBox's slot", () => {
      const drops = new Map();
      const calls = [];
      const { page, root, b } = board({
        wireDrag: (el, opts) => drops.set(el, opts.onDrop),
        nearestBox: (...args) => {
          calls.push(args);
          return 1;
        },
      });
      page.layout.rectOf = (el) =>
        el.tagName === "IMG" ? { left: 10, top: 20, x: 10, y: 20, width: 200, height: 100, right: 210, bottom: 120 } : {};
      const r = result("live");
      b.show(r);
      const chip = chipFor(root, "Something useful");
      assert.ok(drops.has(chip), "wireDrag called for the chip");
      drops.get(chip)(110, 70);
      assert.equal(calls.length, 1);
      assert.deepEqual(
        calls[0].filter((a) => typeof a === "number"),
        [200, 100],
      );
      assert.deepEqual(b.placements(), { useful: r.slots[1].n });
    });

    test("hostile label renders as text, no HTML writes", () => {
      const evil = "<img src=x onerror=alert(1)>";
      const { page, root, b } = board();
      b.show(result("live", [evil, "sign", "bench"]));
      assert.ok(find(root, (e) => e.textContent.includes(evil)));
      assert.deepEqual(page.htmlWrites, []);
    });
  });
});
