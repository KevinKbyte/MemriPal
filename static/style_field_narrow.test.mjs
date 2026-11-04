// Covers: MEM-072
// Requirement: a .field (label + control, display: grid) never widens the page past a 360px viewport.
// A grid item's min-width is auto, so the native file input (#photo, "Choose File / No file chosen",
// whose intrinsic width depends on the system font) set the track width and gave scrollWidth 373 at
// 360px in e2e step 13. The column is minmax(0, 1fr) and the file input is capped at 100%.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("./style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Declarations of every top-level rule whose selector list names `sel` exactly. */
function declsFor(sel) {
  /** @type {Record<string, string>} */
  const out = {};
  // Top-level rules only: drop @media/@supports blocks (one nesting level) first.
  const flat = CSS.replace(/@[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(",").map((s) => s.replace(/\s+/g, " ").trim().replace(/'/g, '"'));
    if (!sels.includes(sel)) continue;
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).replace(/\s+/g, " ").trim();
    }
  }
  return out;
}

test(".field grid column can shrink below its content (minmax(0, 1fr))", () => {
  assert.equal(declsFor(".field")["grid-template-columns"], "minmax(0, 1fr)");
});

test('input[type="file"] is capped at its container width', () => {
  assert.equal(declsFor('input[type="file"]')["max-width"], "100%");
});
