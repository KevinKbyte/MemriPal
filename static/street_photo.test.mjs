// Covers: MEM-098
// Requirement: a scene derived from a Mapillary street photo always carries the full CC BY-SA 4.0 credit
// block (ADR 0058): the official Mapillary logo linked to the image page, the contributor username, a link
// to the original image, an "AI-modified" note, and "CC BY-SA 4.0" linked to the licence. Only a verified
// Mapillary image page under CC BY-SA 4.0 earns a credit; anything else yields no credit and no image.
// The credit renders through textContent only (an author string is never parsed as markup) and every link
// opens in a new tab with rel noopener.
// Contract (RED; GREEN implements the pure module static/street_photo.js):
//   creditBlock({ author, image_url, licence }) -> { author, image_url, licence, licence_url, ai_modified } | null
//   renderCredit(doc, credit, { theme } = {}) -> Element | null
//   fetchStreetPhoto({ lat, lon }, { fetchJson }) -> Promise<{ image, credit }>
//     fetchJson(path, init) resolves the parsed JSON body; it owns encoding init.body as JSON.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { fakePage, findAll } from "./fake_dom_test.mjs";

const moduleUrl = new URL("./street_photo.js", import.meta.url);

async function sp() {
  assert.ok(existsSync(moduleUrl), "static/street_photo.js missing");
  return import(moduleUrl.href);
}

const PAGE = "https://www.mapillary.com/app/?pKey=";
const IMAGE_URL = `${PAGE}1122334455667788`;
const LICENCE = "CC BY-SA 4.0";
const LICENCE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";
const AUTHOR = "kendall_walker";
const IMAGE = "data:image/jpeg;base64,/9j/AA==";
// The logo PNGs are opaque tiles named for their BACKGROUND colour: -white.png is a white tile (blends into the
// light card surface), -dark.png is a dark rgb(33,43,54) tile (blends into the dark theme).
const LOGO_LIGHT = "img/mapillary-logo-white.png";
const LOGO_DARK = "img/mapillary-logo-dark.png";

const RAW = { author: AUTHOR, image_url: IMAGE_URL, licence: LICENCE };
const CREDIT = { author: AUTHOR, image_url: IMAGE_URL, licence: LICENCE, licence_url: LICENCE_URL, ai_modified: true };

const attr = (node, name) => node.getAttribute(name) ?? (node[name] == null ? null : String(node[name]));
const elementChildren = (node) => node.children.filter((c) => c && typeof c === "object");
const anchors = (root) => findAll(root, (n) => n.tagName === "A");
const images = (root) => findAll(root, (n) => n.tagName === "IMG");

// Covers: MEM-098
// Requirement: creditBlock turns a /baseline answer into the credit data only for a verified Mapillary
// image page under CC BY-SA 4.0 with a named contributor; every other input yields null.
describe("creditBlock", () => {
  test("a verified CC BY-SA 4.0 Mapillary hit yields the full credit data", async () => {
    const { creditBlock } = await sp();
    assert.deepEqual(creditBlock(RAW), CREDIT);
  });

  test("extra input fields are not copied into the credit", async () => {
    const { creditBlock } = await sp();
    const out = creditBlock({ ...RAW, image: IMAGE, thumb_1024_url: "https://x.fbcdn.net/t.jpg" });
    assert.deepEqual(out, CREDIT);
  });

  const BAD_LICENCES = ["CC BY-NC-SA 4.0", "CC BY-SA 3.0", "cc by-sa 4.0", " CC BY-SA 4.0", "", null, undefined, 4];
  for (const licence of BAD_LICENCES) {
    test(`licence ${JSON.stringify(licence)} yields null`, async () => {
      const { creditBlock } = await sp();
      assert.equal(creditBlock({ ...RAW, licence }), null);
    });
  }

  const BAD_URLS = [
    "javascript:alert(1)",
    "http://www.mapillary.com/app/?pKey=1122334455667788",
    "HTTPS://www.mapillary.com/app/?pKey=1122334455667788",
    "https://www.mapillary.com.evil.example/app/?pKey=1122334455667788",
    "https://evil.example/?u=https://www.mapillary.com/app/?pKey=1",
    "https://scontent-lhr8-1.xx.fbcdn.net/m1/thumb.jpg",
    PAGE,
    `${PAGE}11 22`,
    "",
    null,
    undefined,
    42,
    { toString: () => IMAGE_URL },
  ];
  for (const image_url of BAD_URLS) {
    test(`image_url ${JSON.stringify(String(image_url))} (${typeof image_url}) yields null`, async () => {
      const { creditBlock } = await sp();
      assert.equal(creditBlock({ ...RAW, image_url }), null);
    });
  }

  const BAD_AUTHORS = ["", "   ", null, undefined, 42, ["a"], { username: AUTHOR }];
  for (const author of BAD_AUTHORS) {
    test(`author ${JSON.stringify(author) ?? "undefined"} yields null`, async () => {
      const { creditBlock } = await sp();
      assert.equal(creditBlock({ ...RAW, author }), null);
    });
  }

  for (const input of [null, undefined, "x", 7, []]) {
    test(`non-object input ${JSON.stringify(input) ?? "undefined"} yields null`, async () => {
      const { creditBlock } = await sp();
      assert.equal(creditBlock(input), null);
    });
  }
});

// Covers: MEM-098
// Requirement: the rendered credit shows exactly the five licence parts in order (logo link to the image
// page, contributor, original-image link, "AI-modified", licence link), built with textContent only, every
// link target _blank with rel noopener, and the official Mapillary logo tile matching the theme: the white-tile
// logo on the default light theme, the dark-tile logo on theme "dark".
describe("renderCredit", () => {
  const render = async (credit = CREDIT, opts) => {
    const { renderCredit } = await sp();
    const page = fakePage([]);
    const el = opts === undefined ? renderCredit(page.doc, credit) : renderCredit(page.doc, credit, opts);
    return { page, el };
  };

  test("renders exactly five parts in licence order", async () => {
    const { el } = await render();
    assert.ok(el && typeof el === "object", "renderCredit returned no element");
    const parts = elementChildren(el);
    assert.equal(parts.length, 5, `expected 5 parts, got ${parts.length}`);
    const [logo, author, original, note, licence] = parts;
    assert.equal(logo.tagName, "A");
    assert.equal(attr(logo, "href"), IMAGE_URL);
    assert.equal(author.textContent, AUTHOR);
    assert.equal(original.tagName, "A");
    assert.equal(attr(original, "href"), IMAGE_URL);
    assert.equal(original.textContent, "Original image");
    assert.equal(note.textContent, "AI-modified");
    assert.equal(licence.tagName, "A");
    assert.equal(attr(licence, "href"), LICENCE_URL);
    assert.equal(licence.textContent, "CC BY-SA 4.0");
  });

  test("exactly three links, each target _blank with rel containing noopener", async () => {
    const { el } = await render();
    const links = anchors(el);
    assert.equal(links.length, 3);
    for (const a of links) {
      assert.equal(attr(a, "target"), "_blank", `link ${attr(a, "href")} target`);
      const rel = String(attr(a, "rel") ?? "").split(/\s+/);
      assert.ok(rel.includes("noopener"), `link ${attr(a, "href")} rel=${attr(a, "rel")}`);
    }
  });

  test("the Mapillary link holds the official logo (white-tile logo by default) and is the only img", async () => {
    const { el } = await render();
    const [logo] = elementChildren(el);
    const inLink = images(logo);
    assert.equal(inLink.length, 1, "Mapillary link must hold exactly one img");
    assert.equal(attr(inLink[0], "src"), LOGO_LIGHT);
    assert.equal(attr(inLink[0], "alt"), "Mapillary");
    assert.equal(images(el).length, 1, "no other img in the credit");
  });

  test("theme dark swaps in the dark-tile Mapillary logo", async () => {
    const { el } = await render(CREDIT, { theme: "dark" });
    const imgs = images(el);
    assert.equal(imgs.length, 1);
    assert.equal(attr(imgs[0], "src"), LOGO_DARK);
    assert.equal(attr(imgs[0], "alt"), "Mapillary");
    assert.ok(images(elementChildren(el)[0]).includes(imgs[0]), "dark-tile logo sits inside the Mapillary link");
  });

  test("an empty options object keeps the default white-tile logo", async () => {
    const { el } = await render(CREDIT, {});
    assert.equal(attr(images(el)[0], "src"), LOGO_LIGHT);
  });

  test("a markup-looking author renders as literal text, never parsed", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    const { page, el } = await render({ ...CREDIT, author: evil });
    assert.equal(elementChildren(el)[1].textContent, evil);
    assert.deepEqual(page.htmlWrites, [], "no innerHTML/outerHTML/insertAdjacentHTML writes");
    assert.equal(images(el).length, 1, "the author string created no img");
  });

  test("no innerHTML writes for an ordinary credit either", async () => {
    const { page } = await render();
    assert.deepEqual(page.htmlWrites, []);
  });

  test("a null credit renders nothing", async () => {
    const { page, el } = await render(null);
    assert.equal(el, null);
    assert.equal(page.madeByCode().length, 0);
  });

  test("a credit that fails creditBlock rules (javascript: page link) renders nothing", async () => {
    const { page, el } = await render({ ...CREDIT, image_url: "javascript:alert(1)" });
    assert.equal(el, null);
    assert.equal(page.madeByCode().filter((n) => n.tagName === "A").length, 0);
  });
});

// Covers: MEM-098
// Requirement: the street-photo tool asks POST /baseline for the station's coords and hands back the image
// with its credit; an answer without a valid CC BY-SA 4.0 credit or a safe JPEG data URL hands back neither;
// invalid coords never reach the network.
describe("fetchStreetPhoto", () => {
  const LAT = 42.3626;
  const LON = -71.0843;
  const spy = (answer) => {
    const calls = [];
    const fetchJson = async (path, init) => {
      calls.push([path, init]);
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { calls, fetchJson };
  };
  const ANSWER = { image: IMAGE, ...RAW };

  test("posts {lat, lon} to /baseline once and resolves the image with its credit", async () => {
    const { fetchStreetPhoto } = await sp();
    const s = spy(ANSWER);
    const out = await fetchStreetPhoto({ lat: LAT, lon: LON }, { fetchJson: s.fetchJson });
    assert.deepEqual(s.calls, [["/baseline", { method: "POST", body: { lat: LAT, lon: LON } }]]);
    assert.deepEqual(out, { image: IMAGE, credit: CREDIT });
  });

  for (const [label, patch] of [
    ["non CC BY-SA 4.0 licence", { licence: "CC BY-NC-SA 4.0" }],
    ["missing licence", { licence: undefined }],
    ["non-Mapillary image_url", { image_url: "https://evil.example/p.jpg" }],
    ["empty author", { author: "" }],
  ]) {
    test(`${label}: resolves image null and credit null`, async () => {
      const { fetchStreetPhoto } = await sp();
      const s = spy({ ...ANSWER, ...patch });
      const out = await fetchStreetPhoto({ lat: LAT, lon: LON }, { fetchJson: s.fetchJson });
      assert.deepEqual(out, { image: null, credit: null });
    });
  }

  for (const image of ["https://scontent-lhr8-1.xx.fbcdn.net/t.jpg", "javascript:alert(1)", "", null, 3]) {
    test(`unsafe image ${JSON.stringify(image)}: resolves image null and credit null`, async () => {
      const { fetchStreetPhoto } = await sp();
      const s = spy({ ...ANSWER, image });
      const out = await fetchStreetPhoto({ lat: LAT, lon: LON }, { fetchJson: s.fetchJson });
      assert.deepEqual(out, { image: null, credit: null });
    });
  }

  test("a fetchJson failure propagates as a rejection", async () => {
    const { fetchStreetPhoto } = await sp();
    const s = spy(new Error("no_baseline"));
    await assert.rejects(fetchStreetPhoto({ lat: LAT, lon: LON }, { fetchJson: s.fetchJson }), /no_baseline/);
  });

  for (const [lat, lon] of [[90, 180], [-90, -180], [0, 0]]) {
    test(`boundary coords (${lat}, ${lon}) are accepted`, async () => {
      const { fetchStreetPhoto } = await sp();
      const s = spy(ANSWER);
      await fetchStreetPhoto({ lat, lon }, { fetchJson: s.fetchJson });
      assert.equal(s.calls.length, 1);
    });
  }

  const BAD = [
    [NaN, LON], [LAT, NaN], [Infinity, LON], [LAT, -Infinity],
    [90.0001, LON], [-90.0001, LON], [LAT, 180.0001], [LAT, -180.0001],
    ["42.36", LON], [LAT, "-71.08"], [null, LON], [LAT, undefined], [true, LON],
  ];
  for (const [lat, lon] of BAD) {
    test(`invalid coords (${String(lat)}, ${String(lon)}) throw before any fetch`, async () => {
      const { fetchStreetPhoto } = await sp();
      const s = spy(ANSWER);
      await assert.rejects(async () => fetchStreetPhoto({ lat, lon }, { fetchJson: s.fetchJson }));
      assert.equal(s.calls.length, 0);
    });
  }

  for (const coords of [null, undefined, {}]) {
    test(`missing coords object ${JSON.stringify(coords) ?? "undefined"} throws before any fetch`, async () => {
      const { fetchStreetPhoto } = await sp();
      const s = spy(ANSWER);
      await assert.rejects(async () => fetchStreetPhoto(coords, { fetchJson: s.fetchJson }));
      assert.equal(s.calls.length, 0);
    });
  }
});
