// Covers: MEM-040
// Requirement: the decorative empty-state picture (#empty-state) shows on page load and is hidden
// once a palace's places render in #loci (a photo upload or Load demo whose result is drawn); it
// stays hidden for the rest of the page session, so a later flow step, a new upload in flight, or a
// later failed upload never brings it back. A failed upload before any drawn result leaves it shown.
// Driven through the page's own handlers (wireApp's Load demo click, app.js onPhotoChange), per
// .claude/rules/client-transform-tests-drive-browser-path.md.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as app from "./app.js";
import { deferred, fakePage, findAll, jsonResponse, memoryAdapter, record, settle, until } from "./fake_dom_test.mjs";
import { wireApp } from "./flow.js";
import { createPalaceStore } from "./palace_store.js";
import { createRehearsalStore } from "./rehearsals.js";

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const TIMELINE = JSON.parse(readFileSync(new URL("../fixtures/demo/recall_timeline.json", import.meta.url), "utf8"));

const POINTS = [
  ["The method is over two thousand years old", "The method of loci is more than two thousand years"],
  ["Students can use it for exams", "Students can use it for exams"],
  ["Try it on your next shopping list", "try it on your next shopping list"],
].map(([label, source_quote]) => ({ label, source_quote }));
const LOCI = ["lamp", "door", "clock"].map((label, i) => ({ n: i + 1, label, box: { x1: 10 + i * 60, y1: 10, x2: 60 + i * 60, y2: 200 } }));
const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const LOCI_BODY = { image: IMAGE, width: 800, height: 600, loci: LOCI };
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

/** Demo server; `loci()` answers POST /loci (a Response, a promise of one, or a throw). */
function server(loci = () => jsonResponse(LOCI_BODY)) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push(u);
    if (u === "/demo/photo.jpg") return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "content-type": "image/jpeg" } });
    if (u === "/demo/notes.txt") return new Response("notes", { headers: { "content-type": "text/plain" } });
    if (u === "/demo/recall.json") return jsonResponse(TIMELINE);
    if (u === "/loci") return loci();
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

/** Page start-up as app.js does it: wireApp over the index.html page; `loci` answers /loci. */
async function boot(loci) {
  const p = pageFromHtml();
  const srv = server(loci);
  const rehAdapter = kvAdapter();
  let n = 0;
  let t = Date.UTC(2026, 9, 31, 9, 0, 0);
  wireApp({
    doc: p.doc,
    fetch: srv.fn,
    store: createPalaceStore(memoryAdapter()),
    rehearsals: createRehearsalStore(rehAdapter, { now: () => (t += 60_000), newId: () => `reh-${++n}` }),
    getUserMedia: undefined,
    location: { hostname: "localhost" },
    loadImage: async (src) => ({ src }),
    confirm: () => true,
    wait: async () => {},
  });
  await settle(20);
  return { p, srv, rehAdapter };
}

const el = (b, id) => {
  const e = b.p.els[id];
  assert.ok(e, `index.html must contain #${id}`);
  return e;
};

const emptyState = (b) => el(b, "empty-state");
const lociItems = (b) => findAll(el(b, "loci"), (n) => n.tagName === "LI");
const statusText = (b) => el(b, "upload-status").textContent;

/** The photo input's own change handler, as wireUpload binds it, on the same page. */
function pickPhoto(b) {
  const input = { files: [{ name: "room.jpg", type: "image/jpeg" }], value: "C:\\fakepath\\room.jpg" };
  return app.onPhotoChange(input, {
    doc: b.p.doc,
    loadImage: async (src) => ({ src }),
    fetch: b.srv.fn,
    encode: async () => new Uint8Array([0x50]),
  });
}

/** Click Load demo (auto) and wait until the whole flow has finished and recall is offered. */
async function loadDemo(b) {
  el(b, "auto").checked = true;
  b.p.fire(el(b, "load-demo"), "click");
  await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
  await settle(20);
}

// Covers: MEM-040
// Requirement: before any palace is drawn the page shows the empty-state picture.
describe("empty-state on page load", () => {
  test("#empty-state is shown after start-up", async () => {
    const b = await boot();
    assert.equal(emptyState(b).hidden, false, "#empty-state hidden on page load");
    assert.equal(lociItems(b).length, 0);
  });

  test("a failed photo upload before any drawn result leaves it shown", async () => {
    const b = await boot(() => jsonResponse({ error: "upstream" }, 502));
    emptyState(b);
    await pickPhoto(b);
    assert.equal(statusText(b), "Upload failed: upstream");
    assert.equal(lociItems(b).length, 0);
    assert.equal(emptyState(b).hidden, false, "a failed upload drew nothing, so the empty state stays");
  });

  test("a failed Load demo (no places drawn) leaves it shown", async () => {
    const b = await boot(() => jsonResponse({ error: "busy" }, 503));
    emptyState(b);
    b.p.fire(el(b, "load-demo"), "click");
    await until(() => statusText(b).includes("failed"), "demo failure shown", TURNS);
    await settle(20);
    assert.equal(lociItems(b).length, 0);
    assert.equal(emptyState(b).hidden, false, "a failed demo drew nothing, so the empty state stays");
  });
});

// Covers: MEM-040
// Requirement: once a palace's places render in #loci, the empty-state picture is hidden.
describe("empty-state hidden once places render", () => {
  test("Load demo: hidden once #loci lists the places", async () => {
    const b = await boot();
    assert.equal(emptyState(b).hidden, false);
    el(b, "auto").checked = true;
    b.p.fire(el(b, "load-demo"), "click");
    await until(() => lociItems(b).length === LOCI.length, "#loci rendered by Load demo", TURNS);
    assert.equal(emptyState(b).hidden, true, "#empty-state still shown after #loci rendered");
  });

  test("photo upload: hidden once #loci lists the places", async () => {
    const b = await boot();
    assert.equal(emptyState(b).hidden, false);
    await pickPhoto(b);
    assert.equal(statusText(b), `Found ${LOCI.length} places`);
    assert.deepEqual(lociItems(b).map((li) => li.textContent), ["lamp", "door", "clock"]);
    assert.equal(emptyState(b).hidden, true, "#empty-state still shown after #loci rendered");
  });
});

// Covers: MEM-040
// Requirement: once hidden, the empty-state picture stays hidden for the rest of the page session.
describe("empty-state stays hidden for the session", () => {
  test("stays hidden through the rest of the Load demo flow and a recall replay", async () => {
    const b = await boot();
    await loadDemo(b);
    assert.equal(emptyState(b).hidden, true, "hidden after the demo walk view");
    b.p.fire(el(b, "recall-replay"), "click");
    await until(() => b.rehAdapter.map.size === 1, "replay saved", TURNS);
    await settle(20);
    assert.equal(emptyState(b).hidden, true, "hidden after a later recall step");
  });

  test("stays hidden while a new upload is in flight (#loci cleared)", async () => {
    let answer = () => jsonResponse(LOCI_BODY);
    const b = await boot(() => answer());
    await pickPhoto(b);
    assert.equal(emptyState(b).hidden, true);
    const d = deferred();
    answer = () => d.promise;
    const pending = pickPhoto(b);
    await until(() => b.srv.calls.filter((u) => u === "/loci").length === 2, "second /loci POST", TURNS);
    assert.equal(lociItems(b).length, 0, "a new upload clears #loci up front");
    assert.equal(emptyState(b).hidden, true, "an upload in flight brought the empty state back");
    d.resolve(jsonResponse(LOCI_BODY));
    await pending;
    assert.equal(emptyState(b).hidden, true);
  });

  test("a later failed photo upload (error response) keeps it hidden", async () => {
    let answer = () => jsonResponse(LOCI_BODY);
    const b = await boot(() => answer());
    await pickPhoto(b);
    assert.equal(emptyState(b).hidden, true);
    answer = () => jsonResponse({ error: "upstream" }, 502);
    await pickPhoto(b);
    assert.equal(statusText(b), "Upload failed: upstream");
    assert.equal(lociItems(b).length, 0);
    assert.equal(emptyState(b).hidden, true, "a failed upload brought the empty state back");
  });

  test("a later photo upload whose send rejects keeps it hidden", async () => {
    let answer = () => jsonResponse(LOCI_BODY);
    const b = await boot(() => answer());
    await pickPhoto(b);
    answer = () => {
      throw new TypeError("Failed to fetch");
    };
    await pickPhoto(b);
    assert.equal(statusText(b), "Upload failed: could not read or send the photo");
    assert.equal(emptyState(b).hidden, true, "a rejected upload brought the empty state back");
  });

  test("a failed photo upload after Load demo keeps it hidden", async () => {
    let answer = () => jsonResponse(LOCI_BODY);
    const b = await boot(() => answer());
    await loadDemo(b);
    assert.equal(emptyState(b).hidden, true);
    answer = () => jsonResponse({ error: "upstream" }, 502);
    await pickPhoto(b);
    assert.equal(statusText(b), "Upload failed: upstream");
    assert.equal(emptyState(b).hidden, true, "a failed upload after the demo brought the empty state back");
  });
});
