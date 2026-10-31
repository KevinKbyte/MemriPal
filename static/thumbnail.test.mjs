// Covers: MEM-054
// Requirement: a backup's station photos are re-encoded JPEG thumbnails whose long side is at most
// maxSide (640 in production), aspect kept, never upscaled, encoded at the requested quality, with
// the source size reported so the station box can be scaled; the result's bytes feed the backup.
//
// Factory shape: createThumbnail({createImageBitmap, createCanvas}) -> Thumbnail, where
//   createImageBitmap(photo, opts?) -> Promise<{width, height, close?()}>
//   createCanvas(width, height) -> {getContext("2d") -> {drawImage(...)} | null, toBlob(cb, type, quality)}
// and Thumbnail is the backup_routes.js typedef: (photo, {maxSide, quality}) =>
//   Promise<{bytes, width, height, sourceWidth, sourceHeight}>.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createThumbnail } from "./thumbnail.js";
import { exportRoutes } from "./backup_routes.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);

/** Fake browser seams recording what the factory asked for. */
function fakes({ width, height, blob = new Blob([JPEG], { type: "image/jpeg" }), ctx = true }) {
  const log = { bitmapArgs: [], canvases: [], draws: [], encodes: [] };
  const deps = {
    createImageBitmap: async (photo, opts) => {
      log.bitmapArgs.push({ photo, opts });
      return { width, height, close() {} };
    },
    createCanvas: (w, h) => {
      const canvas = {
        width: w,
        height: h,
        getContext: (kind) =>
          ctx && kind === "2d" ? { drawImage: (...args) => log.draws.push({ canvas, args }) } : null,
        toBlob: (cb, type, quality) => {
          log.encodes.push({ type, quality });
          queueMicrotask(() => cb(blob));
        },
      };
      log.canvases.push(canvas);
      return canvas;
    },
  };
  return { deps, log };
}

const OPTS = { maxSide: 640, quality: 0.7 };

async function run(width, height, opts = OPTS, extra = {}) {
  const { deps, log } = fakes({ width, height, ...extra });
  const photo = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
  const out = await createThumbnail(deps)(photo, opts);
  return { out, log, photo };
}

describe("createThumbnail (MEM-054 backup thumbnails)", () => {
  // Requirement: a landscape photo larger than maxSide shrinks so its long side is exactly maxSide.
  test("landscape 4000x3000 -> 640x480, source size reported", async () => {
    const { out, log, photo } = await run(4000, 3000);
    assert.equal(out.width, 640);
    assert.equal(out.height, 480);
    assert.equal(out.sourceWidth, 4000);
    assert.equal(out.sourceHeight, 3000);
    assert.equal(log.bitmapArgs[0].photo, photo, "the stored photo is what gets decoded");
    assert.equal(log.draws.length, 1, "the bitmap is drawn once");
    const { canvas } = log.draws[0];
    assert.equal(canvas.width, 640);
    assert.equal(canvas.height, 480);
  });

  // Requirement: portrait photos scale by their height, the long side.
  test("portrait 3000x4000 -> 480x640", async () => {
    const { out } = await run(3000, 4000);
    assert.deepEqual([out.width, out.height, out.sourceWidth, out.sourceHeight], [480, 640, 3000, 4000]);
  });

  // Requirement: a square photo becomes a maxSide square.
  test("square 1000x1000 -> 640x640", async () => {
    const { out } = await run(1000, 1000);
    assert.deepEqual([out.width, out.height], [640, 640]);
  });

  // Requirement: a photo whose long side is exactly maxSide keeps its size.
  test("exactly maxSide 640x480 stays 640x480", async () => {
    const { out } = await run(640, 480);
    assert.deepEqual([out.width, out.height, out.sourceWidth, out.sourceHeight], [640, 480, 640, 480]);
  });

  // Requirement: a photo smaller than maxSide is never upscaled.
  test("small 300x200 is not upscaled", async () => {
    const { out, log } = await run(300, 200);
    assert.deepEqual([out.width, out.height], [300, 200]);
    assert.deepEqual([log.draws[0].canvas.width, log.draws[0].canvas.height], [300, 200]);
  });

  // Requirement: maxSide comes from the caller, not a constant inside the module.
  test("honours a caller-supplied maxSide", async () => {
    const { out } = await run(1000, 500, { maxSide: 100, quality: 0.5 });
    assert.deepEqual([out.width, out.height], [100, 50]);
  });

  // Requirement: across shapes the long side never exceeds maxSide, the short side stays >= 1 px,
  // and aspect is kept to within one pixel of rounding.
  test("long side <= maxSide, aspect kept, short side >= 1 across a grid of sizes", async () => {
    const sides = [1, 2, 7, 333, 639, 640, 641, 1001, 2048, 4095, 9000];
    for (const w of sides) {
      for (const h of sides) {
        const { out } = await run(w, h);
        const label = `${w}x${h} -> ${out.width}x${out.height}`;
        assert.ok(Number.isInteger(out.width) && Number.isInteger(out.height), label);
        assert.ok(Math.max(out.width, out.height) <= 640, label);
        assert.ok(out.width >= 1 && out.height >= 1, label);
        assert.ok(out.width <= w && out.height <= h, `never upscaled: ${label}`);
        if (Math.max(w, h) > 640) assert.equal(Math.max(out.width, out.height), 640, label);
        const k = Math.min(1, 640 / Math.max(w, h));
        assert.ok(Math.abs(out.width - w * k) <= 1 && Math.abs(out.height - h * k) <= 1, `aspect: ${label}`);
      }
    }
  });

  // Requirement: the thumbnail is encoded as a JPEG at the requested quality.
  test("encodes via toBlob as image/jpeg at the given quality", async () => {
    const { log } = await run(4000, 3000, { maxSide: 640, quality: 0.42 });
    assert.deepEqual(log.encodes, [{ type: "image/jpeg", quality: 0.42 }]);
  });

  // Requirement: an encoder that yields no blob is a failure, never an empty photo in the backup.
  test("rejects when toBlob yields null", async () => {
    await assert.rejects(run(4000, 3000, OPTS, { blob: null }), Error);
  });

  // Requirement: a canvas without a 2d context is a failure, not a blank thumbnail.
  test("rejects when the canvas has no 2d context", async () => {
    await assert.rejects(run(4000, 3000, OPTS, { ctx: false }), Error);
  });

  // Requirement: the returned bytes are what backup export embeds: the station photo in an exported
  // route is exactly the encoded JPEG, as a data:image/jpeg;base64 URL.
  test("bytes feed exportRoutes: the exported photo is the encoded JPEG", async () => {
    const { deps } = fakes({ width: 4000, height: 3000 });
    const thumbnail = createThumbnail(deps);
    const station = (n) => ({
      id: `s${n}`, n, name: `Station ${n}`, status: "named", photo_ref: `p${n}`,
      box: { x1: 0, y1: 0, x2: 4000, y2: 3000 }, profile: null, taps: null,
    });
    const routes = {
      listRoutes: async () => [{
        id: "r1", name: "Walk", kind: "daily", created_at: "2026-10-31T00:00:00.000Z",
        status: "saved", lists: [], stations: [station(1), station(2), station(3)],
      }],
      getPhoto: async () => new Blob([new Uint8Array([9, 9, 9])], { type: "image/jpeg" }),
    };
    const [route] = await exportRoutes(/** @type {any} */ (routes), thumbnail);
    const expected = "data:image/jpeg;base64," + Buffer.from(JPEG).toString("base64");
    for (const st of route.stations) {
      assert.equal(st.photo, expected);
      assert.deepEqual(st.box, { x1: 0, y1: 0, x2: 640, y2: 480 }, "box scaled to the thumbnail");
    }
  });
});
