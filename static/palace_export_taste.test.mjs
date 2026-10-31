// Covers: MEM-022
// Requirement: taste is optional (Kev's 'Optional taste'), so a palace backup carries and accepts an
// association record with no gustatory key: export keeps such an entry (record unchanged, no key added)
// and import stores it as-is, while a record missing any other channel is still skipped and a present
// gustatory value must still be a string.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { associationKey, backup, entry, fullRecord, stores } from "./backup_fixtures_test.mjs";
import { buildBackup, importBackup } from "./palace_export.js";

/** A signed entry whose record has every FIELD except `dropped`. */
function entryWithout(item, locus, dropped) {
  const e = entry(item, locus);
  delete e.record[dropped];
  return e;
}

const importObj = (obj, s) => importBackup(JSON.stringify(obj), { store: s.store, rehearsals: s.rehearsals });

describe("palace backup: optional gustatory", () => {
  test("import stores a record with no gustatory key unchanged", async () => {
    const s = stores();
    const tasteless = entryWithout("milk", "lamp", "gustatory");
    assert.deepEqual(await importObj(backup({ associations: [tasteless] }), s), { added: 1, present: 0, skipped: 0 });
    const stored = await s.store.get(associationKey("milk", "lamp"));
    assert.deepEqual(stored, tasteless);
    assert.ok(!("gustatory" in stored.record), "no gustatory key added");
  });

  test("export keeps a stored record with no gustatory key, and that file imports", async () => {
    const src = stores();
    const tasteless = entryWithout("milk", "lamp", "gustatory");
    await src.store.put(associationKey("milk", "lamp"), tasteless);
    const out = await buildBackup(src);
    assert.deepEqual(out.associations, [tasteless]);
    const dst = stores();
    assert.deepEqual(await importObj(out, dst), { added: 1, present: 0, skipped: 0 });
  });

  for (const dropped of ["olfactory", "spatial", "kinesthetic"]) {
    test(`a record missing ${dropped} is still skipped; the good entry beside it imports`, async () => {
      const s = stores();
      const file = backup({ associations: [entryWithout("a", "lamp", dropped), entry("good", "door")] });
      assert.deepEqual(await importObj(file, s), { added: 1, present: 0, skipped: 1 });
    });
  }

  test("a present non-string gustatory is still skipped", async () => {
    const s = stores();
    const bad = { record: fullRecord("a", "lamp", { gustatory: 3 }), status: "valid" };
    assert.deepEqual(await importObj(backup({ associations: [bad, entry("good", "door")] }), s), { added: 1, present: 0, skipped: 1 });
  });
});
