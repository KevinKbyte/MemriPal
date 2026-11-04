// Covers: MEM-048, MEM-033, MEM-077
// Requirement: the route store and the rehearsal store mint ids on a plain-http, non-localhost origin
// (an insecure context: `crypto.randomUUID` is undefined there, `crypto.getRandomValues` is not), so
// Load demo still seeds and opens the Kendall route and a run is still saved. Regression for e2e step 14
// ("public banner on non-localhost Host"): on http://memripal-e2e.test seedRoute threw
// "crypto.randomUUID is not a function", flow.js swallowed it and #route-view never opened.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { createRouteStore } from "./route_store.js";
import { createRehearsalStore } from "./rehearsals.js";
import { DEMO_ROUTE } from "./demo_route.js";
import { memoryAdapter } from "./route_store_fakes_test.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("store ids in an insecure context (no crypto.randomUUID)", () => {
  /** @type {PropertyDescriptor | undefined} */
  let saved;
  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const real = globalThis.crypto;
    // What an http://<non-localhost> page sees: getRandomValues only.
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: (/** @type {Uint8Array} */ a) => real.getRandomValues(a) },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, "crypto", saved);
  });

  test("seedRoute(DEMO_ROUTE) persists the demo route with v4 photo_refs", async () => {
    const store = createRouteStore(memoryAdapter());
    const seeded = await store.seedRoute(DEMO_ROUTE);
    assert.ok(seeded, "seedRoute resolved with the seeded route");
    const got = await store.getRoute(DEMO_ROUTE.id);
    assert.equal(got?.stations.length, DEMO_ROUTE.stations.length);
    const refs = got.stations.map((/** @type {any} */ s) => s.photo_ref);
    for (const ref of refs) assert.match(ref, UUID_V4);
    assert.equal(new Set(refs).size, refs.length, "photo_refs are unique");
  });

  test("createRoute mints a v4 route id", async () => {
    const store = createRouteStore(memoryAdapter());
    const r = await store.createRoute({ name: "walk" });
    assert.match(r.id, UUID_V4);
  });

  test("rehearsal save mints a v4 id", async () => {
    /** @type {Map<string, string>} */
    const kv = new Map();
    const adapter = {
      put: async (/** @type {string} */ k, /** @type {string} */ v) => void kv.set(k, v),
      get: async (/** @type {string} */ k) => kv.get(k) ?? null,
      delete: async (/** @type {string} */ k) => void kv.delete(k),
      list: async () => [...kv.values()],
    };
    const store = createRehearsalStore(adapter);
    const rec = await store.save("demo", { transcript: "x", results: [] });
    assert.match(rec.id, UUID_V4);
    assert.ok(kv.has(rec.id));
  });
});
