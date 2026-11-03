// Covers: MEM-054, MEM-077
// Requirement: Export backup works after Load demo. The Kendall demo route (static/demo_route.js
// DEMO_ROUTE, MEM-077) is seeded through route_store seedRoute as a saved route of named stations
// that have no stored photo. Export (MEM-054) must still succeed with that route in the store, the
// file it writes must re-import (every export must re-import: v2 photos are JPEG data URLs), and it
// must carry no coordinates even though the demo stations hold coords in the store.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { stores } from "./backup_fixtures_test.mjs";
import { buildBackup, importBackup } from "./palace_export.js";
import { DEMO_ROUTE } from "./demo_route.js";

const FORBIDDEN = /lat|lon|coord|captured|image_id|link/i;

/** Every key anywhere in `v`. */
function allKeys(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) out.push(k), allKeys(x, out);
  return out;
}

async function demoSeeded() {
  const s = stores();
  const seeded = await s.routes.seedRoute(DEMO_ROUTE);
  assert.ok(seeded, "seedRoute stores the demo route");
  return s;
}

describe("backup export with the photo-less Kendall demo route seeded", () => {
  test("buildBackup does not throw", async () => {
    const s = await demoSeeded();
    await assert.doesNotReject(() => buildBackup(s));
  });

  test("the exported file re-imports into an empty store", async () => {
    const s = await demoSeeded();
    const file = await buildBackup(s);
    const fresh = stores();
    await assert.doesNotReject(() => importBackup(JSON.stringify(file), fresh));
  });

  test("the exported file carries no coordinate keys", async () => {
    const s = await demoSeeded();
    const file = await buildBackup(s);
    assert.deepEqual(allKeys(file).filter((k) => FORBIDDEN.test(k)), []);
  });
});
