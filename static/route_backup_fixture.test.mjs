// Covers: MEM-073
// Requirement: fixtures/demo/route_backup.json is a committed backup v2 that scripts/screenshot_ui.py
// imports through #backup-import to put a walked route on screen for the route-view shot. It must
// import through the page's own importBackup into a route store as exactly one saved route with 3
// named stations, each carrying the demo photo (fixtures/demo/photo.jpg) byte for byte, and a
// second import of the same file adds nothing (idempotent: the route is reported present).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stores } from "./backup_fixtures_test.mjs";
import { importBackup } from "./palace_export.js";
import { toBytes } from "./route_store_fakes_test.mjs";

const TEXT = readFileSync(new URL("../fixtures/demo/route_backup.json", import.meta.url), "utf8");
const PHOTO = new Uint8Array(readFileSync(new URL("../fixtures/demo/photo.jpg", import.meta.url)));

describe("MEM-073 route-view screenshot fixture", () => {
  test("imports as one saved route with 3 named stations", async () => {
    const s = stores();
    assert.deepEqual(await importBackup(TEXT, s), { added: 1, present: 0, skipped: 0 });
    const routes = await s.routes.listRoutes();
    assert.equal(routes.length, 1);
    const [route] = routes;
    assert.equal(route.status, "saved");
    assert.equal(route.stations.length, 3);
    assert.deepEqual(route.stations.map((st) => st.n), [1, 2, 3]);
    for (const st of route.stations) {
      assert.equal(st.status, "named");
      assert.ok(typeof st.name === "string" && st.name.trim() !== "", `station ${st.n} has a name`);
    }
  });

  test("every station photo is the demo photo, byte for byte", async () => {
    const s = stores();
    await importBackup(TEXT, s);
    const [route] = await s.routes.listRoutes();
    for (const st of route.stations) {
      assert.deepEqual(await toBytes(await s.routes.getPhoto(st.photo_ref)), PHOTO, `station ${st.n} photo`);
    }
  });

  test("a second import of the same file is idempotent", async () => {
    const s = stores();
    await importBackup(TEXT, s);
    assert.deepEqual(await importBackup(TEXT, s), { added: 0, present: 1, skipped: 0 });
    assert.equal((await s.routes.listRoutes()).length, 1);
  });
});
