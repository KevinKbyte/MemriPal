// Covers: MEM-017
// Requirement: the upload status line tells the user what went wrong in plain words, driven
// through the page's own handlers (onLoadDemo / onPhotoChange). A failed demo GET, or a failed
// /loci POST whose body carries no JSON string `error`, names the HTTP status as "HTTP <status>"
// (e.g. "HTTP 503") and never shows an internal "http_<status>" code. A server JSON error code
// (body {"error": "fixture_missing"}) is still shown as-is. A 200 answer whose body is not JSON
// shows a distinct "unreadable response" message, never "http_200" and never the generic
// could-not-send text.
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
  return { doc, status };
}

const DEMO_FAILURE = "could not load the demo photo";
const PICK_FAILURE = "could not read or send the photo";

const demoPhoto = () =>
  new Response(new Uint8Array([0xff, 0xd8, 0x44]), { status: 200, headers: { "content-type": "image/jpeg" } });

/**
 * fetch stub for the real pick/demo paths: the demo GET answers demoGet(), every /loci POST
 * answers lociPost(). Records each requested URL.
 */
function stubFetch({ demoGet = demoPhoto, lociPost }) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (String(url) === "/demo/photo.jpg") return demoGet();
    if (String(url) === "/loci") return lociPost();
    throw new Error(`unexpected url ${url}`);
  };
  return { calls, fetchFn };
}

function depsFor(page, fetchFn) {
  return {
    doc: page.doc,
    loadImage: async (src) => ({ src }),
    fetch: fetchFn,
    encode: async () => new Uint8Array([0x50]),
  };
}

const pickInput = () => ({ files: [{ name: "room.jpg", type: "image/jpeg" }], value: "C:\\fakepath\\room.jpg" });

/** Both real upload sources, each driven through its page handler. */
const SOURCES = [
  { name: "Load demo", run: (deps) => app.onLoadDemo(deps), failure: DEMO_FAILURE },
  { name: "photo pick", run: (deps) => app.onPhotoChange(pickInput(), deps), failure: PICK_FAILURE },
];

function assertNamesHttpStatus(text, status) {
  assert.match(text, /failed/i, `status "${text}" must say the upload failed`);
  assert.match(text, new RegExp(`\\bHTTP ${status}\\b`), `status "${text}" must name HTTP ${status}`);
  assert.doesNotMatch(text, /http_/, `status "${text}" must not show an internal http_ code`);
}

// Covers: MEM-017
// Requirement: a failed demo GET names its HTTP status ("HTTP 503") in the status line, never
// "http_503", and never POSTs to /loci.
describe("Load demo: a failed demo GET names the HTTP status", () => {
  for (const status of [503, 404]) {
    test(`demo GET answering ${status} shows "HTTP ${status}" and never POSTs`, async () => {
      const page = fakePage();
      const { calls, fetchFn } = stubFetch({
        demoGet: () => new Response("unavailable", { status }),
        lociPost: () => {
          throw new Error("/loci must not be POSTed after a failed demo GET");
        },
      });
      await app.onLoadDemo(depsFor(page, fetchFn));
      assertNamesHttpStatus(page.status.textContent, status);
      assert.deepEqual(calls, ["/demo/photo.jpg"]);
    });
  }
});

// Covers: MEM-017
// Requirement: a failed /loci POST whose body has no JSON string `error` (plain text, empty, a
// JSON object without `error`, or a non-string `error`) names "HTTP <status>", never "http_<status>",
// for both the photo pick and Load demo paths.
describe("upload: a failed POST without a JSON error names the HTTP status", () => {
  const bodies = [
    { name: "plain-text body", make: (status) => new Response("Service Unavailable", { status }) },
    { name: "empty body", make: (status) => new Response("", { status }) },
    {
      name: "JSON object without error",
      make: (status) =>
        new Response(JSON.stringify({ detail: "x" }), { status, headers: { "content-type": "application/json" } }),
    },
    {
      name: "JSON with non-string error",
      make: (status) =>
        new Response(JSON.stringify({ error: 5 }), { status, headers: { "content-type": "application/json" } }),
    },
  ];
  for (const source of SOURCES) {
    for (const body of bodies) {
      test(`${source.name}: POST answering 503 with a ${body.name} shows "HTTP 503"`, async () => {
        const page = fakePage();
        const { fetchFn } = stubFetch({ lociPost: () => body.make(503) });
        await source.run(depsFor(page, fetchFn));
        assertNamesHttpStatus(page.status.textContent, 503);
      });
    }
  }
});

// Covers: MEM-017
// Requirement: a server JSON error code is still shown verbatim ("Upload failed: fixture_missing").
describe("upload: a server JSON error code is shown as-is", () => {
  for (const source of SOURCES) {
    test(`${source.name}: body {"error":"fixture_missing"} shows "Upload failed: fixture_missing"`, async () => {
      const page = fakePage();
      const { fetchFn } = stubFetch({
        lociPost: () =>
          new Response(JSON.stringify({ error: "fixture_missing" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      });
      await source.run(depsFor(page, fetchFn));
      assert.equal(page.status.textContent, "Upload failed: fixture_missing");
    });
  }
});

// Covers: MEM-017
// Requirement: a 200 answer whose body is not JSON shows a distinct "unreadable response" message,
// never "http_200" and never the generic could-not-send/could-not-load failure text.
describe("upload: a 200 with a non-JSON body says the response was unreadable", () => {
  const bodies = [
    { name: "HTML body", text: "<html>proxy page</html>" },
    { name: "empty body", text: "" },
    { name: "truncated JSON", text: '{"image": "data:' },
  ];
  for (const source of SOURCES) {
    for (const body of bodies) {
      test(`${source.name}: 200 with ${body.name} shows "unreadable response"`, async () => {
        const page = fakePage();
        const { fetchFn } = stubFetch({
          lociPost: () => new Response(body.text, { status: 200, headers: { "content-type": "text/html" } }),
        });
        await source.run(depsFor(page, fetchFn));
        const text = page.status.textContent;
        assert.match(text, /unreadable response/i, `status "${text}" must say the response was unreadable`);
        assert.doesNotMatch(text, /http_/, `status "${text}" must not show an internal http_ code`);
        assert.ok(!text.includes(source.failure), `status "${text}" must differ from the generic failure text`);
      });
    }
  }
});
