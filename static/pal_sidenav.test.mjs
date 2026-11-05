// Covers: MEM-115
// Requirement: the Pal chat panel follows the Copilot/Claude pattern (MEM-115): no row of New/Rename/Delete text
// buttons; the header is a "Chats" sidenav toggle icon, the active chat title as plain h2 text and a "New chat"
// icon. Chat history is a nav sidenav ("Chat history") of full-width text rows; only the active row carries a
// rename icon and a delete icon. Delete still needs a confirm step (in the sidenav) and then offers Undo. Narrow
// screens toggle the sidenav as a drawer (panel class pal-sidenav-open) that closes when a chat is picked; at
// 720 px and wider it is a persistent left column. Tested through mountPalBubble with the fake DOM.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakePage, find, findAll, settle } from "./fake_dom_test.mjs";
import { mountPalBubble } from "./pal_bubble.js";

function fakeWin() {
  return { innerWidth: 375, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
}

/** In-memory chat store with the chat_store.js API; listChats is most recently created first. */
function fakeChats(titles = []) {
  let n = 0;
  const rows = [];
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const live = (cid) => rows.find((r) => r.id === cid && !r.deleted);
  const api = {
    rows,
    async listChats() { return rows.filter((r) => !r.deleted).slice().reverse().map(({ id, title }) => ({ id, title })); },
    async getChat(cid) { const r = live(cid); return r ? { id: r.id, title: r.title } : null; },
    async createChat({ title = "New chat" } = {}) { const r = { id: id(), title, messages: [], deleted: false }; rows.push(r); return { id: r.id, title }; },
    async renameChat(cid, title) { const r = live(cid); r.title = title; return { id: r.id, title }; },
    async deleteChat(cid) { const r = live(cid); if (!r) throw new Error("unknown"); r.deleted = true; },
    async reviveChat(cid) { const r = rows.find((x) => x.id === cid); r.deleted = false; return { id: r.id, title: r.title }; },
    async listMessages(cid) { return (rows.find((r) => r.id === cid)?.messages ?? []).map((m) => ({ ...m })); },
    async appendMessage(cid, { role, text }) { const m = { id: id(), chat_id: cid, role, text }; live(cid).messages.push(m); return m; },
  };
  for (const t of titles) rows.push({ id: id(), title: t, messages: [], deleted: false });
  return api;
}

/** className-set or classList-set class (the fake keeps the two separate). */
function hasClass(n, c) {
  return Boolean(n?.classList?.contains(c)) || String(n?.className ?? "").split(/\s+/).includes(c);
}

function within(node, root) {
  for (let n = node; n; n = n.parent) if (n === root) return true;
  return false;
}

function closestLi(node) {
  for (let n = node; n; n = n.parent) if (n.tagName === "LI") return n;
  return null;
}

async function open(chats = fakeChats(["Older", "Newer"])) {
  const page = fakePage(["head", "body"]);
  page.doc.head = page.els.head;
  page.doc.body = page.els.body;
  await mountPalBubble({ doc: page.doc, win: fakeWin(), storage: null, chats });
  const body = page.doc.body;
  const by = (pal) => find(body, (n) => n.dataset?.pal === pal);
  const all = (pal) => findAll(body, (n) => n.dataset?.pal === pal);
  const visible = (pal) => find(body, (n) => n.dataset?.pal === pal, { visibleOnly: true });
  const click = async (el) => { assert.ok(el, "element to click exists"); page.fire(el, "click"); await settle(); };
  const rows = () => findAll(by("sidenav"), (n) => n.tagName === "BUTTON" && typeof n.dataset?.palChat === "string");
  const activeRow = () => rows().find((n) => hasClass(n, "pal-chat-active")) ?? null;
  await click(by("bubble"));
  return { page, body, chats, by, all, visible, click, rows, activeRow };
}

function assertIconButton(btn, label) {
  assert.ok(btn, `${label} button exists`);
  assert.equal(btn.tagName, "BUTTON");
  assert.equal(btn.getAttribute("aria-label"), label);
  assert.ok(find(btn, (n) => n.tagName === "SVG"), `${label} button shows an svg icon`);
}

describe("MEM-115 Pal chat sidenav, text title, icon actions", () => {
  test("B1: no .pal-actions row exists", async () => {
    const t = await open();
    assert.equal(find(t.body, (n) => hasClass(n, "pal-actions") || n.dataset?.pal === "actions"), null);
  });

  test("B1: the title is plain h2 text of the active chat, not a button", async () => {
    const t = await open();
    const title = t.by("title");
    assert.ok(title, "data-pal=title exists");
    assert.equal(title.tagName, "H2");
    assert.equal(title.textContent, "Newer");
    assert.equal(find(title, (n) => n.tagName === "BUTTON"), null, "no button inside the title");
    for (let n = title.parent; n; n = n.parent) assert.notEqual(n.tagName, "BUTTON", "title is not inside a button");
  });

  test("B1: New chat and Chats toggle are labelled icon buttons", async () => {
    const t = await open();
    assertIconButton(t.by("new"), "New chat");
    const toggle = t.by("sidenav-toggle");
    assertIconButton(toggle, "Chats");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
  });

  test("B5: the toggle opens and closes the drawer via panel class pal-sidenav-open", async () => {
    const t = await open();
    const panel = t.by("panel");
    const toggle = t.by("sidenav-toggle");
    assert.equal(hasClass(panel, "pal-sidenav-open"), false, "drawer starts closed");
    await t.click(toggle);
    assert.equal(hasClass(panel, "pal-sidenav-open"), true, "drawer open");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    await t.click(toggle);
    assert.equal(hasClass(panel, "pal-sidenav-open"), false, "drawer closed again");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
  });

  test("B5: picking a chat in the open drawer switches and closes the drawer", async () => {
    const t = await open();
    const panel = t.by("panel");
    const toggle = t.by("sidenav-toggle");
    await t.click(toggle);
    const older = t.rows().find((r) => r.textContent.includes("Older"));
    await t.click(older);
    assert.equal(t.by("title").textContent, "Older");
    assert.equal(hasClass(panel, "pal-sidenav-open"), false, "drawer closed");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
  });

  test("B2: a nav sidenav labelled Chat history lists chats as rows, active row marked", async () => {
    const t = await open();
    const nav = t.by("sidenav");
    assert.ok(nav, "data-pal=sidenav exists");
    assert.equal(nav.tagName, "NAV");
    assert.equal(nav.getAttribute("aria-label"), "Chat history");
    assert.equal(nav.hidden, false, "sidenav is not hidden by attribute (CSS drives the drawer)");
    assert.deepEqual(t.rows().map((r) => r.textContent.trim()), ["Newer", "Older"]);
    const active = t.activeRow();
    assert.ok(active, "an active row");
    assert.equal(active.textContent.trim(), "Newer");
    assert.equal(t.rows().filter((r) => hasClass(r, "pal-chat-active")).length, 1);
  });

  test("B3: exactly one rename and one delete icon, on the active row in the sidenav", async () => {
    const t = await open();
    assert.equal(t.all("rename").length, 1, "one rename");
    assert.equal(t.all("delete").length, 1, "one delete");
    assertIconButton(t.by("rename"), "Rename chat");
    assertIconButton(t.by("delete"), "Delete chat");
    const li = closestLi(t.activeRow());
    assert.ok(li && within(li, t.by("sidenav")), "active row sits in an li inside the sidenav");
    assert.ok(within(t.by("rename"), li), "rename on the active row");
    assert.ok(within(t.by("delete"), li), "delete on the active row");
  });

  test("B3: switching chats moves rename and delete to the new active row", async () => {
    const t = await open();
    await t.click(t.rows().find((r) => r.textContent.includes("Older")));
    assert.equal(t.activeRow()?.textContent.trim(), "Older");
    assert.equal(t.all("rename").length, 1);
    assert.equal(t.all("delete").length, 1);
    const li = closestLi(t.activeRow());
    assert.ok(within(t.by("rename"), li), "rename moved");
    assert.ok(within(t.by("delete"), li), "delete moved");
  });

  test("B2 repro: a new chat appears only as the active sidenav row, never as another header button", async () => {
    const t = await open();
    await t.click(t.by("new"));
    const nav = t.by("sidenav");
    const fresh = t.rows().filter((r) => r.textContent.trim() === "New chat");
    assert.equal(fresh.length, 1, "one New chat row in the sidenav");
    assert.equal(fresh[0], t.activeRow(), "the new chat row is active");
    const li = closestLi(fresh[0]);
    assert.ok(li && within(li, nav), "row is an li > button[data-pal-chat] inside the sidenav");
    assert.equal(t.rows().length, 3);
    const title = t.by("title");
    assert.equal(title.textContent, "New chat");
    const leaks = findAll(t.body, (n) =>
      n.children.every((c) => typeof c === "string") &&
      n.textContent.includes("New chat") &&
      !within(n, nav) &&
      !within(n, title));
    assert.deepEqual(leaks.map((n) => `${n.tagName}[data-pal=${n.dataset?.pal}]`), [], "no 'New chat' text outside the sidenav and title");
  });

  test("B4: delete arms a confirm in the sidenav, confirm deletes, Undo revives", async () => {
    const t = await open();
    const target = (await t.chats.listChats())[0];
    await t.click(t.by("delete"));
    assert.equal((await t.chats.listChats()).length, 2, "one click deletes nothing");
    const confirmRow = t.visible("confirm-row");
    assert.ok(confirmRow, "confirm step shows");
    assert.ok(within(confirmRow, t.by("sidenav")), "confirm row sits in the sidenav");
    await t.click(t.visible("confirm-delete"));
    assert.ok(!(await t.chats.listChats()).some((c) => c.id === target.id), "chat soft-deleted");
    assert.ok(!t.rows().some((r) => r.dataset.palChat === target.id), "row gone");
    const undoRow = t.visible("undo-row");
    assert.ok(undoRow, "Undo offered");
    assert.equal(within(undoRow, t.by("sidenav")), false, "Undo toast sits outside the sidenav");
    await t.click(t.visible("undo"));
    assert.ok((await t.chats.listChats()).some((c) => c.id === target.id), "Undo revives");
    assert.ok(t.rows().some((r) => r.dataset.palChat === target.id), "row back");
  });
});

describe("MEM-115 sidenav CSS and source bytes", () => {
  test("B5: >= 720 px shows the sidenav as a column; the drawer class is styled", () => {
    const css = readFileSync(new URL("./pal_bubble.css", import.meta.url), "utf8");
    assert.match(css, /@media\s*\(\s*min-width:\s*720px\s*\)\s*\{[\s\S]*?\.pal-sidenav/);
    assert.match(css, /\.pal-sidenav-open/);
    assert.doesNotMatch(css, /\.pal-actions/, "stale .pal-actions rules removed");
  });

  test("B2: sidenav rows are styled as text rows, without button chrome", () => {
    const css = readFileSync(new URL("./pal_bubble.css", import.meta.url), "utf8");
    const rules = [...css.matchAll(/([^{}]*\.pal-sidenav[^{}]*\[data-pal-chat\][^{}]*)\{([^}]*)\}/g)].map((m) => m[2]);
    assert.ok(rules.length > 0, "a .pal-sidenav [data-pal-chat] rule exists");
    const body = rules.join(";");
    assert.match(body, /text-align:\s*left/);
    assert.match(body, /background(-color)?:\s*(transparent|none)/);
  });

  test("NFR: pal_bubble.js source is ASCII-only", () => {
    const bytes = readFileSync(new URL("./pal_bubble.js", import.meta.url));
    assert.equal(bytes.filter((b) => b > 127).length, 0);
  });
});
