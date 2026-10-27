// Covers: MEM-001
// Requirement: the frontend shell renders a human-readable backend health line from /healthz.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as app from "./app.js";

const { fitScale, formatHealth } = app;

test("formatHealth reports the active backend mode", () => {
  assert.equal(formatHealth({ status: "ok", mode: "fixture" }), "Backend ok (fixture mode)");
});

test("formatHealth reports unavailable for missing or non-ok health", () => {
  assert.equal(formatHealth(null), "Backend unavailable");
  assert.equal(formatHealth({ status: "down" }), "Backend unavailable");
});

// Covers: MEM-017
// Requirement: the returned photo is drawn scaled to fit the available width without ever being
// upscaled: fitScale(imgW, imgH, maxW) is min(1, maxW / imgW), and any non-positive or non-finite
// argument yields 1 (identity) so a bad dimension never produces 0, NaN or Infinity. (The loci
// list text contract -- label only, the <ol> supplies the number -- lives in
// app_upload_flow.test.mjs "loci list shows each number once".)
describe("upload UI helpers", () => {
  test("fitScale shrinks an image wider than maxW to fit it exactly", () => {
    assert.equal(fitScale(2048, 1536, 1024), 0.5);
    assert.equal(fitScale(1000, 3000, 250), 0.25);
  });

  test("fitScale never upscales: an image at or under maxW keeps scale 1", () => {
    assert.equal(fitScale(1024, 768, 1024), 1);
    assert.equal(fitScale(800, 600, 1024), 1);
    assert.equal(fitScale(1, 1, 5000), 1);
  });

  test("fitScale returns 1 for zero, negative or non-finite arguments", () => {
    const bad = [0, -1, -2048, Number.NaN, Number.POSITIVE_INFINITY];
    for (const v of bad) {
      assert.equal(fitScale(v, 768, 1024), 1, `imgW=${v}`);
      assert.equal(fitScale(1024, v, 1024), 1, `imgH=${v}`);
      assert.equal(fitScale(2048, 1536, v), 1, `maxW=${v}`);
    }
  });

  test("fitScale is always a finite number in (0, 1] for positive inputs", () => {
    for (const w of [1, 7, 640, 1024, 2048, 4000]) {
      for (const maxW of [1, 3, 320, 1024, 9999]) {
        const s = fitScale(w, 480, maxW);
        assert.ok(Number.isFinite(s) && s > 0 && s <= 1, `fitScale(${w}, 480, ${maxW}) = ${s}`);
      }
    }
  });
});

// Covers: MEM-017
// Requirement: the page offers a camera-capable image picker
// (<input type="file" accept="image/*" capture="environment">), shows the meta-mode privacy
// notice "Your photo is sent to Meta's AI APIs to find places in it" before that picker, and
// app.js renders model-derived text via textContent only, never as HTML.
describe("upload UI markup", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const NOTICE = "Your photo is sent to Meta's AI APIs to find places in it";

  const fileInputs = () =>
    [...html.matchAll(/<input\b[^>]*>/g)].filter((m) => /\btype="file"/.test(m[0]));

  test("index.html has a camera-capable image file input", () => {
    const inputs = fileInputs();
    assert.equal(inputs.length, 1, "expected exactly one file input");
    assert.match(inputs[0][0], /\baccept="image\/\*"/);
    assert.match(inputs[0][0], /\bcapture="environment"/);
  });

  test("index.html shows the meta-mode notice before the file input", () => {
    const at = html.indexOf(NOTICE);
    assert.ok(at >= 0, "notice text missing from index.html");
    const inputs = fileInputs();
    assert.equal(inputs.length, 1, "expected exactly one file input");
    assert.ok(at < inputs[0].index, "notice must precede the file input");
  });

  test("app.js never assigns HTML strings to the DOM", () => {
    assert.doesNotMatch(js, /\b(innerHTML|outerHTML|insertAdjacentHTML)\b/);
    assert.match(js, /\.textContent\s*=/);
  });
});


// Covers: MEM-017
// Requirement: "Load demo" fetches the server's demo photo (GET /demo/photo.jpg) and POSTs exactly
// those bytes to /loci as image/jpeg with no client re-encode, so the offline fixture replay keyed
// by the processed demo sha always matches (a browser re-encode would change the bytes and answer
// "Upload failed: fixture_missing"). demoUpload(fetchFn) takes fetch as an argument, resolves to
// the /loci response, and when the demo GET fails it rejects with "http_<status>" without POSTing.
describe("Load demo raw-bytes upload", () => {
  // Every byte value, so any text decode or image re-encode would change the payload.
  const DEMO_BYTES = Uint8Array.from({ length: 512 }, (_, i) => (i * 7 + 0xff) % 256);
  DEMO_BYTES.set([0xff, 0xd8, 0xff, 0xe0], 0);

  /** Stub fetch: records [url, init] and answers by URL. */
  function stubFetch(demoResponse) {
    const calls = [];
    const postResponse = new Response(JSON.stringify({ loci: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetchFn = async (url, init) => {
      calls.push([String(url), init]);
      if (String(url) === "/demo/photo.jpg") return demoResponse();
      if (String(url) === "/loci") return postResponse;
      throw new Error(`unexpected url ${url}`);
    };
    return { calls, fetchFn, postResponse };
  }

  const okDemo = () =>
    new Response(DEMO_BYTES.slice(), { status: 200, headers: { "content-type": "image/jpeg" } });

  const asBytes = async (body) => new Uint8Array(await new Response(body).arrayBuffer());

  test("app.js exports demoUpload", () => {
    assert.equal(typeof app.demoUpload, "function");
  });

  test("GETs /demo/photo.jpg then POSTs its exact bytes to /loci as image/jpeg", async () => {
    const { calls, fetchFn, postResponse } = stubFetch(okDemo);
    const result = await app.demoUpload(fetchFn);
    assert.equal(calls.length, 2, `calls: ${calls.map((c) => c[0]).join(", ")}`);
    const [getUrl, getInit] = calls[0];
    assert.equal(getUrl, "/demo/photo.jpg");
    assert.ok(!getInit || !getInit.method || getInit.method.toUpperCase() === "GET");
    const [postUrl, postInit] = calls[1];
    assert.equal(postUrl, "/loci");
    assert.equal(postInit.method.toUpperCase(), "POST");
    assert.equal(new Headers(postInit.headers).get("content-type"), "image/jpeg");
    assert.deepEqual(await asBytes(postInit.body), DEMO_BYTES);
    assert.equal(result, postResponse);
  });

  test("a non-ok demo GET rejects with http_<status> and never POSTs", async () => {
    for (const status of [404, 500]) {
      const { calls, fetchFn } = stubFetch(() => new Response("nope", { status }));
      await assert.rejects(app.demoUpload(fetchFn), new RegExp(`http_${status}`));
      assert.deepEqual(calls.map((c) => c[0]), ["/demo/photo.jpg"]);
    }
  });

  test("a failed demo GET (network error) rejects and never POSTs", async () => {
    const calls = [];
    const fetchFn = async (url) => {
      calls.push(String(url));
      throw new TypeError("network down");
    };
    await assert.rejects(app.demoUpload(fetchFn));
    assert.deepEqual(calls, ["/demo/photo.jpg"]);
  });
});

// Covers: MEM-017
// Requirement: when two uploads overlap (a second pick or "Load demo" before the first answers),
// only the latest one's response is rendered. latestOnly() returns a gate: next() issues a token
// per upload, and isCurrent(token) is true only for the most recently issued token of that gate.
describe("latestOnly stale-response gate", () => {
  test("app.js exports latestOnly", () => {
    assert.equal(typeof app.latestOnly, "function");
  });

  test("the second of two overlapping tokens wins", () => {
    const g = app.latestOnly();
    const t1 = g.next();
    const t2 = g.next();
    assert.equal(g.isCurrent(t1), false);
    assert.equal(g.isCurrent(t2), true);
  });

  test("a lone token is current", () => {
    const g = app.latestOnly();
    const t = g.next();
    assert.equal(g.isCurrent(t), true);
  });

  test("of many overlapping tokens only the last is current", () => {
    const g = app.latestOnly();
    const tokens = Array.from({ length: 6 }, () => g.next());
    assert.deepEqual(
      tokens.map((t) => g.isCurrent(t)),
      [false, false, false, false, false, true],
    );
  });

  test("gates are independent", () => {
    const g1 = app.latestOnly();
    const g2 = app.latestOnly();
    g1.next();
    const t = g2.next();
    g1.next();
    assert.equal(g2.isCurrent(t), true);
  });
});

// Covers: MEM-017
// Requirement: the page has exactly one "Load demo" button (<button id="load-demo">) alongside the
// still-single photo file input, and app.js wires that button.
describe("Load demo markup", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("./app.js", import.meta.url), "utf8");

  test("index.html has exactly one <button id=\"load-demo\">", () => {
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].filter((m) => /\bid="load-demo"/.test(m[0]));
    assert.equal(buttons.length, 1, "expected exactly one <button id=\"load-demo\">");
    assert.equal([...html.matchAll(/\bid="load-demo"/g)].length, 1, "id load-demo must be unique");
  });

  test("index.html still has exactly one file input", () => {
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].filter((m) => /\btype="file"/.test(m[0]));
    assert.equal(inputs.length, 1, "expected exactly one file input");
  });

  test("app.js wires the load-demo button", () => {
    assert.match(js, /["']load-demo["']/);
  });
});
