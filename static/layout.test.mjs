// Covers: MEM-030, MEM-044
// Requirement: the page fits a 360 px phone (D13): static/style.css is linked, no width /
// min-width / flex-basis is fixed above 360 px (px, or rem/em at 16 px) in style.css, the MEM-044 P1
// painterly theme (static/theme-painterly.css) or inline styles, and images shrink with
// max-width: 100%. The real 360 px no-horizontal-scroll check is the screenshot gate.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const css = () => {
  assert.ok(existsSync(new URL("./style.css", import.meta.url)), "static/style.css missing");
  return read("./style.css").replace(/\/\*[\s\S]*?\*\//g, "");
};

// Covers: MEM-030
// Requirement: responsive layout with no fixed width above 360 px and fluid images.
describe("responsive layout", () => {
  test("index.html links /static/style.css", () => {
    assert.match(read("./index.html"), /<link[^>]*rel="stylesheet"[^>]*href="\/static\/style\.css"/);
  });

  test("no width, min-width or flex-basis above 360px in style.css, theme-painterly.css or inline styles", () => {
    const html = read("./index.html");
    assert.ok(existsSync(new URL("./theme-painterly.css", import.meta.url)), "static/theme-painterly.css missing");
    const theme = read("./theme-painterly.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks = [css(), theme, ...[...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1])];
    for (const block of blocks) {
      for (const m of block.matchAll(/(?:^|[;{\s])(width|min-width|flex-basis)\s*:\s*([\d.]+)(px|rem|em)\b/g)) {
        const px = Number(m[2]) * (m[3] === "px" ? 1 : 16);
        assert.ok(px <= 360, `${m[1]}: ${m[2]}${m[3]} is wider than 360px`);
      }
    }
    for (const m of html.matchAll(/\swidth="(\d+)"/g)) assert.ok(Number(m[1]) <= 360, `width="${m[1]}"`);
  });

  test("images are fluid: an img rule sets max-width: 100%", () => {
    const rules = [...css().matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const ok = rules.some(
      ([, sel, decl]) => sel.split(",").some((s) => /(^|\s|>)img\b/.test(s.trim())) && /max-width\s*:\s*100%/.test(decl),
    );
    assert.ok(ok, "no img { max-width: 100% } rule");
  });
});
