// Covers: MEM-099
// Requirement: the Pal chat bubble keeps the user's chats on the device, in the on-device SQLite db,
// never on the server (MEM-099 B3/B4, ADR 0064 amendment 2026-11-03). Migration V2 adds the chats and
// chat_messages tables to an existing V1 db without touching its routes; chats can be created, listed,
// switched between, renamed and given messages; delete is a soft delete (deleted_at), rows are never
// hard-deleted, and Undo revives the same chat with its messages. Bad input is refused at the store
// boundary and writes nothing.
// Contract (RED; GREEN implements static/chat_store.js + MIGRATIONS[1] (V2) in static/db/schema.js):
//   schema.js MIGRATIONS[1] (V2, SQL string or SYNC step) creates tables chats (columns include id, title,
//   created_at, updated_at, deleted_at TEXT) and chat_messages (columns include id, chat_id, role, text,
//   created_at); no BLOB / untyped columns.
//   chat_store.js exports:
//     ROLES = ["user", "assistant"]; MAX_TITLE_CHARS (positive int); MAX_MESSAGE_CHARS (positive int);
//     createChatStore(db, {now?: () => ISO string, newId?: () => uuid}) where db is the async client shape
//       (static/db/client.js; tests: node_driver asClient(openMemoryDb())) over a migrated db. Methods (async):
//       createChat({title}?) -> Chat {id (lowercase uuid), title, created_at, updated_at}; title omitted ->
//         a non-empty default title.
//       listChats() -> live Chats, most recently active first (updated_at desc; appendMessage bumps it).
//       getChat(id) -> live Chat or null (unknown or deleted).
//       renameChat(id, title) -> Chat; throws on an unknown / deleted id or a bad title, writing nothing.
//       appendMessage(chatId, {role, text}) -> Message {id, chat_id, role, text, created_at}; throws on an
//         unknown / deleted chat, a role outside ROLES, a non-string / empty text or text over MAX_MESSAGE_CHARS.
//       listMessages(chatId) -> Messages oldest first.
//       deleteChat(id) -> soft delete (sets deleted_at); throws on an unknown id.
//       reviveChat(id) -> Chat; the Undo of deleteChat (clears deleted_at); throws on an unknown id.
//       exportChats() -> live chats as backup objects {id, title, created_at, messages: [{id, role, text,
//         created_at}]} (see palace_export_chats.test.mjs).
//       restoreChat(chat) -> true when written, false when the id is already stored (live or deleted: a stored
//         id counts as present); a bad chat throws and writes nothing (no partial chat).
//   A bad title = not a string, blank after trim, or longer than MAX_TITLE_CHARS.
// Real in-memory SQLite (vendor-node build), not mocks.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const mod = await import("./chat_store.js").catch((err) => ({ __missing: String(err) }));
const schemaMod = await import("./db/schema.js").catch((err) => ({ __missing: String(err) }));
const mig = await import("./db/migrations.js").catch((err) => ({ __missing: String(err) }));
const drv = await import("./db/node_driver.js").catch((err) => ({ __missing: String(err) }));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function api(name) {
  assert.ok(name in mod, `static/chat_store.js must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

function migrations() {
  assert.ok(Array.isArray(schemaMod.MIGRATIONS), `static/db/schema.js must export MIGRATIONS (${schemaMod.__missing ?? "missing"})`);
  return schemaMod.MIGRATIONS;
}

/** A clock that advances one second per call, so ordering never depends on wall time. */
function clock() {
  let t = 0;
  return () => new Date(Date.UTC(2026, 10, 3, 9, 0, 0) + 1000 * t++).toISOString();
}

async function tableNames(raw) {
  return (await raw.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((r) => r.name);
}

async function columns(raw, table) {
  return await raw.query(`PRAGMA table_info(${table})`);
}

/** A raw sync db migrated with every MIGRATIONS step, plus a chat store over its async client. */
async function fresh() {
  const raw = await drv.openMemoryDb();
  await mig.runMigrations(raw, migrations());
  const store = api("createChatStore")(drv.asClient(raw), { now: clock() });
  return { raw, store };
}

const count = (raw, sql, params = []) => raw.query(sql, params)[0].n;

// Covers: MEM-099
// Requirement: B3: migration V2 upgrades a V1 db in place; routes and stations already on the device
// survive untouched, and the chats / chat_messages tables arrive with a deleted_at soft-delete column.
describe("MEM-099 schema V2: chats tables", () => {
  test("V2 is MIGRATIONS[1]: V1 alone has no chats tables, V1+V2 adds chats and chat_messages", async () => {
    const raw = await drv.openMemoryDb();
    const all = migrations();
    assert.ok(all.length >= 2, `MIGRATIONS must have a V2 step (length ${all.length})`);
    await mig.runMigrations(raw, all.slice(0, 1));
    assert.ok(!(await tableNames(raw)).includes("chats"), "V1 must not create chats");
    await mig.runMigrations(raw, all.slice(0, 2));
    const names = await tableNames(raw);
    for (const t of ["chats", "chat_messages", "routes", "stations"]) assert.ok(names.includes(t), `${t} missing (${names})`);
    assert.equal(raw.query("PRAGMA user_version")[0].user_version, 2);
  });

  test("upgrading a V1 db with routes and stations keeps every V1 row intact", async () => {
    const raw = await drv.openMemoryDb();
    await mig.runMigrations(raw, migrations().slice(0, 1));
    raw.exec("INSERT INTO routes (id, name, kind, status, created_at, raw_json, ord) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["r1", "Morning walk", "daily", "saved", "2026-10-31T09:00:00.000Z", "{\"x\":1}", 1]);
    raw.exec("INSERT INTO stations (route_id, id, pos, n, name, status, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["r1", "s1", 0, 1, "Red door", "named", "{}"]);
    const routesBefore = raw.query("SELECT * FROM routes");
    const stationsBefore = raw.query("SELECT * FROM stations");
    await mig.runMigrations(raw, migrations());
    assert.deepEqual(raw.query("SELECT * FROM routes"), routesBefore);
    assert.deepEqual(raw.query("SELECT * FROM stations"), stationsBefore);
  });

  test("chats and chat_messages carry the planned columns; deleted_at is TEXT; no BLOB or untyped column", async () => {
    const { raw } = await fresh();
    const chatCols = await columns(raw, "chats");
    for (const c of ["id", "title", "created_at", "updated_at", "deleted_at"]) {
      assert.ok(chatCols.some((x) => x.name === c), `chats.${c} missing`);
    }
    assert.equal(chatCols.find((x) => x.name === "deleted_at").type.toUpperCase(), "TEXT");
    const msgCols = await columns(raw, "chat_messages");
    for (const c of ["id", "chat_id", "role", "text", "created_at"]) {
      assert.ok(msgCols.some((x) => x.name === c), `chat_messages.${c} missing`);
    }
    for (const [table, cols] of [["chats", chatCols], ["chat_messages", msgCols]]) {
      const bad = cols.filter((c) => /blob/i.test(c.type) || c.type === "");
      assert.deepEqual(bad, [], `${table} has untyped/BLOB columns`);
    }
  });
});

// Covers: MEM-099
// Requirement: B4: the user can start several chats, see them listed most recently active first, switch
// between them (each keeps its own messages in order) and rename one.
describe("MEM-099 chat store: create, list, rename, messages", () => {
  test("createChat returns a uuid-keyed chat; listChats shows live chats most recently active first", async () => {
    const { store } = await fresh();
    const a = await store.createChat({ title: "Groceries" });
    const b = await store.createChat({ title: "Trip" });
    assert.match(a.id, UUID_RE);
    assert.notEqual(a.id, b.id);
    assert.equal(a.title, "Groceries");
    assert.deepEqual((await store.listChats()).map((c) => c.title), ["Trip", "Groceries"]);
    await store.appendMessage(a.id, { role: "user", text: "milk and eggs" });
    assert.deepEqual((await store.listChats()).map((c) => c.title), ["Groceries", "Trip"], "a new message bumps the chat to the top");
  });

  test("createChat with no title gets a non-empty default title", async () => {
    const { store } = await fresh();
    const c = await store.createChat();
    assert.equal(typeof c.title, "string");
    assert.ok(c.title.trim().length > 0);
    assert.equal((await store.getChat(c.id)).title, c.title);
  });

  test("messages are kept per chat, oldest first, with role and text", async () => {
    const { store } = await fresh();
    const a = await store.createChat({ title: "A" });
    const b = await store.createChat({ title: "B" });
    await store.appendMessage(a.id, { role: "user", text: "one" });
    await store.appendMessage(b.id, { role: "user", text: "other chat" });
    const m2 = await store.appendMessage(a.id, { role: "assistant", text: "two" });
    assert.match(m2.id, UUID_RE);
    assert.equal(m2.chat_id, a.id);
    assert.deepEqual((await store.listMessages(a.id)).map((m) => [m.role, m.text]), [["user", "one"], ["assistant", "two"]]);
    assert.deepEqual((await store.listMessages(b.id)).map((m) => m.text), ["other chat"]);
  });

  test("renameChat changes the title; getChat and listChats see it", async () => {
    const { store } = await fresh();
    const c = await store.createChat({ title: "Old" });
    const renamed = await store.renameChat(c.id, "New name");
    assert.equal(renamed.title, "New name");
    assert.equal((await store.getChat(c.id)).title, "New name");
    assert.deepEqual((await store.listChats()).map((x) => x.title), ["New name"]);
  });

  test("a title with SQL metacharacters is stored verbatim and alters no other row (parameterized)", async () => {
    const { store } = await fresh();
    const first = await store.createChat({ title: "First" });
    const evil = "x'); UPDATE chats SET title = 'pwned'; --";
    const c = await store.createChat({ title: evil });
    assert.equal((await store.getChat(c.id)).title, evil);
    assert.equal((await store.getChat(first.id)).title, "First");
  });

  test("getChat of an unknown id is null; an empty db lists no chats", async () => {
    const { store } = await fresh();
    assert.deepEqual(await store.listChats(), []);
    assert.equal(await store.getChat("00000000-0000-4000-8000-000000000999"), null);
  });
});

// Covers: MEM-099
// Requirement: B3/B4: delete is a soft delete; the chat leaves the list but its row and messages stay in the
// db (never hard-deleted), and Undo (reviveChat) brings back the same chat with all its messages.
describe("MEM-099 chat store: soft delete and Undo", () => {
  test("deleteChat hides the chat from listChats / getChat but keeps its rows with deleted_at set", async () => {
    const { raw, store } = await fresh();
    const keep = await store.createChat({ title: "Keep" });
    const gone = await store.createChat({ title: "Gone" });
    await store.appendMessage(gone.id, { role: "user", text: "hello" });
    await store.deleteChat(gone.id);
    assert.deepEqual((await store.listChats()).map((c) => c.id), [keep.id]);
    assert.equal(await store.getChat(gone.id), null);
    assert.equal(count(raw, "SELECT count(*) AS n FROM chats"), 2, "row not hard-deleted");
    assert.equal(count(raw, "SELECT count(*) AS n FROM chats WHERE id = ? AND deleted_at IS NOT NULL", [gone.id]), 1);
    assert.equal(count(raw, "SELECT count(*) AS n FROM chat_messages WHERE chat_id = ?", [gone.id]), 1, "messages kept");
  });

  test("reviveChat (Undo) restores the same chat, title and messages", async () => {
    const { store } = await fresh();
    const c = await store.createChat({ title: "Trip" });
    await store.appendMessage(c.id, { role: "user", text: "pack socks" });
    await store.appendMessage(c.id, { role: "assistant", text: "noted" });
    await store.deleteChat(c.id);
    const back = await store.reviveChat(c.id);
    assert.equal(back.id, c.id);
    assert.equal(back.title, "Trip");
    assert.deepEqual((await store.listChats()).map((x) => x.id), [c.id]);
    assert.deepEqual((await store.listMessages(c.id)).map((m) => m.text), ["pack socks", "noted"]);
  });

  test("deleteChat / reviveChat of an unknown id throw and change nothing", async () => {
    const { raw, store } = await fresh();
    await store.createChat({ title: "Only" });
    const before = raw.query("SELECT * FROM chats");
    const ghost = "00000000-0000-4000-8000-000000000777";
    await assert.rejects(store.deleteChat(ghost));
    await assert.rejects(store.reviveChat(ghost));
    assert.deepEqual(raw.query("SELECT * FROM chats"), before);
  });

  test("a deleted chat cannot be renamed or given messages until revived", async () => {
    const { raw, store } = await fresh();
    const c = await store.createChat({ title: "Gone" });
    await store.deleteChat(c.id);
    await assert.rejects(store.renameChat(c.id, "Back?"));
    await assert.rejects(store.appendMessage(c.id, { role: "user", text: "hi" }));
    assert.equal(count(raw, "SELECT count(*) AS n FROM chat_messages"), 0);
    assert.equal(raw.query("SELECT title FROM chats WHERE id = ?", [c.id])[0].title, "Gone");
  });
});

// Covers: MEM-099
// Requirement: input is validated at the store boundary: a bad title (empty, blank, over MAX_TITLE_CHARS,
// not a string), an unknown chat id, a role outside ROLES, or an empty / oversized / non-string message is
// refused and writes nothing; the exact cap length is accepted.
describe("MEM-099 chat store: boundary validation", () => {
  test("ROLES, MAX_TITLE_CHARS and MAX_MESSAGE_CHARS are exported", () => {
    assert.deepEqual(api("ROLES"), ["user", "assistant"]);
    for (const k of ["MAX_TITLE_CHARS", "MAX_MESSAGE_CHARS"]) {
      assert.ok(Number.isInteger(api(k)) && api(k) > 0, `${k} must be a positive integer`);
    }
  });

  test("createChat refuses an empty, blank, oversized or non-string title and writes nothing", async () => {
    const { raw, store } = await fresh();
    const max = api("MAX_TITLE_CHARS");
    for (const title of ["", "   ", "t".repeat(max + 1), 42, null, { toString: () => "x" }]) {
      await assert.rejects(store.createChat({ title }), `title ${JSON.stringify(String(title)).slice(0, 20)} refused`);
    }
    assert.equal(count(raw, "SELECT count(*) AS n FROM chats"), 0);
    const ok = await store.createChat({ title: "t".repeat(max) });
    assert.equal(ok.title.length, max, "exactly MAX_TITLE_CHARS is accepted");
  });

  test("renameChat refuses a bad title or an unknown id and keeps the old title", async () => {
    const { store } = await fresh();
    const c = await store.createChat({ title: "Keep me" });
    for (const title of ["", "  ", "t".repeat(api("MAX_TITLE_CHARS") + 1), undefined]) {
      await assert.rejects(store.renameChat(c.id, title));
    }
    await assert.rejects(store.renameChat("00000000-0000-4000-8000-000000000555", "x"));
    assert.equal((await store.getChat(c.id)).title, "Keep me");
  });

  test("appendMessage refuses an unknown chat, a bad role, and empty / oversized / non-string text", async () => {
    const { raw, store } = await fresh();
    const c = await store.createChat({ title: "A" });
    const max = api("MAX_MESSAGE_CHARS");
    await assert.rejects(store.appendMessage("00000000-0000-4000-8000-000000000444", { role: "user", text: "hi" }));
    for (const msg of [
      { role: "system", text: "hi" },
      { role: "USER", text: "hi" },
      { role: "user", text: "" },
      { role: "user", text: "x".repeat(max + 1) },
      { role: "user", text: 5 },
      { role: "user" },
    ]) {
      await assert.rejects(store.appendMessage(c.id, msg), `message ${JSON.stringify(msg).slice(0, 40)} refused`);
    }
    assert.equal(count(raw, "SELECT count(*) AS n FROM chat_messages"), 0);
    const ok = await store.appendMessage(c.id, { role: "user", text: "x".repeat(max) });
    assert.equal(ok.text.length, max, "exactly MAX_MESSAGE_CHARS is accepted");
  });
});

// Covers: MEM-099
// Requirement: B5 store side: exportChats yields the live chats as backup objects and restoreChat writes a
// whole chat or nothing; a stored id (live or deleted) counts as present and is never overwritten.
describe("MEM-099 chat store: export and restore", () => {
  const CHAT_KEYS = ["created_at", "id", "messages", "title"];
  const MSG_KEYS = ["created_at", "id", "role", "text"];

  test("exportChats returns live chats only, allow-listed keys, messages oldest first", async () => {
    const { store } = await fresh();
    const a = await store.createChat({ title: "A" });
    const gone = await store.createChat({ title: "Gone" });
    await store.appendMessage(a.id, { role: "user", text: "one" });
    await store.appendMessage(a.id, { role: "assistant", text: "two" });
    await store.deleteChat(gone.id);
    const out = await store.exportChats();
    assert.equal(out.length, 1);
    assert.deepEqual(Object.keys(out[0]).sort(), CHAT_KEYS);
    assert.equal(out[0].id, a.id);
    assert.deepEqual(out[0].messages.map((m) => Object.keys(m).sort()), [MSG_KEYS, MSG_KEYS]);
    assert.deepEqual(out[0].messages.map((m) => m.text), ["one", "two"]);
  });

  test("restoreChat round-trips an exported chat into a fresh db, ids preserved", async () => {
    const src = await fresh();
    const c = await src.store.createChat({ title: "Trip" });
    await src.store.appendMessage(c.id, { role: "user", text: "pack socks" });
    const [exported] = await src.store.exportChats();
    const dst = await fresh();
    assert.equal(await dst.store.restoreChat(exported), true);
    assert.deepEqual(await dst.store.exportChats(), [exported]);
  });

  test("restoreChat of a stored id returns false and leaves the stored chat as is, even when deleted", async () => {
    const { raw, store } = await fresh();
    const c = await store.createChat({ title: "Mine" });
    const [exported] = await store.exportChats();
    assert.equal(await store.restoreChat({ ...exported, title: "Imported" }), false);
    assert.equal((await store.getChat(c.id)).title, "Mine");
    await store.deleteChat(c.id);
    assert.equal(await store.restoreChat(exported), false, "a deleted id still counts as present");
    assert.equal(await store.getChat(c.id), null, "restore does not revive a deleted chat");
    assert.equal(count(raw, "SELECT count(*) AS n FROM chats"), 1);
  });

  test("restoreChat with one bad message throws and writes neither the chat nor any message", async () => {
    const { raw, store } = await fresh();
    const chat = {
      id: "00000000-0000-4000-8000-000000000101",
      title: "Half",
      created_at: "2026-11-03T09:00:00.000Z",
      messages: [
        { id: "00000000-0000-4000-8000-000000000102", role: "user", text: "fine", created_at: "2026-11-03T09:00:01.000Z" },
        { id: "00000000-0000-4000-8000-000000000103", role: "system", text: "bad role", created_at: "2026-11-03T09:00:02.000Z" },
      ],
    };
    await assert.rejects(store.restoreChat(chat));
    assert.equal(count(raw, "SELECT count(*) AS n FROM chats"), 0);
    assert.equal(count(raw, "SELECT count(*) AS n FROM chat_messages"), 0);
  });
});

// Covers: MEM-099
// Requirement: a chat never grows past what a backup can carry: chat_store exports MAX_CHAT_MESSAGES equal to
// palace_export's MAX_IMPORT_CHAT_MESSAGES, and appendMessage on a chat already holding MAX_CHAT_MESSAGES
// messages is refused and writes nothing (no message row, updated_at unchanged), so one long chat can never
// make buildBackup refuse the whole backup. The message that reaches the cap is accepted.
describe("MEM-099 chat store: per-chat message cap", () => {
  /** Seeds n valid messages straight into chat_messages (raw SQL, so the test stays fast). */
  function seedMessages(raw, chatId, n) {
    raw.exec(
      `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
       INSERT INTO chat_messages (id, chat_id, role, text, created_at)
       SELECT printf('00000000-0000-4000-8000-%012d', i), ?, 'user', 'm' || i, '2026-11-03T09:00:00.500Z' FROM k`,
      [n, chatId]);
  }

  test("MAX_CHAT_MESSAGES is exported and equals palace_export MAX_IMPORT_CHAT_MESSAGES", async () => {
    const exp = await import("./palace_export.js");
    const max = api("MAX_CHAT_MESSAGES");
    assert.ok(Number.isInteger(max) && max > 0, "MAX_CHAT_MESSAGES must be a positive integer");
    assert.equal(max, exp.MAX_IMPORT_CHAT_MESSAGES);
  });

  test("appendMessage at MAX_CHAT_MESSAGES - 1 messages succeeds and reaches the cap", async () => {
    const { raw, store } = await fresh();
    const max = api("MAX_CHAT_MESSAGES");
    const c = await store.createChat({ title: "Long" });
    seedMessages(raw, c.id, max - 1);
    await store.appendMessage(c.id, { role: "user", text: "last one" });
    assert.equal(count(raw, "SELECT count(*) AS n FROM chat_messages WHERE chat_id = ?", [c.id]), max);
  });

  test("appendMessage on a chat holding MAX_CHAT_MESSAGES messages throws and writes nothing", async () => {
    const { raw, store } = await fresh();
    const max = api("MAX_CHAT_MESSAGES");
    const c = await store.createChat({ title: "Full" });
    seedMessages(raw, c.id, max);
    const before = (await store.getChat(c.id)).updated_at;
    await assert.rejects(store.appendMessage(c.id, { role: "user", text: "one too many" }));
    assert.equal(count(raw, "SELECT count(*) AS n FROM chat_messages WHERE chat_id = ?", [c.id]), max);
    assert.equal((await store.getChat(c.id)).updated_at, before, "a refused message must not bump updated_at");
  });

  test("the cap is per chat: a full chat does not block appending to another chat", async () => {
    const { raw, store } = await fresh();
    const full = await store.createChat({ title: "Full" });
    seedMessages(raw, full.id, api("MAX_CHAT_MESSAGES"));
    const other = await store.createChat({ title: "Other" });
    await store.appendMessage(other.id, { role: "user", text: "still fine" });
    assert.equal(count(raw, "SELECT count(*) AS n FROM chat_messages WHERE chat_id = ?", [other.id]), 1);
  });
});
