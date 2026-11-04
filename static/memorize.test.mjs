// Covers: MEM-087
// Requirement: Memorize breaks pasted notes into keywords, places one per station of a route and says
// which route fits (ADR 0048, plan S5). The notes go through the existing /split notes mode (one call);
// an edited keyword list is re-split on the phone with split_list's rules (one point per non-blank
// stripped line, at most min(12, stations), lines <= 100 chars, text <= 4096 UTF-8 bytes) and makes 0
// model calls; each (keyword, station) pair gets one /associate call; mnemonics are built on the phone
// (0 calls). The route recommendation is deterministic: only routes with free stations >= keyword count
// (a route with an active list has none free), scored by Jaccard of item tokens against the route's
// name and list names, ties to the tightest fit, then the name; it always carries a reason. A Memorize
// item is stored under KV key list:<id> and travels in the backup's lists[] (backup_routes.js), round-
// tripping unchanged. The Deconstruct checkboxes (keywords, mnemonics, associations) encode the data
// dependency: checking a dependent auto-checks keywords; keywords cannot be unchecked while a dependent
// is checked, and the locked box says why. A whole Deconstruct run against a fixture-mode server makes
// only same-origin /split + /associate requests (which the server replays), never any other call.
// Contract (RED; GREEN adds static/memorize.js and two exports to static/backup_routes.js):
//   memorize.js:
//     splitNotes({text, lociCount, photo?}, {fetch}) -> Promise<[{label, source_quote}]>
//       one POST /split {photo: plain base64 JPEG (sentinel when omitted), mode: "notes", text, loci_count};
//       rejects Error(<server error code>) on a non-ok reply, Error("bad_response") on a bad body.
//     splitList(text, lociCount) -> [{label, source_quote}]; throws Error(code), codes as split.py.
//     associateKeywords(keywords, stations, {fetch}) -> Promise<{[station_id]: {record, sig}}>
//       keyword i -> stations[i]; one POST /associate {image: data:image/jpeg;base64,..., item, locus};
//       an "invalid" reply leaves that station out.
//     mnemonics(keywords) -> {acronym, chain}
//     recommendRoute({title, text, keywords}, routes) -> {routeId, reason} | null
//     saveMemorizeItem(kv, item) -> Promise<void>   (kv = route_store.js KvAdapter; key "list:<id>")
//     toggleDeconstruct(state, box) -> state; deconstructView(state) -> {[box]: {checked, disabled, reason}}
//       state = {keywords, mnemonics, associations} booleans; reason null unless disabled.
//   backup_routes.js: exportLists(items) -> lists[]; importLists(lists) -> items (throws on a bad item).
import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";

import { exportLists, importLists } from "./backup_routes.js";
import { DEMO_ROUTE } from "./demo_route.js";
import {
  associateKeywords,
  deconstructView,
  mnemonics,
  recommendRoute,
  saveMemorizeItem,
  splitList,
  splitNotes,
  toggleDeconstruct,
} from "./memorize.js";
import { memoryAdapter } from "./route_store_fakes_test.mjs";

// The demo content (plan "Demo content (Kev)"): the 6 evidence-based study techniques.
const TECHNIQUES_TEXT = [
  "Six study techniques that work.",
  "Retrieval practice: close the book and pull the facts out of memory.",
  "Spaced practice: spread your study sessions out over days and weeks.",
  "Interleaving: mix different topics and problem types in one session.",
  "Elaboration: ask how and why, and connect new ideas to what you know.",
  "Concrete examples: tie every abstract idea to a specific case.",
  "Dual coding: pair words with pictures, diagrams or timelines.",
].join("\n");

const KEYWORDS = [
  { label: "Retrieval practice", source_quote: "Retrieval practice: close the book" },
  { label: "Spaced practice", source_quote: "Spaced practice: spread your study sessions" },
  { label: "Interleaving", source_quote: "Interleaving: mix different topics" },
  { label: "Elaboration", source_quote: "Elaboration: ask how and why" },
  { label: "Concrete examples", source_quote: "Concrete examples: tie every abstract idea" },
  { label: "Dual coding", source_quote: "Dual coding: pair words with pictures" },
];

const ITEM = { title: "6 study techniques", text: TECHNIQUES_TEXT, keywords: KEYWORDS };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIG = "ab".repeat(32);

/** A full association record (associate.py FIELDS, gustatory optional) for one pair. */
function record(item, locus) {
  return {
    item, locus,
    kinesthetic: "k", auditory: "a", visual: "v", emotional: "e", conceptual: "c", olfactory: "o", spatial: "s",
    scene_prompt_details: "d", walk_cue: "w", reencode_hint: "r", question: "q", answer: "x",
  };
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Counting fake fetch standing in for a fixture-mode server: replays /split with the 6 keywords and
 * /associate with a signed record, unless `invalidItems` names an item to answer "invalid" for.
 */
function countingFetch({ split = () => json(200, { points: KEYWORDS }), invalidItems = [] } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url: String(url), method: init.method, body });
    if (String(url) === "/split") return split(body);
    if (String(url) === "/associate") {
      if (invalidItems.includes(body.item)) {
        return json(200, { item: body.item, locus: body.locus, status: "invalid", attempts: 3, record: record(body.item, body.locus) });
      }
      return json(200, { item: body.item, locus: body.locus, status: "valid", attempts: 1, record: record(body.item, body.locus), sig: SIG });
    }
    return json(404, { error: "not_found" });
  };
  return { fetch, calls };
}

/** A saved route with `count` named stations and the given lists. */
function route(id, name, count, lists = []) {
  const stations = Array.from({ length: count }, (_, i) => ({
    id: `${id.slice(0, 8)}-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    n: i + 1, name: `Stop ${i + 1}`, photo_ref: `p${i}`, status: "named",
  }));
  return { id, name, kind: "daily", status: "saved", created_at: "2026-11-03T12:00:00.000Z", stations, lists };
}

const RID = (d) => `${String(d).repeat(8)}-1111-4111-8111-111111111111`;
const LID = (d) => `${String(d).repeat(8)}-2222-4222-8222-222222222222`;

describe("splitNotes: /split notes mode client", () => {
  test("the 6-technique notes become the 6 technique keywords with exactly one /split call", async () => {
    const { fetch, calls } = countingFetch();
    const keywords = await splitNotes({ text: TECHNIQUES_TEXT, lociCount: 6 }, { fetch });
    assert.deepEqual(keywords, KEYWORDS);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/split");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body.mode, "notes");
    assert.equal(calls[0].body.text, TECHNIQUES_TEXT);
    assert.equal(calls[0].body.loci_count, 6);
  });

  test("a photo-less route sends a sentinel JPEG as plain base64 (ADR 0019, no data: prefix)", async () => {
    const { fetch, calls } = countingFetch();
    await splitNotes({ text: TECHNIQUES_TEXT, lociCount: 6 }, { fetch });
    const photo = calls[0].body.photo;
    assert.equal(typeof photo, "string");
    assert.match(photo, /^[A-Za-z0-9+/]+={0,2}$/);
    const bytes = Buffer.from(photo, "base64");
    assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8], "sentinel is not a JPEG");
  });

  test("a given photo is sent as is", async () => {
    const { fetch, calls } = countingFetch();
    await splitNotes({ text: TECHNIQUES_TEXT, lociCount: 6, photo: "/9j/AAAA" }, { fetch });
    assert.equal(calls[0].body.photo, "/9j/AAAA");
  });

  test("extra keys in a reply point are dropped", async () => {
    const { fetch } = countingFetch({ split: () => json(200, { points: KEYWORDS.map((k) => ({ ...k, extra: 1 })) }) });
    assert.deepEqual(await splitNotes({ text: TECHNIQUES_TEXT, lociCount: 6 }, { fetch }), KEYWORDS);
  });

  test("a non-ok reply rejects with the server's error code", async () => {
    const { fetch } = countingFetch({ split: () => json(404, { error: "fixture_missing" }) });
    await assert.rejects(splitNotes({ text: TECHNIQUES_TEXT, lociCount: 6 }, { fetch }), { message: "fixture_missing" });
  });

  test("a reply without a points array rejects with bad_response", async () => {
    for (const body of [{ points: "x" }, {}, null]) {
      const { fetch } = countingFetch({ split: () => json(200, body) });
      await assert.rejects(splitNotes({ text: TECHNIQUES_TEXT, lociCount: 6 }, { fetch }), { message: "bad_response" });
    }
  });
});

describe("splitList: an edited keyword list re-splits on the phone (split_list semantics, 0 calls)", () => {
  test("one point per non-blank stripped line, order kept, label = source_quote, no fetch at all", (t) => {
    const globalFetch = t.mock.method(globalThis, "fetch", async () => json(500, {}));
    const points = splitList("  Retrieval practice \n\n\tSpaced practice\r\nInterleaving\n   \n", 6);
    assert.deepEqual(points, [
      { label: "Retrieval practice", source_quote: "Retrieval practice" },
      { label: "Spaced practice", source_quote: "Spaced practice" },
      { label: "Interleaving", source_quote: "Interleaving" },
    ]);
    assert.equal(globalFetch.mock.callCount(), 0);
  });

  test("no non-blank line -> no_items", () => {
    for (const text of ["", "   ", "\n \n\t\n"]) assert.throws(() => splitList(text, 6), { message: "no_items" });
  });

  test("a 100-char line is kept; 101 chars -> item_too_long", () => {
    assert.equal(splitList("a".repeat(100), 6)[0].label, "a".repeat(100));
    assert.throws(() => splitList("ok\n" + "a".repeat(101), 6), { message: "item_too_long" });
  });

  test("more lines than stations -> too_many_items; equal is fine", () => {
    const lines = (n) => Array.from({ length: n }, (_, i) => `item ${i + 1}`).join("\n");
    assert.equal(splitList(lines(6), 6).length, 6);
    assert.throws(() => splitList(lines(7), 6), { message: "too_many_items" });
  });

  test("never more than 12 points, however many stations", () => {
    const lines = (n) => Array.from({ length: n }, (_, i) => `item ${i + 1}`).join("\n");
    assert.equal(splitList(lines(12), 20).length, 12);
    assert.throws(() => splitList(lines(13), 20), { message: "too_many_items" });
  });

  test("over 4096 UTF-8 bytes -> list_too_large, checked first and counted in bytes, not chars", () => {
    // 4096 bytes is not over the cap, so the one long line fails on its length instead.
    assert.throws(() => splitList("a".repeat(4096), 6), { message: "item_too_long" });
    assert.throws(() => splitList("a".repeat(4097), 6), { message: "list_too_large" });
    // 2049 two-byte chars = 4098 bytes, under 4096 chars.
    assert.throws(() => splitList(String.fromCharCode(0xe9).repeat(2049), 6), { message: "list_too_large" });
  });
});

describe("associateKeywords: one /associate per (keyword, station)", () => {
  test("keyword i goes to station i, one POST each in order, placements keyed by station id", async () => {
    const { fetch, calls } = countingFetch();
    const placements = await associateKeywords(KEYWORDS, DEMO_ROUTE.stations, { fetch });
    assert.equal(calls.length, 6);
    calls.forEach((c, i) => {
      assert.equal(c.url, "/associate");
      assert.equal(c.method, "POST");
      assert.equal(c.body.item, KEYWORDS[i].label);
      assert.equal(c.body.locus, DEMO_ROUTE.stations[i].name);
      assert.ok(c.body.image.startsWith("data:image/jpeg;base64,"), "image is not a JPEG data URL");
    });
    assert.deepEqual(Object.keys(placements).sort(), DEMO_ROUTE.stations.map((s) => s.id).sort());
    DEMO_ROUTE.stations.forEach((s, i) => {
      assert.deepEqual(placements[s.id], { record: record(KEYWORDS[i].label, s.name), sig: SIG });
    });
  });

  test("an invalid association leaves its station out; the others still land", async () => {
    const { fetch, calls } = countingFetch({ invalidItems: ["Interleaving"] });
    const placements = await associateKeywords(KEYWORDS, DEMO_ROUTE.stations, { fetch });
    assert.equal(calls.length, 6);
    assert.equal(placements[DEMO_ROUTE.stations[2].id], undefined);
    assert.equal(Object.keys(placements).length, 5);
  });

  // Requirement: every /associate carries the station's context (ADR 0048 "Station context in the
  // prompt") as exactly {name, profile, taps}; a missing profile or taps is sent as {}, and no other
  // station key (id, n, photo, coords, address) leaves the phone.
  test("a station without profile or taps sends station {name, profile: {}, taps: {}}", async () => {
    const { fetch, calls } = countingFetch();
    await associateKeywords(KEYWORDS, DEMO_ROUTE.stations, { fetch });
    assert.equal(calls.length, 6);
    calls.forEach((c, i) => {
      assert.deepEqual(c.body.station, { name: DEMO_ROUTE.stations[i].name, profile: {}, taps: {} });
      assert.equal(c.body.item, KEYWORDS[i].label);
      assert.equal(c.body.locus, DEMO_ROUTE.stations[i].name);
      assert.ok(c.body.image.startsWith("data:image/jpeg;base64,"), "image is not a JPEG data URL");
    });
  });

  test("null profile/taps are sent as {}", async () => {
    const { fetch, calls } = countingFetch();
    const stations = DEMO_ROUTE.stations.map((s) => ({ ...s, profile: null, taps: null }));
    await associateKeywords(KEYWORDS, stations, { fetch });
    calls.forEach((c, i) => {
      assert.deepEqual(c.body.station, { name: stations[i].name, profile: {}, taps: {} });
    });
  });

  test("a station's profile and taps pass through unchanged as station {name, profile, taps} only", async () => {
    const { fetch, calls } = countingFetch();
    const stations = DEMO_ROUTE.stations.map((s, i) => ({
      ...s,
      id: s.id, n: i + 1, photo: `/9j/photo${i}`, photo_ref: `p${i}`, coords: { lat: 1, lng: 2 }, address: `${i} Main St`,
      profile: { visual: `red door ${i}`, spatial: `left of the stairs ${i}`, conceptual: `entry ${i}` },
      taps: { sound: `bell ${i}`, smell: `coffee ${i}`, feel: `cold brass ${i}`, mood: `calm ${i}` },
    }));
    const snapshot = JSON.parse(JSON.stringify(stations));
    await associateKeywords(KEYWORDS, stations, { fetch });
    assert.equal(calls.length, 6);
    calls.forEach((c, i) => {
      assert.deepEqual(c.body.station, { name: snapshot[i].name, profile: snapshot[i].profile, taps: snapshot[i].taps });
      assert.deepEqual(Object.keys(c.body.station).sort(), ["name", "profile", "taps"]);
      assert.equal(c.body.locus, snapshot[i].name);
    });
    assert.deepEqual(stations, snapshot, "associateKeywords mutated the stations");
  });
});

describe("mnemonics: built on the phone (0 calls)", () => {
  test("acronym is each keyword's first letter, in order", () => {
    assert.equal(mnemonics(KEYWORDS).acronym, "RSIECD");
  });

  test("the chain names every keyword in order", () => {
    const { chain } = mnemonics(KEYWORDS);
    assert.equal(typeof chain, "string");
    let at = -1;
    for (const k of KEYWORDS) {
      const i = chain.indexOf(k.label, at + 1);
      assert.ok(i > at, `chain misses or misorders ${k.label}`);
      at = i;
    }
  });
});

describe("recommendRoute: capacity + Jaccard, deterministic, with a reason", () => {
  test("a route with fewer free stations than keywords is never picked, however well it matches", () => {
    const pick = recommendRoute(ITEM, [route(RID(1), "Study techniques", 4), route(RID(2), "Kendall walk", 6)]);
    assert.equal(pick.routeId, RID(2));
    assert.equal(typeof pick.reason, "string");
    assert.ok(pick.reason.trim().length > 0, "reason is empty");
  });

  test("a route with an active list has no free stations; a retired list frees them", () => {
    const busy = route(RID(1), "Study techniques", 8, [{ id: LID(1), name: "Spaced practice", status: "active" }]);
    assert.equal(recommendRoute(ITEM, [busy, route(RID(2), "Kendall walk", 6)]).routeId, RID(2));
    const freed = route(RID(1), "Study techniques", 8, [{ id: LID(1), name: "Old list", status: "retired" }]);
    assert.equal(recommendRoute(ITEM, [freed, route(RID(2), "Kendall walk", 6)]).routeId, RID(1));
  });

  test("among fitting routes the higher Jaccard on the name wins over a tighter fit", () => {
    const pick = recommendRoute(ITEM, [route(RID(2), "Kendall walk", 6), route(RID(3), "Spaced practice loop", 8)]);
    assert.equal(pick.routeId, RID(3));
  });

  test("the route's list names count toward the match", () => {
    const riverside = route(RID(4), "Riverside", 8, [{ id: LID(4), name: "Study techniques", status: "retired" }]);
    assert.equal(recommendRoute(ITEM, [route(RID(2), "Kendall walk", 6), riverside]).routeId, RID(4));
  });

  test("equal scores go to the tightest fit, then to the name", () => {
    assert.equal(recommendRoute(ITEM, [route(RID(5), "Alpha route", 8), route(RID(6), "Zed route", 6)]).routeId, RID(6));
    assert.equal(recommendRoute(ITEM, [route(RID(7), "Beta route", 7), route(RID(8), "Alpha route", 7)]).routeId, RID(8));
    // Input order never changes the answer.
    assert.equal(recommendRoute(ITEM, [route(RID(8), "Alpha route", 7), route(RID(7), "Beta route", 7)]).routeId, RID(8));
  });

  test("no route with enough free stations -> null", () => {
    const busy = route(RID(1), "Kendall walk", 8, [{ id: LID(1), name: "Groceries", status: "active" }]);
    assert.equal(recommendRoute(ITEM, [route(RID(2), "Study techniques", 5), busy]), null);
    assert.equal(recommendRoute(ITEM, []), null);
  });
});

describe("Deconstruct checkboxes: dependents need keywords (ADR 0048)", () => {
  const BOXES = ["keywords", "mnemonics", "associations"];
  const state = (keywords, mnemonics, associations) => Object.freeze({ keywords, mnemonics, associations });
  // Reachable states: a dependent is only ever checked with keywords.
  const VALID = [state(false, false, false), state(true, false, false), state(true, true, false), state(true, false, true), state(true, true, true)];

  test("checking mnemonics or associations auto-checks keywords", () => {
    assert.deepEqual(toggleDeconstruct(state(false, false, false), "mnemonics"), state(true, true, false));
    assert.deepEqual(toggleDeconstruct(state(false, false, false), "associations"), state(true, false, true));
  });

  test("keywords cannot be unchecked while a dependent is checked", () => {
    assert.deepEqual(toggleDeconstruct(state(true, true, false), "keywords"), state(true, true, false));
    assert.deepEqual(toggleDeconstruct(state(true, false, true), "keywords"), state(true, false, true));
  });

  test("keywords alone toggles freely; unchecking a dependent keeps keywords", () => {
    assert.deepEqual(toggleDeconstruct(state(true, false, false), "keywords"), state(false, false, false));
    assert.deepEqual(toggleDeconstruct(state(false, false, false), "keywords"), state(true, false, false));
    assert.deepEqual(toggleDeconstruct(state(true, true, true), "mnemonics"), state(true, false, true));
  });

  test("the locked keywords box is disabled and says why; nothing else is ever disabled", () => {
    for (const s of VALID) {
      const view = deconstructView(s);
      const locked = s.mnemonics || s.associations;
      for (const box of BOXES) assert.equal(view[box].checked, s[box], `${box} checked`);
      assert.equal(view.keywords.disabled, locked);
      if (locked) assert.ok(typeof view.keywords.reason === "string" && view.keywords.reason.trim(), "no reason shown");
      else assert.equal(view.keywords.reason, null);
      for (const box of ["mnemonics", "associations"]) {
        assert.equal(view[box].disabled, false);
        assert.equal(view[box].reason, null);
      }
    }
  });

  test("every toggle from every reachable state lands in a reachable state", () => {
    for (const s of VALID) {
      for (const box of BOXES) {
        const next = toggleDeconstruct(s, box);
        assert.ok(next.keywords || (!next.mnemonics && !next.associations), `${JSON.stringify(s)} + ${box}`);
        assert.deepEqual(Object.keys(next).sort(), [...BOXES].sort());
      }
    }
  });
});

describe("MemorizeItem: KV list:<id> and backup lists[]", () => {
  const STATION = DEMO_ROUTE.stations[0];
  const item = (extra = {}) => ({
    id: LID(9),
    title: "6 study techniques",
    text: TECHNIQUES_TEXT,
    keywords: KEYWORDS,
    route_id: DEMO_ROUTE.id,
    placements: { [STATION.id]: { record: record(KEYWORDS[0].label, STATION.name), sig: SIG } },
    created_at: "2026-11-03T18:00:00.000Z",
    ...extra,
  });

  test("saveMemorizeItem stores the item under list:<id>", async () => {
    const kv = memoryAdapter();
    await saveMemorizeItem(kv, item());
    assert.deepEqual(await kv.get(`list:${LID(9)}`), item());
    assert.deepEqual([...kv.map.keys()], [`list:${LID(9)}`]);
  });

  test("lists[] round-trips through export, JSON and import unchanged", async () => {
    const items = [item(), item({ id: LID(8), remember_by: "2026-11-21T12:00:00.000Z", placements: {} })];
    const restored = await importLists(JSON.parse(JSON.stringify(exportLists(items))));
    assert.deepEqual(restored, items);
    assert.equal(Object.hasOwn(restored[0], "remember_by"), false, "absent remember_by became present");
  });

  test("export keeps only the MemorizeItem fields", () => {
    const [out] = exportLists([item({ ui_state: { open: true } })]);
    assert.deepEqual(out, item());
  });

  test("no items -> empty lists[]", () => {
    assert.deepEqual(exportLists([]), []);
  });

  test("import refuses a bad item", async () => {
    const { keywords: _k, ...noKeywords } = item();
    const bad = {
      "extra key": item({ ui_state: 1 }),
      "id not a uuid": item({ id: "list-1" }),
      "keyword without source_quote": item({ keywords: [{ label: "Retrieval practice" }] }),
      "keywords missing": noKeywords,
    };
    for (const [why, it] of Object.entries(bad)) {
      await assert.rejects(async () => importLists([it]), Error, why);
    }
    assert.match(item().id, UUID_RE);
  });
});

describe("fixture-mode Deconstruct run: only replayable same-origin calls", () => {
  test("split + associate + edit + mnemonics + recommend = 1 /split + 6 /associate, nothing else", async () => {
    const { fetch, calls } = countingFetch();
    const globalFetch = mock.method(globalThis, "fetch", async () => json(500, {}));
    try {
      const keywords = await splitNotes({ text: TECHNIQUES_TEXT, lociCount: 6 }, { fetch });
      const edited = splitList(keywords.map((k) => k.label).join("\n"), 6);
      mnemonics(edited);
      const pick = recommendRoute({ ...ITEM, keywords: edited }, [route(DEMO_ROUTE.id, DEMO_ROUTE.name, 6)]);
      assert.equal(pick.routeId, DEMO_ROUTE.id);
      await associateKeywords(edited, DEMO_ROUTE.stations, { fetch });
      assert.deepEqual(calls.map((c) => c.url), ["/split", ...Array(6).fill("/associate")]);
      assert.equal(globalFetch.mock.callCount(), 0, "a call bypassed the injected fetch");
    } finally {
      globalFetch.mock.restore();
    }
  });
});
