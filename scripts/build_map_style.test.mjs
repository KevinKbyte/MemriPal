// Covers: MEM-075
// Requirement: scripts/build_map_style.mjs turns the vendored Protomaps basemaps (5.7.2, loaded from
// vendor-node/protomaps-basemaps/basemaps.js) into self-hosted MapLibre styles. buildStyle(flavor) for
// "light" | "dark" returns a version-8 style with exactly one vector source "protomaps" at
// "pmtiles://kendall", English labels (symbol layers with text-field), glyphs and sprite served from
// /static/map/, and no http(s) URL anywhere; light and dark differ in background color. The committed
// static/map/style-light.json and style-dark.json equal buildStyle output, and every fontstack a layer
// uses has static/map/fonts/<stack>/0-255.pbf vendored.
// Run: node --test "scripts/*.test.mjs"
import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, "scripts", "build_map_style.mjs");
const MAP_DIR = join(REPO, "static", "map");
const FLAVORS = ["light", "dark"];

async function loadBuildStyle() {
  assert.ok(existsSync(SCRIPT), `missing ${relative(REPO, SCRIPT)}`);
  const mod = await import(pathToFileURL(SCRIPT).href);
  assert.equal(typeof mod.buildStyle, "function", "build_map_style.mjs must export buildStyle(flavor)");
  return mod.buildStyle;
}

// MapLibre requests glyphs per fontstack = the text-font array joined with ",". A text-font value is
// either a plain string array or an expression whose font arrays appear as ["literal", [...]].
function fontstacks(textFont) {
  const out = new Set();
  const isStrings = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string");
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (node[0] === "literal" && isStrings(node[1])) {
      out.add(node[1].join(","));
      return;
    }
    node.forEach(walk);
  };
  if (isStrings(textFont)) out.add(textFont.join(","));
  else walk(textFont);
  return out;
}

function spriteUrls(sprite) {
  if (typeof sprite === "string") return [sprite];
  if (Array.isArray(sprite)) return sprite.map((s) => s && s.url);
  return [sprite];
}

for (const flavor of FLAVORS) {
  // Covers: MEM-075
  // Requirement: buildStyle(flavor) yields a self-hosted, offline-safe MapLibre style for the Kendall extract.
  describe(`build_map_style.mjs: buildStyle("${flavor}")`, () => {
    let style;
    before(async () => {
      style = (await loadBuildStyle())(flavor);
    });

    test("is a version 8 style", () => {
      assert.equal(style.version, 8);
    });

    test("has exactly one source, protomaps, a vector source at pmtiles://kendall", () => {
      assert.deepEqual(Object.keys(style.sources || {}), ["protomaps"]);
      assert.equal(style.sources.protomaps.type, "vector");
      assert.equal(style.sources.protomaps.url, "pmtiles://kendall");
    });

    test("every non-background layer draws from the protomaps source", () => {
      const bad = style.layers.filter((l) => l.type !== "background" && l.source !== "protomaps");
      assert.deepEqual(bad.map((l) => l.id), []);
    });

    test("has at least one symbol layer with a text-field (labels)", () => {
      const labels = style.layers.filter((l) => l.type === "symbol" && l.layout && l.layout["text-field"]);
      assert.ok(labels.length >= 1, "no symbol layer carries layout.text-field");
    });

    test("glyphs and sprite are served from /static/map/", () => {
      assert.equal(typeof style.glyphs, "string", "glyphs missing");
      assert.ok(style.glyphs.startsWith("/static/map/"), `glyphs: ${style.glyphs}`);
      assert.ok(style.glyphs.includes("{fontstack}") && style.glyphs.includes("{range}"), style.glyphs);
      const urls = spriteUrls(style.sprite);
      assert.ok(urls.length >= 1, "sprite missing");
      for (const url of urls) {
        assert.ok(typeof url === "string" && url.startsWith("/static/map/"), `sprite: ${url}`);
      }
    });

    test("contains no http(s) URL anywhere", () => {
      assert.ok(!JSON.stringify(style).includes("http"), "style references an http(s) URL");
    });

    test("every fontstack used by a layer has static/map/fonts/<stack>/0-255.pbf", () => {
      const stacks = new Set();
      for (const layer of style.layers) {
        const tf = layer.layout && layer.layout["text-font"];
        if (tf !== undefined) for (const s of fontstacks(tf)) stacks.add(s);
      }
      assert.ok(stacks.size >= 1, "no layer declares text-font");
      for (const stack of stacks) {
        const pbf = join(MAP_DIR, "fonts", stack, "0-255.pbf");
        assert.ok(existsSync(pbf), `missing ${relative(REPO, pbf)}`);
      }
    });

    test(`committed static/map/style-${flavor}.json equals buildStyle("${flavor}")`, () => {
      const path = join(MAP_DIR, `style-${flavor}.json`);
      assert.ok(existsSync(path), `missing ${relative(REPO, path)}`);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), style);
    });
  });
}

// Covers: MEM-075
// Requirement: the light and dark styles are visibly different themes.
describe("build_map_style.mjs: light vs dark", () => {
  test("background layer paint colors differ between light and dark", async () => {
    const buildStyle = await loadBuildStyle();
    const bg = (flavor) => {
      const layer = buildStyle(flavor).layers.find((l) => l.type === "background");
      assert.ok(layer, `${flavor} style has no background layer`);
      return layer.paint && layer.paint["background-color"];
    };
    const light = bg("light");
    const dark = bg("dark");
    assert.ok(light && dark, "background-color missing");
    assert.notDeepEqual(light, dark);
  });
});
