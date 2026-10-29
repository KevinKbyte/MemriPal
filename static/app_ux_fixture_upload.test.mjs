// Covers: MEM-017
// Requirement: on a fixture-mode server, picking your own photo cannot be answered (the server only
// replays the demo photo and returns 404 {"error": "fixture_missing"}). The upload status must then
// tell the user in plain words to use Load demo instead, never show the raw code "fixture_missing"
// as the whole message, and leave the page usable: the photo input is cleared so a re-pick uploads
// again, and Load demo afterwards still finds the demo's places.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as app from "./app.js";

/** Fake page: the #upload-status, #scene canvas and #loci list the upload flow writes to. */
function fakePage() {
  const ctx = { drawImage() {}, strokeRect() {}, fillRect() {}, fillText() {}, clearRect() {} };
  const canvas = { width: 300, height: 150, parentElement: { clientWidth: 1000 }, getContext: () => ctx };
  const list = {
    children: [],
    replaceChildren(...c) {
      this.children = c;
    },
    append(...c) {
      this.children.push(...c);
    },
  };
  const status = { textContent: "" };
  const els = { "upload-status": status, scene: canvas, loci: list };
  const doc = {
    getElementById: (id) => els[id] ?? null,
    createElement: (tag) => ({ tagName: String(tag).toUpperCase(), textContent: "" }),
  };
  return { doc, status, list };
}

const LOCI = [1, 2, 3].map((n) => ({ n, label: `spot ${n}`, box: { x1: 10, y1: 10, x2: 50, y2: 50 } }));
const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Fixture-mode server: the demo photo's bytes replay, any other photo is fixture_missing. */
function fixtureServer() {
  const demoBytes = new Uint8Array([0xff, 0xd8, 0x44]);
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url) === "/demo/photo.jpg") return new Response(demoBytes, { headers: { "content-type": "image/jpeg" } });
    if (String(url) === "/loci") {
      const sent = new Uint8Array(init.body instanceof ArrayBuffer ? init.body : []);
      const isDemo = sent.length === demoBytes.length && sent.every((b, i) => b === demoBytes[i]);
      return isDemo ? json({ image: "data:image/jpeg;base64,AA==", width: 800, height: 600, loci: LOCI }, 200) : json({ error: "fixture_missing" }, 404);
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchFn, calls };
}

const depsFor = (page, fetchFn) => ({
  doc: page.doc,
  loadImage: async (src) => ({ src }),
  fetch: fetchFn,
  encode: async () => new Uint8Array([0x50, 0x51]),
});

const pickInput = () => ({ files: [{ name: "room.jpg", type: "image/jpeg" }], value: "C:\\fakepath\\room.jpg" });

// Covers: MEM-017
// Requirement: an own photo on a fixture-mode server says "use Load demo" in plain words (UX F9).
describe("own photo upload on a fixture-mode server", () => {
  test("status tells the user to use Load demo, not just the raw fixture_missing code", async () => {
    const page = fakePage();
    const server = fixtureServer();
    await app.onPhotoChange(pickInput(), depsFor(page, server.fetchFn));
    const text = page.status.textContent;
    assert.ok(server.calls.includes("/loci"), "the photo was sent");
    assert.notEqual(text.replace(/^Upload failed:\s*/, "").trim(), "fixture_missing", `status "${text}" must not be only the raw code`);
    assert.match(text, /Load demo/, `status "${text}" must point the user at Load demo`);
  });

  test("the page stays usable: input cleared, and Load demo afterwards finds the demo's places", async () => {
    const page = fakePage();
    const server = fixtureServer();
    const input = pickInput();
    await app.onPhotoChange(input, depsFor(page, server.fetchFn));
    assert.equal(input.value, "", "the input is cleared so a re-pick uploads again");
    await app.onLoadDemo(depsFor(page, server.fetchFn));
    assert.equal(page.status.textContent, `Found ${LOCI.length} places`);
    assert.equal(page.list.children.length, LOCI.length, "the demo's places are listed");
  });
});
