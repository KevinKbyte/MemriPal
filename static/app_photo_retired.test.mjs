// Covers: MEM-073
// Requirement: the legacy room-photo upload flow is retired (ADR 0040, two-step retirement, step 1).
// The page keeps its #photo input (plan A5 keeps every id), but choosing a photo there does nothing:
// no POST /loci is made and the upload status line is left as it was. app.js no longer exports the
// photo change handler onPhotoChange. Driven through the real page bootstrap: app.js is imported
// with a fake document, location, localStorage and fetch installed, exactly as the browser runs it
// (.claude/rules/client-transform-tests-drive-browser-path.md). The canvas re-encode is stubbed
// (createImageBitmap, canvas.toBlob) so a still-wired photo handler would reach /loci here.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as app from "./app.js";
import { fakePage, jsonResponse, settle, until } from "./fake_dom_test.mjs";

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const LOCI_BODY = { image: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==", width: 800, height: 600, loci: [{ n: 1, label: "lamp" }] };
const TURNS = 2000;

function pageFromHtml() {
  const ids = [];
  const hidden = [];
  for (const m of HTML.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
    const id = /\bid="([^"]+)"/.exec(m[0]);
    if (!id) continue;
    ids.push(id[1]);
    if (/\shidden(?=[\s>=/])/.test(m[0])) hidden.push(id[1]);
  }
  const page = fakePage(ids, { hidden });
  // The browser canvas re-encode needs toBlob; the shared fake canvas has none.
  const make = page.doc.createElement;
  page.doc.createElement = (tag) => {
    const e = make(tag);
    if (String(tag).toLowerCase() === "canvas") {
      e.toBlob = (cb, type) => cb(new Blob([new Uint8Array([0xff, 0xd8, 0x50])], { type }));
    }
    return e;
  };
  return page;
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const GLOBALS = ["document", "location", "localStorage", "fetch", "createImageBitmap"];

describe("MEM-073 room-photo upload retired", () => {
  const saved = new Map();
  const calls = [];
  let page;

  before(async () => {
    page = pageFromHtml();
    const fakes = {
      document: page.doc,
      location: { hostname: "localhost", search: "", href: "http://localhost/" },
      localStorage: memoryStorage(),
      fetch: async (url) => {
        const u = String(url);
        calls.push(u);
        if (u === "/healthz") return jsonResponse({ status: "ok", mode: "fixture" });
        if (u === "/loci") return jsonResponse(LOCI_BODY);
        return jsonResponse({ error: "not_found" }, 404);
      },
      createImageBitmap: async () => ({ width: 4, height: 3, close() {} }),
    };
    for (const name of GLOBALS) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { value: fakes[name], configurable: true, writable: true });
    }
    // A distinct module instance, so its bootstrap runs now, against the fake page.
    await import("./app.js?boot=mem-073");
    await until(() => calls.includes("/healthz"), "page bootstrap ran (GET /healthz)", TURNS);
    await settle(50);
  });

  after(() => {
    for (const name of GLOBALS) {
      const d = saved.get(name);
      if (d) Object.defineProperty(globalThis, name, d);
      else delete globalThis[name];
    }
  });

  test("app.js exports no onPhotoChange", () => {
    assert.equal(Object.hasOwn(app, "onPhotoChange"), false, "onPhotoChange is still exported");
  });

  test("index.html still has the #photo input", () => {
    assert.ok(page.els.photo, "#photo must stay in index.html (plan A5)");
  });

  test("choosing a photo in #photo makes no /loci request and leaves the status line alone", async () => {
    const status = page.els["upload-status"];
    const before = status ? status.textContent : undefined;
    const input = page.els.photo;
    input.files = [new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "room.jpg", { type: "image/jpeg" })];
    input.value = "C:\\fakepath\\room.jpg";
    page.fire(input, "change");
    await settle(200);
    assert.deepEqual(calls.filter((u) => u === "/loci"), [], "a #photo change still POSTs /loci");
    assert.equal(status ? status.textContent : undefined, before, "a #photo change still writes the upload status");
  });
});
