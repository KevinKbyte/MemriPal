// Covers: MEM-017
// Requirement: the real upload flow ("Load demo" and any other showUpload caller) only ever shows
// the latest upload's result. app.js exports the seam the page itself uses:
//   showUpload(send, failureText, deps)  -- one upload; send() resolves to the /loci Response
//   onLoadDemo(deps)                     -- the "Load demo" click handler
// deps = {doc, loadImage, fetch, encode}: doc offers getElementById/createElement, loadImage(src)
// resolves to a drawable image once decoded, fetch is the fetch function. Every upload shares ONE
// module-level stale-response gate, so a later upload from any source supersedes an earlier one
// from any source: a superseded upload never draws, never sets the status, and never clears, even
// when it answers last. The room-photo pick (onPhotoChange) is retired (MEM-073, ADR 0040).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as app from "./app.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

/** Turn the event loop until cond() holds; bounded by turns, never by wall-clock time. */
async function until(cond, label) {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await tick();
  }
  assert.fail(`never reached: ${label}`);
}

/** Fake page: the #upload-status, #scene canvas and #loci list the upload flow writes to. */
function fakePage() {
  const drawn = [];
  const badges = [];
  const ctx = {
    drawImage(img) {
      drawn.push(img.src);
    },
    strokeRect() {},
    fillRect() {},
    fillText(text) {
      badges.push(String(text));
    },
    clearRect() {},
  };
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
  return {
    doc,
    canvas,
    status,
    drawn,
    badges,
    list,
    captions: () => list.children.map((c) => c.textContent),
  };
}

const IMG = (tag) => `data:image/jpeg;base64,${tag}`;

function payload(tag, labels) {
  return {
    image: IMG(tag),
    width: 800,
    height: 600,
    loci: labels.map((label, i) => ({ n: i + 1, label, box: { x1: 10, y1: 10, x2: 50, y2: 50 } })),
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const loadNow = async (src) => ({ src });

function depsFor(page, extra = {}) {
  return {
    doc: page.doc,
    loadImage: loadNow,
    fetch: async () => {
      throw new Error("fetch not expected");
    },
    encode: async () => new Uint8Array([0x50]),
    ...extra,
  };
}

function assertShowsB(page) {
  assert.deepEqual(page.drawn, [IMG("B")], "only the latest upload's photo may be drawn");
  assert.deepEqual(page.captions(), ["lamp", "door"]);
  assert.equal(page.status.textContent, "Found 2 places");
  assert.equal(page.canvas.width, 800);
  assert.equal(page.canvas.height, 600);
}

// Covers: MEM-017
// Requirement: app.js exports the upload-flow seam (showUpload, onLoadDemo).
describe("upload flow seam", () => {
  test("app.js exports showUpload and onLoadDemo", () => {
    assert.equal(typeof app.showUpload, "function");
    assert.equal(typeof app.onLoadDemo, "function");
  });
});

// Covers: MEM-017
// Requirement: of two overlapping uploads only the later one ever draws or sets the status, even
// when the earlier one answers (success, error or rejection) or finishes decoding last.
describe("upload flow: only the latest upload is drawn", () => {
  test("two overlapping uploads answered out of order: only the second is ever drawn", async () => {
    const page = fakePage();
    const deps = depsFor(page);
    const d1 = deferred();
    const d2 = deferred();
    const p1 = app.showUpload(() => d1.promise, "could not send", deps);
    const p2 = app.showUpload(() => d2.promise, "could not send", deps);
    d2.resolve(jsonResponse(payload("B", ["lamp", "door"])));
    await p2;
    assertShowsB(page);
    d1.resolve(jsonResponse(payload("A", ["chair"])));
    await p1;
    assertShowsB(page);
  });

  test("a superseded upload's later error response changes nothing", async () => {
    const page = fakePage();
    const deps = depsFor(page);
    const d1 = deferred();
    const d2 = deferred();
    const p1 = app.showUpload(() => d1.promise, "could not send", deps);
    const p2 = app.showUpload(() => d2.promise, "could not send", deps);
    d2.resolve(jsonResponse(payload("B", ["lamp", "door"])));
    await p2;
    d1.resolve(jsonResponse({ error: "upstream" }, 502));
    await p1;
    assertShowsB(page);
  });

  test("a superseded upload's later send rejection changes nothing", async () => {
    const page = fakePage();
    const deps = depsFor(page);
    const d1 = deferred();
    const d2 = deferred();
    const p1 = app.showUpload(() => d1.promise, "could not send", deps);
    const p2 = app.showUpload(() => d2.promise, "could not send", deps);
    d2.resolve(jsonResponse(payload("B", ["lamp", "door"])));
    await p2;
    d1.reject(new TypeError("network down"));
    await p1;
    assertShowsB(page);
  });

  test("an upload superseded while its photo is still decoding never draws", async () => {
    const page = fakePage();
    const decodes = new Map();
    const loadImage = (src) => {
      const d = deferred();
      decodes.set(src, d);
      return d.promise;
    };
    const deps = depsFor(page, { loadImage });
    const p1 = app.showUpload(async () => jsonResponse(payload("A", ["chair"])), "could not send", deps);
    await until(() => decodes.has(IMG("A")), "first upload reaches photo decode");
    const p2 = app.showUpload(async () => jsonResponse(payload("B", ["lamp", "door"])), "could not send", deps);
    await until(() => decodes.has(IMG("B")), "second upload reaches photo decode");
    decodes.get(IMG("B")).resolve({ src: IMG("B") });
    await p2;
    assertShowsB(page);
    decodes.get(IMG("A")).resolve({ src: IMG("A") });
    await p1;
    assertShowsB(page);
  });
});

/** fetch stub for the real pick/demo paths: holds each /loci POST open until the test answers it. */
function stubFetch() {
  const posts = new Map();
  const fetchFn = async (url, init) => {
    if (String(url) === "/demo/photo.jpg") {
      return new Response(new Uint8Array([0x44]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (String(url) === "/loci") {
      const first = new Uint8Array(await new Response(init.body).arrayBuffer())[0];
      const d = deferred();
      posts.set(first === 0x50 ? "pick" : "demo", d);
      return d.promise;
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { posts, fetchFn };
}

/** Another showUpload caller on the same page; its /loci body starts 0x50, so stubFetch keys it "pick". */
const otherUpload = (deps) =>
  app.showUpload(() => deps.fetch("/loci", { method: "POST", body: new Uint8Array([0x50]) }), "could not send", deps);

// Covers: MEM-017, MEM-073
// Requirement: "Load demo" and any other upload share one gate: whichever started later wins.
describe("Load demo and another upload share one gate", () => {
  test("Load demo started after another upload supersedes it", async () => {
    const page = fakePage();
    const { posts, fetchFn } = stubFetch();
    const deps = depsFor(page, { fetch: fetchFn });
    const pPick = otherUpload(deps);
    await until(() => posts.has("pick"), "pick POSTs /loci");
    const pDemo = app.onLoadDemo(deps);
    await until(() => posts.has("demo"), "demo POSTs /loci");
    posts.get("pick").resolve(jsonResponse(payload("A", ["chair"])));
    await pPick;
    assert.deepEqual(page.drawn, [], "the superseded pick must not draw");
    assert.deepEqual(page.captions(), []);
    posts.get("demo").resolve(jsonResponse(payload("B", ["lamp", "door"])));
    await pDemo;
    assertShowsB(page);
  });

  test("an upload started after Load demo supersedes the demo", async () => {
    const page = fakePage();
    const { posts, fetchFn } = stubFetch();
    const deps = depsFor(page, { fetch: fetchFn });
    const pDemo = app.onLoadDemo(deps);
    await until(() => posts.has("demo"), "demo POSTs /loci");
    const pPick = otherUpload(deps);
    await until(() => posts.has("pick"), "pick POSTs /loci");
    posts.get("demo").resolve(jsonResponse(payload("A", ["chair"])));
    await pDemo;
    assert.deepEqual(page.drawn, [], "the superseded demo must not draw");
    posts.get("pick").resolve(jsonResponse(payload("B", ["lamp", "door"])));
    await pPick;
    assertShowsB(page);
  });
});

// Covers: MEM-017
// Requirement: a new upload never leaves the previous photo's result on screen. Starting an upload
// clears the canvas (resized to 0x0) and empties the loci list before the request answers, so an
// upload that then fails (error response or a send that rejects) shows only its failure status,
// never the previous photo's picture and numbered places.
describe("upload start clears the previous result", () => {
  async function drawB(page, deps) {
    await app.showUpload(async () => jsonResponse(payload("B", ["lamp", "door"])), "could not send", deps);
    assertShowsB(page);
  }

  const assertCleared = (page, when) => {
    assert.equal(page.canvas.width, 0, `canvas width ${when}`);
    assert.equal(page.canvas.height, 0, `canvas height ${when}`);
    assert.deepEqual(page.captions(), [], `loci list ${when}`);
  };

  test("the previous result is cleared as soon as a new upload starts", async () => {
    const page = fakePage();
    const deps = depsFor(page);
    await drawB(page, deps);
    const d = deferred();
    const p = app.showUpload(() => d.promise, "could not send", deps);
    assertCleared(page, "while the new upload is in flight");
    d.resolve(jsonResponse(payload("C", ["sofa"])));
    await p;
    assert.deepEqual(page.captions(), ["sofa"]);
  });

  test("an upload that answers with an error leaves the canvas cleared and the list empty", async () => {
    const page = fakePage();
    const deps = depsFor(page);
    await drawB(page, deps);
    await app.showUpload(async () => jsonResponse({ error: "upstream" }, 502), "could not send", deps);
    assert.equal(page.status.textContent, "Upload failed: upstream");
    assertCleared(page, "after an error response");
  });

  test("an upload whose send rejects leaves the canvas cleared and the list empty", async () => {
    const page = fakePage();
    const deps = depsFor(page);
    await drawB(page, deps);
    await app.showUpload(async () => {
      throw new TypeError("network down");
    }, "could not send", deps);
    assert.equal(page.status.textContent, "Upload failed: could not send");
    assertCleared(page, "after a rejected send");
  });
});

// Covers: MEM-017
// Requirement: the loci list shows each place's number exactly once. index.html renders the list
// as <ol id="loci">, whose own marker supplies the number, so each rendered <li> text is the
// locus label only ("frame", never "1. frame" -- the bug rendered "1. 1. frame" after Load demo).
// Labels are shown verbatim (a label that starts with a digit is not altered). Canvas box badges
// keep their locus numbers, and list position i (marker i+1) is locus n = i+1, so every badge
// number names the same place as the list item with that marker; a locus without a box gets no
// badge but still keeps its list slot.
describe("loci list shows each number once", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const LEADING_NUMBER = /^\s*\d+\s*[.):-]/;

  function demoFetch(body) {
    return async (url) => {
      if (String(url) === "/demo/photo.jpg") {
        return new Response(new Uint8Array([0x44]), { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      if (String(url) === "/loci") return jsonResponse(body);
      throw new Error(`unexpected url ${url}`);
    };
  }

  test("index.html renders the loci as an ordered list <ol id=\"loci\">", () => {
    assert.match(html, /<ol\b[^>]*\bid="loci"/);
  });

  test("after Load demo each list item's text is the label only", async () => {
    const page = fakePage();
    const labels = ["frame", "clock", "lamp", "door"];
    await app.onLoadDemo(depsFor(page, { fetch: demoFetch(payload("D", labels)) }));
    assert.equal(page.status.textContent, "Found 4 places");
    assert.deepEqual(page.list.children.map((c) => c.tagName), ["LI", "LI", "LI", "LI"]);
    assert.deepEqual(page.captions(), labels);
    for (const text of page.captions()) {
      assert.doesNotMatch(text, LEADING_NUMBER, `list item "${text}" repeats the <ol> number`);
    }
  });

  test("a label that itself starts with a digit is shown verbatim", async () => {
    const page = fakePage();
    const labels = ["2 chairs", "frame", "10 books"];
    await app.showUpload(async () => jsonResponse(payload("E", labels)), "could not send", depsFor(page));
    assert.deepEqual(page.captions(), labels);
  });

  test("canvas badges keep their numbers and match the list order", async () => {
    const page = fakePage();
    const labels = ["frame", "clock", "lamp", "door"];
    await app.onLoadDemo(depsFor(page, { fetch: demoFetch(payload("D", labels)) }));
    assert.deepEqual(page.badges, ["1", "2", "3", "4"], "each boxed locus keeps its number badge");
    // List position i carries <ol> marker i+1, which must be the badge number of the same label.
    assert.deepEqual(page.captions(), labels);
  });

  test("a locus without a box gets no badge but keeps its list slot", async () => {
    const page = fakePage();
    const body = payload("F", ["frame", "clock", "lamp"]);
    delete body.loci[1].box;
    await app.showUpload(async () => jsonResponse(body), "could not send", depsFor(page));
    assert.deepEqual(page.badges, ["1", "3"]);
    assert.deepEqual(page.captions(), ["frame", "clock", "lamp"]);
  });
});
