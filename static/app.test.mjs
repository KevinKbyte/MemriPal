// Covers: MEM-001
// Requirement: the frontend shell renders a human-readable backend health line from /healthz.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fitScale, formatHealth, locusCaption } from "./app.js";

test("formatHealth reports the active backend mode", () => {
  assert.equal(formatHealth({ status: "ok", mode: "fixture" }), "Backend ok (fixture mode)");
});

test("formatHealth reports unavailable for missing or non-ok health", () => {
  assert.equal(formatHealth(null), "Backend unavailable");
  assert.equal(formatHealth({ status: "down" }), "Backend unavailable");
});

// Covers: MEM-017
// Requirement: each returned locus is captioned "<n>. <label>" (e.g. "1. left book"), and
// the returned photo is drawn scaled to fit the available width without ever being upscaled:
// fitScale(imgW, imgH, maxW) is min(1, maxW / imgW), and any non-positive or non-finite
// argument yields 1 (identity) so a bad dimension never produces 0, NaN or Infinity.
describe("upload UI helpers", () => {
  test("locusCaption joins the locus number and label", () => {
    assert.equal(locusCaption({ n: 1, label: "left book" }), "1. left book");
    assert.equal(locusCaption({ n: 12, label: "lamp" }), "12. lamp");
  });

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
