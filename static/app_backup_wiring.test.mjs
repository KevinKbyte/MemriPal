// Covers: MEM-054
// Requirement: the production page hands backup export a thumbnail encoder and backup import an
// image decoder, so Download backup with a saved route does not throw and Import can check photos.
// Source-level: app.js's bootstrap runs only under a real document (guarded for node --test) and
// wireApp is an imported binding, so no behavioral seam reaches the deps object it is given.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./app.js", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'])\/\/.*$/gm, "$1");

/** Text between the brace at `open` and its matching close brace. */
function braced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error("unbalanced braces");
}

const guard = src.indexOf('if (typeof document !== "undefined")');
const bootstrap = guard < 0 ? "" : braced(src, src.indexOf("{", guard));
const call = bootstrap.indexOf("wireApp({");
const wireAppArg = call < 0 ? "" : braced(bootstrap, call + "wireApp(".length);

describe("app.js bootstrap backup wiring (MEM-054)", () => {
  test("the bootstrap calls wireApp with an object literal", () => {
    assert.ok(guard >= 0, "app.js lost its typeof document bootstrap guard");
    assert.ok(wireAppArg.length > 0, "no wireApp({...}) call found in the bootstrap");
  });

  // Requirement: buildBackup gets deps.thumbnail from the real page, built by thumbnail.js.
  test("wireApp receives a thumbnail dep built from ./thumbnail.js", () => {
    assert.match(
      src,
      /import\s*\{[^}]*\bcreateThumbnail\b[^}]*\}\s*from\s*["']\.\/thumbnail\.js["']/,
      "app.js must import createThumbnail from ./thumbnail.js",
    );
    assert.match(wireAppArg, /(^|[\s,{])thumbnail\s*[:,}]|(^|[\s,{])thumbnail\s*$/m,
      `wireApp({...}) has no thumbnail property:\n${wireAppArg}`);
  });

  // Requirement: importBackup gets deps.loadImage from the real page (directly or via wireUpload's deps).
  test("wireApp receives a loadImage dep", () => {
    const direct = /(^|[\s,{])loadImage\s*[:,}]|(^|[\s,{])loadImage\s*$/m.test(wireAppArg);
    let viaUpload = false;
    if (/\.\.\.\s*wireUpload\s*\(\s*\)/.test(wireAppArg)) {
      const fn = src.indexOf("function wireUpload(");
      const body = fn < 0 ? "" : braced(src, src.indexOf("{", fn));
      const ret = body.match(/return\s+(\w+)\s*;/);
      const decl = ret && body.match(new RegExp(`const\\s+${ret[1]}\\s*=\\s*\\{`));
      const obj = decl ? braced(body, decl.index + decl[0].length - 1) : "";
      viaUpload = /(^|[\s,{])loadImage\s*[:,}]|(^|[\s,{])loadImage\s*$/m.test(obj);
    }
    assert.ok(direct || viaUpload, `wireApp({...}) gets no loadImage:\n${wireAppArg}`);
  });
});
