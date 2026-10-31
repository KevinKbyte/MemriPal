// Covers: MEM-048
// Requirement: a captured station is never lost to a bad network. On capture the photo is re-encoded
// (EXIF, incl. GPS, dropped) and written to the route as a pending station BEFORE it is uploaded to
// POST /station. Success -> the station is named and its stored photo becomes the server's pixelated
// JPEG. A network error, any 5xx (incl. 502 blur_failed) or 429 -> it stays pending (badge + Retry);
// any other 4xx -> status "error" (Drop offered). One in-flight request per station; Capture is
// disabled while an upload is in flight; no automatic retry. A KV write failure (e.g. quota) shows an
// error on the upload status line, keeps the station in memory, and never leaves an unhandled
// rejection. The draft survives a reload.
// Contract (RED; GREEN implements, ADR route store):
//   createCaptureSession({store, routeId, fetch, encode, onStatus?}) -> {
//     capture(file, {coords?}) -> Promise (never rejects), resolves with the station or null
//     retry(stationId) -> Promise (never rejects)
//     busy() -> true while an upload is in flight (the page disables Capture on it)
//   }
//   encode(file) is app.js reencodeJpeg (injected); its output, never the raw file, is stored and sent.
//   POST to a URL ending "/station"; a 200 body is {image: "data:image/jpeg;base64,...", width, height,
//   photo_sha, name, profile, box}. onStatus(text) feeds #upload-status.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as rs from "./route_store.js";
import {
  memoryAdapter, flush, deferred, toBytes, hasExif, RAW_CAMERA, ENCODED, PIXELATED, fakeEncode, rawFile,
  stationOk, stationError, fetchSpy,
} from "./route_store_fakes_test.mjs";

async function setup(plan, kv = memoryAdapter()) {
  const store = rs.createRouteStore(kv);
  const route = await store.createRoute({ name: "Walk", kind: "daily" });
  const spy = fetchSpy(plan);
  const enc = fakeEncode();
  const statuses = [];
  const session = rs.createCaptureSession({
    store,
    routeId: route.id,
    fetch: spy.fn,
    encode: enc.encode,
    onStatus: (t) => statuses.push(String(t)),
  });
  return { kv, store, route, spy, enc, statuses, session };
}

const networkDown = () => {
  throw new TypeError("Failed to fetch");
};

async function onlyStation(store, routeId) {
  const r = await store.getRoute(routeId);
  assert.equal(r.stations.length, 1, "exactly one station on the route");
  return r.stations[0];
}

// Covers: MEM-048
// Requirement: route_store.js exports the capture session.
describe("capture session export", () => {
  test("exports createCaptureSession", () => {
    assert.equal(typeof rs.createCaptureSession, "function");
  });
});

// Covers: MEM-048
// Requirement: pending stations (D10) persist the re-encoded, EXIF-free photo before upload; a manual
// Retry names them; a reload keeps them.
describe("capture: pending station before upload (criterion 5)", () => {
  test("the pending station is stored before the upload starts", async () => {
    let seenAtFetch = null;
    const ctx = await setup([
      async () => {
        seenAtFetch = await ctx.store.getRoute(ctx.route.id);
        throw new TypeError("Failed to fetch");
      },
    ]);
    await ctx.session.capture(rawFile());
    assert.ok(seenAtFetch, "fetch was called");
    assert.equal(seenAtFetch.stations.length, 1);
    assert.equal(seenAtFetch.stations[0].status, "pending");
  });

  test("fetch rejects -> station stays pending with the re-encoded photo, which carries no EXIF", async () => {
    const ctx = await setup([networkDown]);
    const result = await ctx.session.capture(rawFile());
    assert.notEqual(result, undefined);
    assert.equal(ctx.enc.seen.length, 1, "the raw file was re-encoded");
    assert.ok(hasExif(RAW_CAMERA), "fixture sanity: the raw camera bytes carry EXIF");
    const st = await onlyStation(ctx.store, ctx.route.id);
    assert.equal(st.status, "pending");
    const bytes = await toBytes(await ctx.store.getPhoto(st.photo_ref));
    assert.ok(bytes && bytes.length > 0, "pending photo bytes are stored");
    assert.equal(hasExif(bytes), false, "stored pending photo carries no EXIF");
    assert.deepEqual(bytes, ENCODED);
  });

  test("the upload is a POST to /station", async () => {
    const ctx = await setup([networkDown]);
    await ctx.session.capture(rawFile());
    assert.equal(ctx.spy.calls.length, 1);
    assert.match(ctx.spy.calls[0].url, /\/station$/);
    assert.equal(ctx.spy.calls[0].method, "POST");
  });

  test("manual retry -> named with the server name; stored photo becomes the pixelated JPEG (1 fetch)", async () => {
    const ctx = await setup([networkDown, () => stationOk("Red door")]);
    await ctx.session.capture(rawFile());
    const pending = await onlyStation(ctx.store, ctx.route.id);
    const before = ctx.spy.calls.length;
    await ctx.session.retry(pending.id);
    assert.equal(ctx.spy.calls.length - before, 1, "retry makes exactly one request");
    const st = await onlyStation(ctx.store, ctx.route.id);
    assert.equal(st.id, pending.id);
    assert.equal(st.status, "named");
    assert.equal(st.name, "Red door");
    assert.deepEqual(await toBytes(await ctx.store.getPhoto(st.photo_ref)), PIXELATED);
  });

  test("reload (a fresh store over the same KV) keeps the pending station and its photo", async () => {
    const ctx = await setup([networkDown]);
    await ctx.session.capture(rawFile());
    const fresh = rs.createRouteStore(ctx.kv);
    const st = await onlyStation(fresh, ctx.route.id);
    assert.equal(st.status, "pending");
    assert.deepEqual(await toBytes(await fresh.getPhoto(st.photo_ref)), ENCODED);
    assert.equal((await fresh.getRoute(ctx.route.id)).status, "draft");
  });

  test("a successful first upload names the station directly", async () => {
    const ctx = await setup([() => stationOk("Old oak")]);
    await ctx.session.capture(rawFile());
    const st = await onlyStation(ctx.store, ctx.route.id);
    assert.equal(st.status, "named");
    assert.equal(st.name, "Old oak");
  });
});

// Covers: MEM-048
// Requirement: 502 blur_failed and 429 keep the station pending (retryable); a 400 marks it error so
// the user can Drop it.
describe("capture: status by response class (criterion 6)", () => {
  const cases = [
    { label: "502 blur_failed -> pending", res: () => stationError(502, "blur_failed"), status: "pending" },
    { label: "429 -> pending", res: () => stationError(429, "rate_limited"), status: "pending" },
    { label: "400 -> error", res: () => stationError(400, "bad_used_names"), status: "error" },
  ];
  for (const c of cases) {
    test(c.label, async () => {
      const ctx = await setup([c.res]);
      await ctx.session.capture(rawFile());
      const st = await onlyStation(ctx.store, ctx.route.id);
      assert.equal(st.status, c.status);
    });
  }

  test("an error station can be dropped", async () => {
    const ctx = await setup([() => stationError(400, "bad_used_names")]);
    await ctx.session.capture(rawFile());
    const st = await onlyStation(ctx.store, ctx.route.id);
    await ctx.store.dropStation(ctx.route.id, st.id);
    assert.equal((await ctx.store.getRoute(ctx.route.id)).stations.length, 0);
  });
});

// Covers: MEM-048
// Requirement: one in-flight request per station: a double tap on Retry sends one request.
describe("capture: double-tap Retry while in flight (criterion 7)", () => {
  test("two retries while the first is in flight -> fetch spy == 1 call for the retry", async () => {
    const gate = deferred();
    const ctx = await setup([networkDown, () => gate.promise]);
    await ctx.session.capture(rawFile());
    const st = await onlyStation(ctx.store, ctx.route.id);
    const before = ctx.spy.calls.length;
    const first = ctx.session.retry(st.id);
    await flush();
    const second = ctx.session.retry(st.id);
    await flush();
    assert.equal(ctx.spy.calls.length - before, 1, "second tap must not send another request");
    gate.resolve(stationOk("Blue gate"));
    await Promise.all([first, second]);
    assert.equal(ctx.spy.calls.length - before, 1);
    assert.equal((await onlyStation(ctx.store, ctx.route.id)).status, "named");
  });
});

// Covers: MEM-048
// Requirement: Capture is disabled while an upload is in flight.
describe("capture: disabled while an upload is in flight (criterion 9)", () => {
  test("busy() is true during the upload; a second capture then neither uploads nor adds a station", async () => {
    const gate = deferred();
    const ctx = await setup([() => gate.promise]);
    assert.equal(ctx.session.busy(), false);
    const first = ctx.session.capture(rawFile());
    await flush();
    assert.equal(ctx.session.busy(), true);
    await ctx.session.capture(rawFile());
    assert.equal(ctx.spy.calls.length, 1, "no second upload while one is in flight");
    assert.equal((await ctx.store.getRoute(ctx.route.id)).stations.length, 1);
    gate.resolve(stationOk("Stone arch"));
    await first;
    assert.equal(ctx.session.busy(), false);
  });
});

// Covers: MEM-048
// Requirement: a KV write failure (quota) shows an error on #upload-status, keeps the in-memory
// station, and never surfaces as an unhandled rejection.
describe("capture: KV write rejects (criterion 11)", () => {
  test("quota error -> status error text, station kept in memory, capture resolves, no unhandled rejection", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const ctx = await setup([networkDown, networkDown, networkDown]);
      ctx.kv.state.failPuts = true;
      await assert.doesNotReject(ctx.session.capture(rawFile()));
      await flush(20);
      assert.ok(ctx.statuses.length > 0, "the upload status line was written");
      assert.ok(
        ctx.statuses.some((t) => /could not save|not saved|storage/i.test(t)),
        `statuses ${JSON.stringify(ctx.statuses)} must name the save failure`,
      );
      const r = await ctx.store.getRoute(ctx.route.id);
      assert.equal(r.stations.length, 1, "the in-memory station is kept");
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
