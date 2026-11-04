// Covers: MEM-099
// Requirement: Pal chats are user data and travel with the palace backup (MEM-099 B5, ADR 0066 amendment
// 2026-11-03 option (i)). With a chat store wired, buildBackup writes backup v: 3 = the v2 keys plus chats[];
// without one it still writes v: 2 (unchanged, palace_export_v2.test.mjs). importBackup accepts v2 (no chats)
// and v3. The file is untrusted: chats are rebuilt key by key through an allow-list with caps (chat count,
// messages per chat, title / text length, role enum, uuid ids, ISO timestamps). A count cap breach or a
// malformed envelope refuses the whole file with 0 writes anywhere; an individually invalid chat is skipped
// whole (0 partial writes: none of its messages land); a stored chat id counts as present.
// Contract (RED; GREEN implements static/palace_export.js; chat store side in chat_store.test.mjs):
//   palace_export.js exports MAX_IMPORT_CHATS and MAX_IMPORT_CHAT_MESSAGES (positive ints, shared by export
//   and import like MAX_IMPORT_ASSOCIATIONS). Title / text caps and ROLES are chat_store.js MAX_TITLE_CHARS,
//   MAX_MESSAGE_CHARS, ROLES.
//   deps gain optional chats = chat store: exportChats() -> backup chats; restoreChat(chat) -> true added /
//   false already present (palace_export trusts that boolean, as with routes.restoreRoute).
//   Backup chat = exactly {id, title, created_at, messages}; message = exactly {id, role, text, created_at}.
//     id: lowercase uuid; title: string, non-blank after trim, <= MAX_TITLE_CHARS; created_at: ISO string that
//     round-trips through Date#toISOString; messages: array (may be empty), message ids unique in the chat;
//     role in ROLES; text: non-empty string <= MAX_MESSAGE_CHARS.
//   buildBackup({..., chats}) -> {v: 3, routes, lists, associations, rehearsals, chats}; chats rebuilt through
//     the allow-list (extra store keys dropped; a chat failing it is not exported); rejects over a count cap.
//   importBackup(text, {..., chats}) -> {added, present, skipped} totals now include chats.
//     Whole-file reject (throws, nothing written): v2 carrying chats, v3 without chats, chats not an array, an
//     unknown top key, v other than 2/3, over MAX_IMPORT_CHATS chats, a chat over MAX_IMPORT_CHAT_MESSAGES
//     messages, or a non-empty chats[] with no chats dep. restoreChat receives only fresh allow-listed objects.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { backup, entry, rehearsal, snapshot, stores, uuid } from "./backup_fixtures_test.mjs";
import { associationKey } from "./palace_store.js";

const mod = await import("./palace_export.js").catch((err) => ({ __missing: String(err) }));
const chatMod = await import("./chat_store.js").catch((err) => ({ __missing: String(err) }));
const schemaMod = await import("./db/schema.js").catch((err) => ({ __missing: String(err) }));
const mig = await import("./db/migrations.js").catch((err) => ({ __missing: String(err) }));
const drv = await import("./db/node_driver.js").catch((err) => ({ __missing: String(err) }));

function api(name) {
  assert.ok(name in mod, `static/palace_export.js must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

function chatApi(name) {
  assert.ok(name in chatMod, `static/chat_store.js must export ${name} (${chatMod.__missing ?? "not exported"})`);
  return chatMod[name];
}

const V2_KEYS = ["associations", "lists", "rehearsals", "routes", "v"];
const V3_KEYS = ["associations", "chats", "lists", "rehearsals", "routes", "v"];
const CHAT_KEYS = ["created_at", "id", "messages", "title"];
const MSG_KEYS = ["created_at", "id", "role", "text"];

const keysSorted = (o) => Object.keys(o).sort();
const build = (deps) => api("buildBackup")(deps);
const importText = (text, deps) => api("importBackup")(text, deps);
const importObj = (obj, deps) => importText(JSON.stringify(obj), deps);

function msg(extra = {}) {
  return { id: uuid(), role: "user", text: "milk and eggs", created_at: "2026-11-03T09:00:01.000Z", ...extra };
}

function chat(extra = {}) {
  return { id: uuid(), title: "Groceries", created_at: "2026-11-03T09:00:00.000Z", messages: [msg()], ...extra };
}

/** The v3 envelope. */
function backupV3(extra = {}) {
  return { ...backup(), v: 3, chats: [], ...extra };
}

/** In-memory chat store seam: exportChats / restoreChat, every restoreChat argument recorded in writes. */
function fakeChats(seed = []) {
  const map = new Map(seed.map((c) => [c.id, structuredClone(c)]));
  const writes = [];
  return {
    map,
    writes,
    exportChats: async () => [...map.values()].map((c) => structuredClone(c)),
    restoreChat: async (c) => {
      writes.push(structuredClone(c));
      if (map.has(c.id)) return false;
      map.set(c.id, structuredClone(c));
      return true;
    },
  };
}

function withChats(seed = []) {
  const s = stores();
  s.chats = fakeChats(seed);
  return s;
}

// Covers: MEM-099
// Requirement: B5 export: with a chat store the backup is v: 3 and carries chats[] rebuilt from the
// allow-list; without one it stays v: 2 with no chats key; every exported file imports (caps enforced).
describe("MEM-099 backup v3 export", () => {
  test("no chats dep: v 2 with the v2 key set (no chats key)", async () => {
    const out = await build(stores());
    assert.equal(out.v, 2);
    assert.deepEqual(keysSorted(out), V2_KEYS);
  });

  test("chats dep: v 3 with chats[]; an empty store gives chats: []", async () => {
    const out = await build(withChats());
    assert.equal(out.v, 3);
    assert.deepEqual(keysSorted(out), V3_KEYS);
    assert.deepEqual(out.chats, []);
  });

  test("stored chats are exported with exactly the allow-listed keys; extra store keys are dropped", async () => {
    const c = chat({ updated_at: "2026-11-03T10:00:00.000Z", deleted_at: null });
    c.messages = [msg({ chat_id: c.id, text: "one" }), msg({ role: "assistant", text: "two", chat_id: c.id })];
    const out = await build(withChats([c]));
    assert.equal(out.chats.length, 1);
    assert.deepEqual(keysSorted(out.chats[0]), CHAT_KEYS);
    assert.deepEqual(out.chats[0].messages.map(keysSorted), [MSG_KEYS, MSG_KEYS]);
    assert.deepEqual(out.chats[0].messages.map((m) => [m.role, m.text]), [["user", "one"], ["assistant", "two"]]);
    assert.equal(out.chats[0].id, c.id);
    assert.equal(out.chats[0].title, c.title);
  });

  test("a stored chat failing the import allow-list is not exported", async () => {
    const good = chat({ title: "Good" });
    const bad = chat({ title: "Bad", messages: [msg({ role: "system" })] });
    const out = await build(withChats([good, bad]));
    assert.deepEqual(out.chats.map((c) => c.title), ["Good"]);
  });

  test("a chat store over MAX_IMPORT_CHATS, or a chat over MAX_IMPORT_CHAT_MESSAGES, is refused", async () => {
    const maxChats = api("MAX_IMPORT_CHATS");
    const maxMsgs = api("MAX_IMPORT_CHAT_MESSAGES");
    assert.ok(Number.isInteger(maxChats) && maxChats > 0);
    assert.ok(Number.isInteger(maxMsgs) && maxMsgs > 0);
    await assert.rejects(build(withChats(Array.from({ length: maxChats + 1 }, () => chat({ messages: [] })))));
    await assert.rejects(build(withChats([chat({ messages: Array.from({ length: maxMsgs + 1 }, () => msg()) })])));
  });
});

// Covers: MEM-099
// Requirement: B5 import: a v2 file still imports (no chats touched); a v3 file restores its chats through
// the chat store, a stored id counts as present, the first duplicate in a file wins, and the totals include
// chats. Exactly-at-cap inputs are accepted.
describe("MEM-099 backup v3 import: accepted files", () => {
  test("a v2 file imports with a chats dep wired and never calls restoreChat", async () => {
    const s = withChats();
    const res = await importObj(backup({ associations: [entry("milk", "lamp")] }), s);
    assert.deepEqual(res, { added: 1, present: 0, skipped: 0 });
    assert.deepEqual(s.chats.writes, []);
  });

  test("a v3 file restores each chat as a fresh allow-listed object; totals count chats", async () => {
    const s = withChats();
    const a = chat({ title: "A" });
    const b = chat({ title: "B", messages: [] });
    const res = await importObj(backupV3({ associations: [entry("milk", "lamp")], chats: [a, b] }), s);
    assert.deepEqual(res, { added: 3, present: 0, skipped: 0 });
    assert.deepEqual(s.chats.writes, [a, b], "written chats equal the file chats, messages included");
    for (const w of s.chats.writes) {
      assert.deepEqual(keysSorted(w), CHAT_KEYS);
      for (const m of w.messages) assert.deepEqual(keysSorted(m), MSG_KEYS);
    }
  });

  test("a v3 file with chats: [] imports without a chats dep", async () => {
    const s = stores();
    const res = await importObj(backupV3({ rehearsals: [rehearsal()] }), s);
    assert.deepEqual(res, { added: 1, present: 0, skipped: 0 });
  });

  test("a stored chat id counts as present and is not overwritten", async () => {
    const mine = chat({ title: "Mine" });
    const s = withChats([mine]);
    const res = await importObj(backupV3({ chats: [{ ...mine, title: "Imported" }] }), s);
    assert.deepEqual(res, { added: 0, present: 1, skipped: 0 });
    assert.equal(s.chats.map.get(mine.id).title, "Mine");
  });

  test("the first of two chats sharing an id wins; the second counts as present", async () => {
    const s = withChats();
    const first = chat({ title: "First" });
    const res = await importObj(backupV3({ chats: [first, { ...first, title: "Second" }] }), s);
    assert.deepEqual(res, { added: 1, present: 1, skipped: 0 });
    assert.equal(s.chats.map.get(first.id).title, "First");
  });

  test("exactly-at-cap chat count, messages per chat, title and text lengths are accepted", async () => {
    const maxChats = api("MAX_IMPORT_CHATS");
    const maxMsgs = api("MAX_IMPORT_CHAT_MESSAGES");
    const s = withChats();
    const chats = Array.from({ length: maxChats }, () => chat({ messages: [] }));
    chats[0] = chat({
      title: "t".repeat(chatApi("MAX_TITLE_CHARS")),
      messages: Array.from({ length: maxMsgs }, (_, i) => msg(i === 0 ? { text: "x".repeat(chatApi("MAX_MESSAGE_CHARS")) } : {})),
    });
    const res = await importObj(backupV3({ chats }), s);
    assert.deepEqual(res, { added: maxChats, present: 0, skipped: 0 });
  });
});

// Covers: MEM-099
// Requirement: B5 hostile envelopes refuse the whole file with 0 partial writes: no association, rehearsal,
// route or chat lands when the version / key set is wrong or a chat count cap is broken.
describe("MEM-099 backup v3 import: whole-file rejection, nothing written", () => {
  const good = () => ({ associations: [entry("milk", "lamp")], rehearsals: [rehearsal()] });
  const cases = [
    ["v2 carrying chats", () => backup({ ...good(), chats: [chat()] })],
    ["v3 without chats", () => { const b = backupV3(good()); delete b.chats; return b; }],
    ["v3 chats not an array", () => backupV3({ ...good(), chats: {} })],
    ["v3 chats null", () => backupV3({ ...good(), chats: null })],
    ["v3 unknown top-level key", () => backupV3({ ...good(), chats: [chat()], extra: 1 })],
    ["v 4", () => backupV3({ ...good(), v: 4, chats: [chat()] })],
    ["v string 3", () => backupV3({ ...good(), v: "3", chats: [chat()] })],
    ["over MAX_IMPORT_CHATS chats", () => backupV3({ ...good(), chats: Array.from({ length: api("MAX_IMPORT_CHATS") + 1 }, () => chat({ messages: [] })) })],
    ["a chat over MAX_IMPORT_CHAT_MESSAGES", () => backupV3({ ...good(), chats: [chat(), chat({ messages: Array.from({ length: api("MAX_IMPORT_CHAT_MESSAGES") + 1 }, () => msg()) })] })],
  ];
  for (const [name, make] of cases) {
    test(`rejects: ${name}`, async () => {
      const s = withChats();
      const before = snapshot(s);
      await assert.rejects(importObj(make(), s));
      assert.deepEqual(snapshot(s), before, "palace / rehearsal / route stores unchanged");
      assert.deepEqual(s.chats.writes, [], "no chat written");
    });
  }

  test("rejects: a non-empty chats[] when the page has no chat store, writing nothing", async () => {
    const s = stores();
    const before = snapshot(s);
    await assert.rejects(importObj(backupV3({ ...good(), chats: [chat()] }), s));
    assert.deepEqual(snapshot(s), before);
  });
});

// Covers: MEM-099
// Requirement: B5 an individually invalid chat (any key outside the allow-list, bad id, bad title, bad
// timestamp, non-array messages, a bad message: extra key, role outside ROLES, empty / oversized / non-string
// text, bad or duplicate message id) is skipped whole; restoreChat never sees it, the valid chats beside it
// still land, and nothing reaches Object.prototype.
describe("MEM-099 backup v3 import: invalid chats skipped whole", () => {
  const bad = () => [
    ["chat null", null],
    ["chat array", [chat()]],
    ["chat string", "chat"],
    ["extra chat key", chat({ updated_at: "2026-11-03T09:00:00.000Z" })],
    ["missing messages", (() => { const c = chat(); delete c.messages; return c; })()],
    ["id not a uuid", chat({ id: "chat-1" })],
    ["id uppercase", chat({ id: "AAAAAAAA-0000-4000-8000-000000000001" })],
    ["id number", chat({ id: 7 })],
    ["title empty", chat({ title: "" })],
    ["title blank", chat({ title: "   " })],
    ["title over cap", chat({ title: "t".repeat((chatMod.MAX_TITLE_CHARS ?? 100) + 1) })],
    ["title object", chat({ title: { toString: 1 } })],
    ["created_at not ISO", chat({ created_at: "yesterday" })],
    ["created_at not round-tripping", chat({ created_at: "2026-11-03" })],
    ["messages not array", chat({ messages: "hi" })],
    ["message extra key", chat({ messages: [msg({ chat_id: "x" })] })],
    ["message role system", chat({ messages: [msg(), msg({ role: "system" })] })],
    ["message role uppercase", chat({ messages: [msg({ role: "USER" })] })],
    ["message text empty", chat({ messages: [msg({ text: "" })] })],
    ["message text over cap", chat({ messages: [msg({ text: "x".repeat((chatMod.MAX_MESSAGE_CHARS ?? 4000) + 1) })] })],
    ["message text number", chat({ messages: [msg({ text: 3 })] })],
    ["message id bad", chat({ messages: [msg({ id: "m1" })] })],
    ["message ids duplicated", (() => { const m = msg(); return chat({ messages: [m, { ...m, text: "again" }] }); })()],
    ["message created_at bad", chat({ messages: [msg({ created_at: 0 })] })],
    ["message null", chat({ messages: [null] })],
  ];
  for (const [name, value] of bad()) {
    test(`skips: ${name}`, async () => {
      const s = withChats();
      const res = await importObj(backupV3({ chats: [value] }), s);
      assert.deepEqual(res, { added: 0, present: 0, skipped: 1 });
      assert.deepEqual(s.chats.writes, [], "restoreChat never called for an invalid chat");
    });
  }

  test("valid chats beside invalid ones still land; associations land too", async () => {
    const s = withChats();
    const a = chat({ title: "A" });
    const b = chat({ title: "B" });
    const file = backupV3({ associations: [entry("milk", "lamp")], chats: [a, chat({ messages: [msg({ role: "system" })] }), b] });
    const res = await importObj(file, s);
    assert.deepEqual(res, { added: 3, present: 0, skipped: 1 });
    assert.deepEqual(s.chats.writes.map((c) => c.title), ["A", "B"]);
    assert.ok((await s.store.get(associationKey("milk", "lamp"))) !== undefined);
  });

  test("__proto__ keys in a chat or message are skipped and never reach Object.prototype", async () => {
    const s = withChats();
    const c = chat();
    const text = JSON.stringify(backupV3({ chats: [c, chat()] }))
      .replace(`"id":"${c.id}"`, `"__proto__":{"polluted":true},"id":"${c.id}"`);
    const m = msg();
    const text2 = JSON.stringify(backupV3({ chats: [chat({ messages: [m] })] }))
      .replace(`"id":"${m.id}"`, `"__proto__":{"polluted":true},"id":"${m.id}"`);
    const r1 = await importText(text, s);
    const r2 = await importText(text2, s);
    assert.equal(r1.skipped, 1);
    assert.equal(r2.skipped, 1);
    assert.equal(({}).polluted, undefined);
    for (const w of s.chats.writes) {
      assert.deepEqual(keysSorted(w), CHAT_KEYS);
      assert.equal(Object.getPrototypeOf(w), Object.prototype);
    }
  });
});

// Covers: MEM-099
// Requirement: B5 accept: export then import round-trips chats between two real on-device chat stores
// (SQLite), deleted chats stay out of the file, and re-importing the same file adds nothing.
describe("MEM-099 backup v3 round trip through real chat stores", () => {
  async function realChats() {
    const raw = await drv.openMemoryDb();
    await mig.runMigrations(raw, schemaMod.MIGRATIONS);
    let t = 0;
    const now = () => new Date(Date.UTC(2026, 10, 3, 9, 0, 0) + 1000 * t++).toISOString();
    return chatApi("createChatStore")(drv.asClient(raw), { now });
  }

  test("export -> import -> same chats and messages; deleted chat excluded; re-import is all present", async () => {
    const src = stores();
    src.chats = await realChats();
    const a = await src.chats.createChat({ title: "Groceries" });
    await src.chats.appendMessage(a.id, { role: "user", text: "milk" });
    await src.chats.appendMessage(a.id, { role: "assistant", text: "added milk" });
    const b = await src.chats.createChat({ title: "Empty chat" });
    const gone = await src.chats.createChat({ title: "Gone" });
    await src.chats.deleteChat(gone.id);
    const file = await build(src);
    assert.equal(file.v, 3);
    assert.deepEqual(file.chats.map((c) => c.id).sort(), [a.id, b.id].sort());

    const dst = stores();
    dst.chats = await realChats();
    const text = JSON.stringify(file);
    assert.deepEqual(await importText(text, dst), { added: 2, present: 0, skipped: 0 });
    const byId = (x, y) => (x.id < y.id ? -1 : 1);
    assert.deepEqual((await dst.chats.exportChats()).sort(byId), [...file.chats].sort(byId));
    assert.deepEqual(await importText(text, dst), { added: 0, present: 2, skipped: 0 });
  });
});

// Covers: MEM-099
// Requirement: one long chat never breaks the backup: a real chat store filled to exactly
// MAX_IMPORT_CHAT_MESSAGES messages still exports (buildBackup succeeds with all of them), and the store
// refuses the message that would push the chat over the cap, so buildBackup never sees an over-cap chat.
describe("MEM-099 backup v3 export: a chat at the message cap", () => {
  async function realChats() {
    const raw = await drv.openMemoryDb();
    await mig.runMigrations(raw, schemaMod.MIGRATIONS);
    let t = 0;
    const now = () => new Date(Date.UTC(2026, 10, 3, 9, 0, 0) + 1000 * t++).toISOString();
    return { raw, store: chatApi("createChatStore")(drv.asClient(raw), { now }) };
  }

  /** Seeds n valid messages straight into chat_messages (raw SQL, so the test stays fast). */
  function seedMessages(raw, chatId, n) {
    raw.exec(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
       INSERT INTO chat_messages (id, chat_id, role, text, created_at)
       SELECT printf('00000000-0000-4000-8000-%012d', i), ?, 'user', 'm' || i, '2026-11-03T09:00:00.500Z' FROM k`,
      [n, chatId]);
  }

  test("a chat at exactly MAX_IMPORT_CHAT_MESSAGES exports, and one more append is refused so export still succeeds", async () => {
    const maxMsgs = api("MAX_IMPORT_CHAT_MESSAGES");
    const s = stores();
    const { raw, store } = await realChats();
    s.chats = store;
    const c = await store.createChat({ title: "Long" });
    seedMessages(raw, c.id, maxMsgs - 1);
    await store.appendMessage(c.id, { role: "assistant", text: "at the cap" });
    const atCap = await build(s);
    assert.equal(atCap.chats.length, 1);
    assert.equal(atCap.chats[0].messages.length, maxMsgs);
    await assert.rejects(store.appendMessage(c.id, { role: "user", text: "over the cap" }));
    const after = await build(s);
    assert.equal(after.chats[0].messages.length, maxMsgs);
  });
});
