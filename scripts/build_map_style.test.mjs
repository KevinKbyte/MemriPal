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

// Minimal evaluator for the expression operators a POI icon-image uses; throws on anything else so an
// unsupported shape fails loudly instead of passing vacuously.
function evalExpr(expr, props) {
  if (!Array.isArray(expr)) return expr;
  const [op, ...args] = expr;
  if (op === "literal") return args[0];
  if (op === "get") return props[args[0]] ?? null;
  if (op === "==") return evalExpr(args[0], props) === evalExpr(args[1], props);
  if (op === "case") {
    for (let i = 0; i + 1 < args.length; i += 2) if (evalExpr(args[i], props)) return evalExpr(args[i + 1], props);
    return evalExpr(args[args.length - 1], props);
  }
  if (op === "coalesce") {
    for (const a of args) {
      const v = evalExpr(a, props);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }
  if (op === "match") {
    const input = evalExpr(args[0], props);
    for (let i = 1; i + 1 < args.length; i += 2) {
      const labels = Array.isArray(args[i]) ? args[i] : [args[i]];
      if (labels.includes(input)) return evalExpr(args[i + 1], props);
    }
    return evalExpr(args[args.length - 1], props);
  }
  throw new Error(`unsupported icon-image operator: ${JSON.stringify(op)}`);
}

// Every icon name an icon-image expression can resolve to. A ["get", p] output is bounded only when it
// sits in a match branch keyed on ["get", p] (its value is then one of that branch's labels); anywhere
// else, including a match fallback, it passes arbitrary tile data through and is reported as unbounded.
function iconOutputs(expr) {
  const names = new Set();
  const unbounded = [];
  const walk = (node, bound) => {
    if (typeof node === "string") return void names.add(node);
    if (!Array.isArray(node)) return void unbounded.push(JSON.stringify(node));
    const [op, ...args] = node;
    if (op === "literal" && typeof args[0] === "string") return void names.add(args[0]);
    if (op === "get") {
      if (bound && bound.prop === args[0]) bound.labels.forEach((l) => names.add(l));
      else unbounded.push(JSON.stringify(node));
      return;
    }
    if (op === "match") {
      const input = args[0];
      const prop = Array.isArray(input) && input[0] === "get" ? input[1] : null;
      for (let i = 1; i + 1 < args.length; i += 2) {
        const labels = Array.isArray(args[i]) ? args[i] : [args[i]];
        walk(args[i + 1], prop ? { prop, labels } : null);
      }
      return walk(args[args.length - 1], null);
    }
    if (op === "case") {
      for (let i = 1; i < args.length; i += 2) walk(args[i], null);
      return walk(args[args.length - 1], null);
    }
    if (op === "coalesce") return void args.forEach((a) => walk(a, null));
    unbounded.push(JSON.stringify(node));
  };
  walk(expr, null);
  return { names, unbounded };
}

for (const flavor of FLAVORS) {
  // Covers: MEM-075
  // Requirement: the Kendall map never asks MapLibre for a sprite icon the vendored sprite lacks (a
  // missing one logs `Image "townhall" could not be loaded` on every load). In buildStyle(flavor) the
  // pois layer's icon-image resolves only to "" (no icon; the label is still drawn) or a name present in
  // static/map/sprites/v4/<flavor>.json: "station" -> "train_station", a sprite kind such as "cafe" ->
  // "cafe", a kind with no sprite icon such as "townhall" -> "". No raw ["get","kind"] passthrough.
  describe(`build_map_style.mjs: buildStyle("${flavor}") pois icons exist in the sprite`, () => {
    let pois;
    let spriteNames;
    before(async () => {
      const style = (await loadBuildStyle())(flavor);
      pois = style.layers.find((l) => l.id === "pois");
      const spritePath = join(MAP_DIR, "sprites", "v4", `${flavor}.json`);
      spriteNames = new Set(Object.keys(JSON.parse(readFileSync(spritePath, "utf8"))));
    });

    test("has a pois symbol layer with icon-image and text-field", () => {
      assert.ok(pois, "no layer with id pois");
      assert.equal(pois.type, "symbol");
      assert.ok(pois.layout && pois.layout["icon-image"] !== undefined, "pois has no layout.icon-image");
      assert.ok(pois.layout["text-field"], "pois has no layout.text-field (labels must still draw)");
    });

    test('kind "townhall" (no sprite icon) resolves to ""', () => {
      assert.equal(evalExpr(pois.layout["icon-image"], { kind: "townhall" }), "");
    });

    test('kind "station" resolves to "train_station"', () => {
      assert.equal(evalExpr(pois.layout["icon-image"], { kind: "station" }), "train_station");
    });

    test('kind "cafe" (a sprite icon) resolves to "cafe"', () => {
      assert.equal(evalExpr(pois.layout["icon-image"], { kind: "cafe" }), "cafe");
    });

    test("every icon name the expression can produce is \"\" or a sprite key, with no passthrough", () => {
      const { names, unbounded } = iconOutputs(pois.layout["icon-image"]);
      assert.deepEqual(unbounded, [], "icon-image passes unbounded tile data through as an icon name");
      const missing = [...names].filter((n) => n !== "" && !spriteNames.has(n));
      assert.deepEqual(missing, [], `icon names absent from sprites/v4/${flavor}.json`);
    });
  });
}
