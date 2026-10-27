// Covers: MEM-025
// Requirement: place history is opt-in and private. A settings toggle "Use my location for place
// history" is OFF by default and persisted in localStorage (a throwing storage reads as off); while
// off no POST /place is made and the location is never asked for; toggling off discards the
// confirmed place, so the next /associate body carries no auto place (a typed place is still sent).
// When on, coords come from the ORIGINAL file's EXIF GPS (read before the re-encode strips it),
// falling back to geolocation, and are sent to POST /place rounded to 4 decimal places.
// Contract (RED; GREEN implements, ADR 0022):
//   place.js exports
//     readGps(bytes) -> {lat, lon} | null; bytes is a Uint8Array or ArrayBuffer of a JPEG. Parses the
//       APP1 Exif GPS IFD (II or MM byte order, N/S/E/W refs); null for no Exif/no GPS/non-JPEG/
//       truncated input, never throws.
//     createPlaceState(storage) -> {enabled(), setEnabled(on), confirm(place), setTyped(title),
//       current()}; storage is a localStorage-like {getItem, setItem}; place = {title, extract};
//       current() -> the place to send or null; setEnabled(false) discards the confirmed place.
//   app.js
//     onPhotoChange(input, deps): deps also takes {place: createPlaceState(...), geolocate}, where
//       geolocate() resolves {lat, lon} | null. When place.enabled(): POST "/place" JSON {lat, lon}.
//     runAssociations(pairs, deps): deps also takes {place}; a non-null place.current() adds
//       "place" to the /associate body, else the body stays exactly {image, item, locus}.
//   index.html has an unchecked #place-toggle labelled "Use my location for place history".
// Tests drive the page's own handlers (.claude/rules/client-transform-tests-drive-browser-path.md).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as app from "./app.js";
import { createPalaceStore } from "./palace_store.js";

/** Imported per test, so a missing place.js fails each test rather than the whole file. */
const placeModule = () => import("./place.js");

const tick = () => new Promise((r) => setImmediate(r));

/** Turn the event loop until cond() holds; bounded by turns, never by wall-clock time. */
async function until(cond, label) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await tick();
  }
  assert.fail(`never reached: ${label}`);
}

async function settle() {
  for (let i = 0; i < 50; i++) await tick();
}

// ---------------------------------------------------------------- EXIF JPEG builder (in-test bytes)

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const APP0_JFIF = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];

/**
 * TIFF block: IFD0 holding a GPS IFD pointer (or only an Orientation tag when gps is null), then a
 * GPS IFD with LatRef/Lat/LonRef/Lon; each coordinate is three rationals [num, den].
 */
function tiff({ le = true, gps }) {
  const buf = new ArrayBuffer(128);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const u16 = (o, x) => v.setUint16(o, x, le);
  const u32 = (o, x) => v.setUint32(o, x, le);
  u8.set(le ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  u16(2, 42);
  u32(4, 8);
  u16(8, 1);
  if (!gps) {
    // Orientation (SHORT, inline) only: Exif present, no GPS.
    u16(10, 0x0112);
    u16(12, 3);
    u32(14, 1);
    u16(18, 1);
    u32(22, 0);
    return u8.slice(0, 26);
  }
  u16(10, 0x8825);
  u16(12, 4);
  u32(14, 1);
  u32(18, 26);
  u32(22, 0);
  u16(26, 4);
  const entry = (i, tag, type, count, value) => {
    const e = 28 + i * 12;
    u16(e, tag);
    u16(e + 2, type);
    u32(e + 4, count);
    if (typeof value === "string") u8.set([value.charCodeAt(0), 0], e + 8);
    else u32(e + 8, value);
  };
  entry(0, 1, 2, 2, gps.latRef);
  entry(1, 2, 5, 3, 80);
  entry(2, 3, 2, 2, gps.lonRef);
  entry(3, 4, 5, 3, 104);
  u32(76, 0);
  const rationals = (at, parts) => parts.forEach(([n, d], i) => (u32(at + i * 8, n), u32(at + i * 8 + 4, d)));
  rationals(80, gps.lat);
  rationals(104, gps.lon);
  return u8;
}

function jpeg({ jfif = false, exif = null } = {}) {
  const parts = [...SOI];
  if (jfif) parts.push(...APP0_JFIF);
  if (exif) {
    const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...exif];
    const len = body.length + 2;
    parts.push(0xff, 0xe1, len >> 8, len & 0xff, ...body);
  }
  parts.push(...EOI);
  return Uint8Array.from(parts);
}

// 51 deg 30' 2.6244" N, 0 deg 7' 28.56" W -> 51.500729, -0.1246 (Big Ben).
const LONDON = { latRef: "N", lat: [[51, 1], [30, 1], [26244, 10000]], lonRef: "W", lon: [[0, 1], [7, 1], [2856, 100]] };
// 33 deg 51' 54.5" S, 151 deg 12' 55.08" E -> -33.865139, 151.2153.
const SYDNEY = { latRef: "S", lat: [[33, 1], [51, 1], [545, 10]], lonRef: "E", lon: [[151, 1], [12, 1], [5508, 100]] };

const GPS_JPEG = jpeg({ jfif: true, exif: tiff({ gps: LONDON }) });
const PLAIN_JPEG = jpeg({ jfif: true });

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-4, `${label}: ${actual} not within 1e-4 of ${expected}`);
}

// ---------------------------------------------------------------- fakes

function memoryStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

function throwingStorage() {
  const fail = () => {
    throw new Error("SecurityError: storage disabled");
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Minimal DOM node: textContent covers descendants; append/replaceChildren as in the DOM. */
function el(tag) {
  let own = "";
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    hidden: false,
    attrs: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    get textContent() {
      return own + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
    },
    set textContent(v) {
      own = String(v);
      this.children = [];
    },
    append(...c) {
      this.children.push(...c);
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    replaceChildren(...c) {
      own = "";
      this.children = c;
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function fakeDoc() {
  const canvasCtx = { drawImage() {}, strokeRect() {}, fillRect() {}, fillText() {}, clearRect() {} };
  const canvas = { ...el("canvas"), width: 0, height: 0, parentElement: { clientWidth: 1000 }, getContext: () => canvasCtx };
  const els = {
    "upload-status": el("p"),
    scene: canvas,
    loci: el("ol"),
    "assoc-status": el("p"),
    associations: el("div"),
  };
  return {
    els,
    getElementById: (id) => els[id] ?? null,
    createElement: (tag) => el(tag),
    createTextNode: (t) => String(t),
  };
}

const LOCI = { image: "data:image/jpeg;base64,QQ==", width: 800, height: 600, loci: [{ n: 1, label: "lamp" }] };

/** Fetch stub: /loci answers LOCI, /place answers one place; records every call. */
function recordingFetch() {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === "/loci") return jsonResponse(LOCI);
    if (String(url) === "/place") {
      return jsonResponse({ places: [{ title: "Big Ben", distance_m: 13, extract: "Big Ben is a bell." }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const placeCalls = () => calls.filter((c) => c.url === "/place");
  return { fn, calls, placeCalls };
}

function photoInput(bytes) {
  return { files: [new File([bytes], "room.jpg", { type: "image/jpeg" })], value: "C:\\fakepath\\room.jpg" };
}

function uploadDeps(place, fetchFn, geolocate) {
  return {
    doc: fakeDoc(),
    loadImage: async (src) => ({ src }),
    fetch: fetchFn,
    // Stands in for the canvas re-encode: EXIF-free output, so GPS can only come from the original file.
    encode: async () => PLAIN_JPEG,
    place,
    geolocate,
  };
}

function geolocateSpy(result = null) {
  const spy = async () => {
    spy.calls += 1;
    return result;
  };
  spy.calls = 0;
  return spy;
}

// ---------------------------------------------------------------- tests

// Covers: MEM-025
// Requirement: the EXIF GPS reader returns the photo's coordinates from its APP1 Exif GPS IFD in
// either byte order with N/S/E/W signs, and null (never an exception) for any photo without GPS.
describe("readGps", () => {
  test("reads a little-endian GPS JPEG after an APP0 JFIF segment (N/W)", async () => {
    const { readGps } = await placeModule();
    const gps = readGps(GPS_JPEG);
    assert.ok(gps, "expected coords");
    near(gps.lat, 51.5007, "lat");
    near(gps.lon, -0.1246, "lon");
  });

  test("reads a big-endian GPS JPEG (S/E) passed as an ArrayBuffer", async () => {
    const { readGps } = await placeModule();
    const bytes = jpeg({ exif: tiff({ le: false, gps: SYDNEY }) });
    const gps = readGps(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.ok(gps, "expected coords");
    near(gps.lat, -33.8651, "lat");
    near(gps.lon, 151.2153, "lon");
  });

  test("returns null for a JPEG with no Exif segment", async () => {
    const { readGps } = await placeModule();
    assert.equal(readGps(PLAIN_JPEG), null);
  });

  test("returns null for Exif without a GPS IFD", async () => {
    const { readGps } = await placeModule();
    assert.equal(readGps(jpeg({ exif: tiff({ gps: null }) })), null);
  });

  test("returns null for non-JPEG, empty and truncated input without throwing", async () => {
    const { readGps } = await placeModule();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const bytes of [png, new Uint8Array(0), Uint8Array.from([0xff]), GPS_JPEG.slice(0, 40), GPS_JPEG.slice(0, 120)]) {
      assert.equal(readGps(bytes), null, `bytes of length ${bytes.length}`);
    }
  });
});

// Covers: MEM-025
// Requirement: the place-history toggle is off by default, persists across page loads in
// localStorage, survives a storage that throws (reads as off, writes never throw), and the page
// ships it unchecked with its label.
describe("place toggle", () => {
  test("defaults off with empty storage and with a throwing storage", async () => {
    const { createPlaceState } = await placeModule();
    assert.equal(createPlaceState(memoryStorage()).enabled(), false);
    const broken = createPlaceState(throwingStorage());
    assert.equal(broken.enabled(), false);
    assert.doesNotThrow(() => broken.setEnabled(true));
  });

  test("on and then one-tap off both persist to a new page load", async () => {
    const { createPlaceState } = await placeModule();
    const storage = memoryStorage();
    createPlaceState(storage).setEnabled(true);
    assert.equal(createPlaceState(storage).enabled(), true);
    createPlaceState(storage).setEnabled(false);
    assert.equal(createPlaceState(storage).enabled(), false);
  });

  test("index.html has the unchecked #place-toggle with its label", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    const input = html.match(/<input\b[^>]*\bid="place-toggle"[^>]*>/);
    assert.ok(input, "missing #place-toggle input");
    assert.match(input[0], /\btype="checkbox"/);
    assert.doesNotMatch(input[0], /\bchecked\b/);
    assert.match(html, /Use my location for place history/);
  });
});

// Covers: MEM-025
// Requirement: while the toggle is off a photo pick makes no POST /place and never asks for the
// location; when on, the original file's EXIF GPS (not the re-encoded bytes) is sent rounded to
// 4 dp, with geolocation only as the fallback for a photo without GPS.
describe("place lookup on photo pick", () => {
  test("toggle off (default): no /place request and no geolocation, even for a GPS photo", async () => {
    const { createPlaceState } = await placeModule();
    const fetch = recordingFetch();
    const geolocate = geolocateSpy({ lat: 1, lon: 2 });
    await app.onPhotoChange(photoInput(GPS_JPEG), uploadDeps(createPlaceState(memoryStorage()), fetch.fn, geolocate));
    await settle();
    assert.ok(fetch.calls.some((c) => c.url === "/loci"), "the upload itself still runs");
    assert.deepEqual(fetch.placeCalls(), []);
    assert.equal(geolocate.calls, 0);
  });

  test("toggled on then off: no /place request", async () => {
    const { createPlaceState } = await placeModule();
    const state = createPlaceState(memoryStorage());
    state.setEnabled(true);
    state.setEnabled(false);
    const fetch = recordingFetch();
    const geolocate = geolocateSpy({ lat: 1, lon: 2 });
    await app.onPhotoChange(photoInput(GPS_JPEG), uploadDeps(state, fetch.fn, geolocate));
    await settle();
    assert.deepEqual(fetch.placeCalls(), []);
    assert.equal(geolocate.calls, 0);
  });

  test("toggle on: POST /place with the original file's GPS rounded to 4 dp", async () => {
    const { createPlaceState } = await placeModule();
    const state = createPlaceState(memoryStorage());
    state.setEnabled(true);
    const fetch = recordingFetch();
    const geolocate = geolocateSpy({ lat: 1, lon: 2 });
    await app.onPhotoChange(photoInput(GPS_JPEG), uploadDeps(state, fetch.fn, geolocate));
    await until(() => fetch.placeCalls().length > 0, "POST /place");
    const [call] = fetch.placeCalls();
    assert.equal(call.init.method, "POST");
    assert.deepEqual(JSON.parse(call.init.body), { lat: 51.5007, lon: -0.1246 });
    assert.equal(geolocate.calls, 0, "EXIF GPS wins over geolocation");
  });

  test("toggle on, photo without GPS: falls back to geolocation, rounded to 4 dp", async () => {
    const { createPlaceState } = await placeModule();
    const state = createPlaceState(memoryStorage());
    state.setEnabled(true);
    const fetch = recordingFetch();
    const geolocate = geolocateSpy({ lat: 40.689247, lon: -74.044502 });
    await app.onPhotoChange(photoInput(PLAIN_JPEG), uploadDeps(state, fetch.fn, geolocate));
    await until(() => fetch.placeCalls().length > 0, "POST /place");
    assert.equal(geolocate.calls, 1);
    assert.deepEqual(JSON.parse(fetch.placeCalls()[0].init.body), { lat: 40.6892, lon: -74.0445 });
  });
});

// Covers: MEM-025
// Requirement: a confirmed place rides the next /associate body; toggling off discards it (and
// re-enabling does not bring it back), so the body is exactly {image, item, locus} again, while a
// typed place is still sent with the toggle off.
describe("place on /associate", () => {
  const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
  const PAIRS = [{ item: "milk", locus: { n: 1, label: "lamp" } }];
  const CONFIRMED = { title: "Big Ben", extract: "Big Ben is a bell." };

  function memoryAdapter() {
    const map = new Map();
    return {
      get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
      put: async (k, v) => void map.set(k, structuredClone(v)),
      list: async () => [...map.values()],
    };
  }

  /** One runAssociations pass on a fresh store (so it always POSTs); returns the parsed body. */
  async function associateBody(place) {
    const bodies = [];
    const fetch = async (url, init) => {
      assert.equal(String(url), "/associate");
      const body = JSON.parse(init.body);
      bodies.push(body);
      const record = { item: body.item, locus: body.locus, question: "q", answer: "a" };
      for (const c of app.KAVE_CHANNELS) record[c] = `${c} ${body.item} ${body.locus}`;
      return jsonResponse({ record, status: "valid" });
    };
    const deps = { doc: fakeDoc(), fetch, store: createPalaceStore(memoryAdapter()), image: IMAGE, place };
    await app.runAssociations(PAIRS, deps);
    assert.equal(bodies.length, 1);
    return bodies[0];
  }

  test("a confirmed place is sent while the toggle is on", async () => {
    const { createPlaceState } = await placeModule();
    const state = createPlaceState(memoryStorage());
    state.setEnabled(true);
    state.confirm(CONFIRMED);
    const body = await associateBody(state);
    assert.deepEqual(body.place, CONFIRMED);
  });

  test("toggling off drops the place from the next /associate body", async () => {
    const { createPlaceState } = await placeModule();
    const state = createPlaceState(memoryStorage());
    state.setEnabled(true);
    state.confirm(CONFIRMED);
    state.setEnabled(false);
    assert.equal(state.current(), null);
    const body = await associateBody(state);
    assert.deepEqual(Object.keys(body).sort(), ["image", "item", "locus"]);
  });

  test("re-enabling does not bring back the discarded place", async () => {
    const { createPlaceState } = await placeModule();
    const state = createPlaceState(memoryStorage());
    state.setEnabled(true);
    state.confirm(CONFIRMED);
    state.setEnabled(false);
    state.setEnabled(true);
    const body = await associateBody(state);
    assert.equal("place" in body, false);
  });

  test("a typed place is still sent with the toggle off", async () => {
    const { createPlaceState } = await placeModule();
    const state = createPlaceState(memoryStorage());
    state.setTyped("Grandma's kitchen");
    const body = await associateBody(state);
    assert.equal(state.enabled(), false);
    assert.equal(body.place.title, "Grandma's kitchen");
  });
});
