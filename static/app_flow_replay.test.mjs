// Covers: MEM-039
// Requirement: when the recorded demo session (/demo/recall.json) cannot be fetched or read, the
// recall panel says why in one line ("Replay failed: <code>", like Load demo's "Demo failed: <code>")
// instead of failing silently, and nothing is replayed or saved.
// Contract (RED; GREEN implements in static/flow.js, #recall-replay handler):
//   fetch rejects with TypeError -> "Replay failed: network"; non-2xx -> "Replay failed: <code>", code =
//   JSON body `error` string else `http_<status>` (missing fixture -> demo_missing); 2xx body not JSON
//   or `chunks` not an array -> "Replay failed: bad_response"; any other error -> "Replay failed:
//   unexpected error". The line is the whole of #recall-results (textContent); no live board, no
//   replay pacing, no rehearsal saved. Sibling of app_flow.test.mjs (that file is near the size cap).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakePage, find, findAll, jsonResponse, memoryAdapter, record, settle, until, visibleText } from "./fake_dom_test.mjs";
import { createPalaceStore } from "./palace_store.js";
import { createRehearsalStore } from "./rehearsals.js";

const flow = await import("./flow.js").catch((err) => ({ __missing: String(err) }));

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const TIMELINE = JSON.parse(readFileSync(new URL("../fixtures/demo/recall_timeline.json", import.meta.url), "utf8"));

const POINTS = [
  ["The method is over two thousand years old", "The method of loci is more than two thousand years"],
  ["Students can use it for exams", "Students can use it for exams"],
  ["Try it on your next shopping list", "try it on your next shopping list"],
].map(([label, source_quote]) => ({ label, source_quote }));
const LOCI = ["lamp", "door", "clock"].map((label, i) => ({ n: i + 1, label, box: { x1: 10 + i * 60, y1: 10, x2: 60 + i * 60, y2: 200 } }));
const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const TURNS = 5000;

function pageFromHtml() {
  const ids = [];
  const hidden = [];
  for (const m of HTML.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
    const id = /\bid="([^"]+)"/.exec(m[0]);
    if (!id) continue;
    ids.push(id[1]);
    if (/\shidden(?=[\s>=/])/.test(m[0])) hidden.push(id[1]);
  }
  return fakePage(ids, { hidden });
}

/** Demo server whose /demo/recall.json answer is `recall()` (a Response, or a thrown error). */
function demoServer(recall) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push(u);
    if (u === "/demo/photo.jpg") return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "content-type": "image/jpeg" } });
    if (u === "/demo/notes.txt") return new Response("notes", { headers: { "content-type": "text/plain" } });
    if (u === "/demo/recall.json") return recall();
    if (u === "/loci") return jsonResponse({ image: IMAGE, width: 800, height: 600, loci: LOCI });
    if (u === "/split") return jsonResponse({ points: POINTS });
    if (u === "/associate") return jsonResponse({ record: record(body.item, body.locus), status: "valid", sig: `sig_${body.item}` });
    if (u === "/scenes") return jsonResponse({ tier: 1, image: IMAGE, width: 800, height: 600 });
    return jsonResponse({ error: "not_found" }, 404);
  };
  return { fn, calls };
}

function kvAdapter() {
  const map = new Map();
  return {
    map,
    get: async (k) => map.get(k),
    put: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    list: async () => [...map.values()],
  };
}

function boot(recall) {
  assert.ok("wireApp" in flow, `static/flow.js must export wireApp (${flow.__missing ?? "not exported"})`);
  const p = pageFromHtml();
  const server = demoServer(recall);
  const rehAdapter = kvAdapter();
  let n = 0;
  let t = Date.UTC(2026, 9, 31, 9, 0, 0);
  const waits = [];
  flow.wireApp({
    doc: p.doc,
    fetch: server.fn,
    store: createPalaceStore(memoryAdapter()),
    rehearsals: createRehearsalStore(rehAdapter, { now: () => (t += 60_000), newId: () => `reh-${++n}` }),
    getUserMedia: undefined,
    location: { hostname: "localhost" },
    loadImage: async (src) => ({ src }),
    confirm: () => true,
    wait: async (ms) => void waits.push(ms),
  });
  return { p, server, rehAdapter, waits };
}

const el = (b, id) => {
  const e = b.p.els[id];
  assert.ok(e, `index.html must contain #${id}`);
  return e;
};

async function readyForRecall(b) {
  el(b, "auto").checked = true;
  b.p.fire(el(b, "load-demo"), "click");
  await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
  await settle(20);
}

const resultsText = (b) => visibleText(el(b, "recall-results"));
const liveBoard = (b) => find(el(b, "recall-live"), (n) => n.tagName === "OL" && n.className.includes("live-board"));

/** Click replay, wait for the failure line, and check nothing was replayed or saved. */
async function expectReplayFailure(b, line) {
  b.waits.length = 0;
  b.p.fire(el(b, "recall-replay"), "click");
  await until(() => resultsText(b).includes("Replay failed"), `"${line}" shown in #recall-results`, TURNS);
  await settle(30);
  assert.equal(resultsText(b), line);
  assert.equal(liveBoard(b), null, "no live board for a replay that never started");
  assert.deepEqual(b.waits, [], "no replay pacing ran");
  assert.equal(b.rehAdapter.map.size, 0, "no rehearsal saved");
  assert.equal(findAll(el(b, "rehearsals"), (n) => n.tagName === "LI", { visibleOnly: true }).length, 0, "history lists no run");
  assert.equal(b.server.calls.filter((u) => u === "/demo/recall.json").length, 1, "one request, no retry");
}

// Covers: MEM-039
// Requirement: a replay whose recording never arrives (offline, server error, fixture missing) tells
// the user why in #recall-results, mirroring Load demo's failure codes, and saves no run.
describe("replay fetch failure", () => {
  test("network down (fetch rejects with TypeError) -> Replay failed: network", async () => {
    const b = boot(() => {
      throw new TypeError("Failed to fetch");
    });
    await readyForRecall(b);
    await expectReplayFailure(b, "Replay failed: network");
  });

  test("non-2xx with a JSON error string -> that code", async () => {
    const b = boot(() => jsonResponse({ error: "busy" }, 503));
    await readyForRecall(b);
    await expectReplayFailure(b, "Replay failed: busy");
  });

  test("missing fixture (404 demo_missing) -> Replay failed: demo_missing", async () => {
    const b = boot(() => jsonResponse({ error: "demo_missing" }, 404));
    await readyForRecall(b);
    await expectReplayFailure(b, "Replay failed: demo_missing");
  });

  for (const [name, make] of [
    ["a non-JSON body", () => new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } })],
    ["a JSON body without a string error", () => jsonResponse({ error: 42 }, 500)],
  ]) {
    test(`non-2xx with ${name} -> http_<status>`, async () => {
      const b = boot(make);
      await readyForRecall(b);
      await expectReplayFailure(b, "Replay failed: http_500");
    });
  }

  test("an error code is shown as text, never parsed as markup", async () => {
    const code = "<img src=x onerror=alert(1)>";
    const b = boot(() => jsonResponse({ error: code }, 502));
    await readyForRecall(b);
    await expectReplayFailure(b, `Replay failed: ${code}`);
    assert.deepEqual(b.p.htmlWrites, [], "no innerHTML / insertAdjacentHTML");
    assert.equal(findAll(el(b, "recall-results"), (n) => n.tagName === "IMG").length, 0);
  });
});

// Covers: MEM-039
// Requirement: a recording that arrives but cannot be replayed (not JSON, no chunk list) is reported
// as a bad response, and any other failure as an unexpected error; never a silent stall or a saved run.
describe("replay unreadable or unexpected failure", () => {
  for (const [name, make] of [
    ["2xx body that is not JSON", () => new Response("not json{", { status: 200, headers: { "content-type": "application/json" } })],
    ["2xx JSON whose chunks is a string", () => jsonResponse({ ...TIMELINE, chunks: "hello" })],
    ["2xx JSON without chunks", () => jsonResponse({ label: TIMELINE.label })],
    ["2xx JSON null", () => jsonResponse(null)],
  ]) {
    test(`${name} -> Replay failed: bad_response`, async () => {
      const b = boot(make);
      await readyForRecall(b);
      await expectReplayFailure(b, "Replay failed: bad_response");
    });
  }

  test("fetch rejects with a non-network error -> Replay failed: unexpected error", async () => {
    const b = boot(() => {
      throw new Error("boom");
    });
    await readyForRecall(b);
    await expectReplayFailure(b, "Replay failed: unexpected error");
  });

  test("after a successful replay, a failed one replaces the results with the failure line", async () => {
    let fail = false;
    const b = boot(() => (fail ? jsonResponse({ error: "demo_missing" }, 404) : jsonResponse(TIMELINE)));
    await readyForRecall(b);
    b.p.fire(el(b, "recall-replay"), "click");
    await until(() => b.rehAdapter.map.size === 1, "first replay saved", TURNS);
    await settle(30);
    fail = true;
    b.p.fire(el(b, "recall-replay"), "click");
    await until(() => resultsText(b).includes("Replay failed"), "failure shown", TURNS);
    await settle(30);
    assert.equal(resultsText(b), "Replay failed: demo_missing", "the earlier run's results are replaced");
    assert.equal(b.rehAdapter.map.size, 1, "the failed replay saves nothing");
  });
});
