// Covers: MEM-099
// Requirement: the Pal copilot is a Messenger-style chat bubble on every screen (MEM-099 B1/B2/B4, ADR 0058
// amendment 2026-11-03). Tap, click or Enter opens its panel; Esc or a click outside collapses it and
// reopening resumes the same chat. The bubble is dragged with pointer events (touch and mouse), stays where
// dropped, is clamped inside the viewport and re-clamped on resize, moves with the arrow keys, and keeps its
// position across reloads; a drag never opens it. In the panel the user lists, switches, creates and renames
// chats; delete is a click plus a confirm, always followed by an Undo that revives the chat.
// Contract (RED; GREEN implements static/pal_bubble.js + static/pal_bubble.css):
//   pal_bubble.js self-mounts in the browser but importing it where no document exists (node) does not throw.
//   export mountPalBubble({doc, win, storage, chats}) (may return a promise; awaited here): appends its DOM to
//     doc.body. win = {innerWidth, innerHeight, addEventListener}; storage = localStorage shape (getItem /
//     setItem; may throw or hold garbage, never fatal); chats = chat store (chat_store.js API: listChats,
//     getChat, createChat, renameChat, deleteChat, reviveChat, listMessages, appendMessage).
//   DOM hooks (data-pal attribute or dataset.pal): "bubble" (BUTTON, aria-label, aria-expanded "true"/"false",
//     positioned by style.left / style.top in px, size read from getBoundingClientRect()), "panel" (hidden when
//     collapsed), "title" (active chat title), "message" (one per message of the active chat, in order), "new",
//     "rename", "rename-input" (INPUT; Enter saves), "delete", "confirm-delete", "cancel-delete", "undo".
//     Each listed chat is an element with data-pal-chat = chat id (dataset.palChat); clicking it switches.
//   First open shows listChats()[0]. Viewport clamp: 0 <= left <= innerWidth - width, same for top (an edge
//   margin up to 16 px is allowed). Uses static/fake_dom_test.mjs fakePage (no querySelector).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakePage, find, findAll, settle } from "./fake_dom_test.mjs";

const mod = await import("./pal_bubble.js").catch((err) => ({ __missing: String(err) }));

const SIZE = 56;
const MARGIN = 16;

function mount(opts) {
  assert.equal(typeof mod.mountPalBubble, "function", `static/pal_bubble.js must export mountPalBubble (${mod.__missing ?? "not exported"})`);
  return mod.mountPalBubble(opts);
}

function fakeWin(innerWidth = 400, innerHeight = 800) {
  const listeners = {};
  return {
    innerWidth,
    innerHeight,
    addEventListener: (t, fn) => (listeners[t] ??= []).push(fn),
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn); },
    fire(t) { for (const fn of [...(listeners[t] ?? [])]) fn({ type: t }); },
  };
}

function memStorage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k) };
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
    async renameChat(cid, title) {
      const r = live(cid);
      if (!r || typeof title !== "string" || !title.trim()) throw new Error("bad rename");
      r.title = title;
      return { id: r.id, title };
    },
    async deleteChat(cid) { const r = live(cid); if (!r) throw new Error("unknown"); r.deleted = true; },
    async reviveChat(cid) { const r = rows.find((x) => x.id === cid); if (!r) throw new Error("unknown"); r.deleted = false; return { id: r.id, title: r.title }; },
    async listMessages(cid) { return (rows.find((r) => r.id === cid)?.messages ?? []).map((m) => ({ ...m })); },
    async appendMessage(cid, { role, text }) { const m = { id: id(), chat_id: cid, role, text }; live(cid).messages.push(m); return m; },
  };
  for (const t of titles) rows.push({ id: id(), title: t, messages: [{ id: id(), role: "user", text: `about ${t}` }], deleted: false });
  return api;
}

async function setup({ win = fakeWin(), storage = memStorage(), chats = fakeChats(["Older", "Newer"]) } = {}) {
  const page = fakePage(["body", "main"]);
  page.doc.body = page.els.body;
  const px = (v) => Number.parseFloat(v) || 0;
  page.layout.rectOf = (el) => {
    if (el.dataset?.pal !== "bubble") return {};
    const left = px(el.style.left);
    const top = px(el.style.top);
    return { left, top, x: left, y: top, width: SIZE, height: SIZE, right: left + SIZE, bottom: top + SIZE };
  };
  await mount({ doc: page.doc, win, storage, chats });
  await settle();
  const by = (pal, opts) => find(page.els.body, (n) => n.dataset?.pal === pal, opts);
  const bubble = by("bubble");
  assert.ok(bubble, "a data-pal=bubble element is mounted into doc.body");
  const panel = () => by("panel");
  const isOpen = () => panel() !== null && !panel().hidden;
  const pos = () => ({ x: px(bubble.style.left), y: px(bubble.style.top) });
  const click = async (el) => { assert.ok(el, "element to click exists and is visible"); page.fire(el, "click"); await settle(); };
  const drag = async (dx, dy, pointerType = "mouse") => {
    const base = { pointerId: 1, button: 0, isPrimary: true, pointerType };
    page.fire(bubble, "pointerdown", { ...base, clientX: 200, clientY: 400 });
    page.fire(bubble, "pointermove", { ...base, clientX: 200 + dx / 2, clientY: 400 + dy / 2 });
    page.fire(bubble, "pointermove", { ...base, clientX: 200 + dx, clientY: 400 + dy });
    page.fire(bubble, "pointerup", { ...base, clientX: 200 + dx, clientY: 400 + dy });
    page.fire(bubble, "click");
    await settle();
  };
  const key = async (el, k) => { const ev = page.fire(el, "keydown", { key: k }); await settle(); return ev; };
  const visible = (pal) => by(pal, { visibleOnly: true });
  const chatItems = () => findAll(page.els.body, (n) => typeof n.dataset?.palChat === "string", { visibleOnly: true });
  return { page, win, storage, chats, bubble, panel, isOpen, pos, click, drag, key, visible, chatItems, by };
}

function assertInside(p, win) {
  assert.ok(p.x >= 0 && p.x <= win.innerWidth - SIZE, `x ${p.x} inside [0, ${win.innerWidth - SIZE}]`);
  assert.ok(p.y >= 0 && p.y <= win.innerHeight - SIZE, `y ${p.y} inside [0, ${win.innerHeight - SIZE}]`);
}

// Covers: MEM-099
// Requirement: B1: one tap, click or Enter opens the panel; Esc or a click outside collapses it; a click inside
// keeps it open; reopening resumes the chat the user last had open. The bubble is an accessible button.
describe("MEM-099 Pal bubble: open, collapse, resume", () => {
  test("importing in node (no document) does not throw and exports mountPalBubble", () => {
    assert.equal(typeof mod.mountPalBubble, "function", mod.__missing ?? "mountPalBubble not exported");
  });

  test("the bubble is a labelled BUTTON; click opens the panel and sets aria-expanded", async () => {
    const t = await setup();
    assert.equal(t.bubble.tagName, "BUTTON");
    assert.ok((t.bubble.getAttribute("aria-label") ?? "").trim(), "aria-label present");
    assert.equal(t.isOpen(), false, "starts collapsed");
    assert.equal(t.bubble.getAttribute("aria-expanded"), "false");
    await t.click(t.bubble);
    assert.equal(t.isOpen(), true);
    assert.equal(t.bubble.getAttribute("aria-expanded"), "true");
  });

  test("Enter on the bubble opens the panel; a tap (pointer down/up in place) opens it", async () => {
    const a = await setup();
    await a.key(a.bubble, "Enter");
    assert.equal(a.isOpen(), true, "Enter opens");
    const b = await setup();
    await b.drag(0, 0, "touch");
    assert.equal(b.isOpen(), true, "a tap opens");
  });

  test("Esc collapses; a click outside collapses; a click inside keeps it open", async () => {
    const t = await setup();
    await t.click(t.bubble);
    t.page.fire(t.panel(), "pointerdown", { pointerId: 1 });
    await t.click(t.panel());
    assert.equal(t.isOpen(), true, "inside click keeps it open");
    await t.key(t.panel(), "Escape");
    assert.equal(t.isOpen(), false, "Esc collapses");
    await t.click(t.bubble);
    t.page.fire(t.page.els.main, "pointerdown", { pointerId: 1 });
    await t.click(t.page.els.main);
    assert.equal(t.isOpen(), false, "outside click collapses");
  });

  test("first open shows the most recent chat; after switching, reopening resumes the chosen chat", async () => {
    const t = await setup();
    await t.click(t.bubble);
    assert.equal(t.by("title").textContent, "Newer");
    const older = (await t.chats.listChats()).find((c) => c.title === "Older");
    await t.click(t.chatItems().find((n) => n.dataset.palChat === older.id));
    assert.equal(t.by("title").textContent, "Older");
    const msgs = findAll(t.page.els.body, (n) => n.dataset?.pal === "message", { visibleOnly: true });
    assert.deepEqual(msgs.map((m) => m.textContent.includes("about Older")), [true], "the switched chat's messages show");
    await t.key(t.panel(), "Escape");
    await t.click(t.bubble);
    assert.equal(t.by("title").textContent, "Older", "reopening resumes the same chat");
  });
});

// Covers: MEM-099
// Requirement: B2: pointer drag (mouse and touch) moves the bubble and it stays where dropped, clamped at all 4
// viewport edges and re-clamped on resize; a drag never opens the panel; arrow keys move it (clamped, no page
// scroll); the position survives a reload; a garbage, throwing or off-screen stored position is never fatal.
describe("MEM-099 Pal bubble: drag, clamp, keyboard, persistence", () => {
  test("a drag never opens the panel and the bubble stays where dropped", async () => {
    const t = await setup();
    await t.drag(-10000, -10000);
    const corner = t.pos();
    await t.drag(100, 150, "touch");
    assert.deepEqual(t.pos(), { x: corner.x + 100, y: corner.y + 150 });
    assert.equal(t.isOpen(), false);
  });

  test("dragging past each edge clamps inside the viewport", async () => {
    const t = await setup();
    await t.drag(-10000, -10000);
    let p = t.pos();
    assertInside(p, t.win);
    assert.ok(p.x <= MARGIN && p.y <= MARGIN, `top-left clamp ${JSON.stringify(p)}`);
    await t.drag(20000, 20000);
    p = t.pos();
    assertInside(p, t.win);
    assert.ok(p.x >= t.win.innerWidth - SIZE - MARGIN && p.y >= t.win.innerHeight - SIZE - MARGIN, `bottom-right clamp ${JSON.stringify(p)}`);
  });

  test("a resize re-clamps the bubble into the smaller viewport", async () => {
    const t = await setup();
    await t.drag(20000, 20000);
    t.win.innerWidth = 300;
    t.win.innerHeight = 500;
    t.win.fire("resize");
    await settle();
    assertInside(t.pos(), t.win);
  });

  test("arrow keys move the bubble, are clamped, prevent page scroll and do not open it", async () => {
    const t = await setup();
    await t.drag(-10000, -10000);
    const start = t.pos();
    const ev = await t.key(t.bubble, "ArrowRight");
    assert.ok(t.pos().x > start.x, "ArrowRight moves right");
    assert.equal(ev.defaultPrevented, true, "arrow key default prevented");
    await t.key(t.bubble, "ArrowDown");
    assert.ok(t.pos().y > start.y, "ArrowDown moves down");
    await t.key(t.bubble, "ArrowUp");
    await t.key(t.bubble, "ArrowLeft");
    assert.deepEqual(t.pos(), start, "Up/Left undo Down/Right");
    for (let i = 0; i < 200; i++) await t.key(t.bubble, "ArrowLeft");
    assertInside(t.pos(), t.win);
    assert.equal(t.isOpen(), false);
  });

  test("the dropped position survives a reload (same storage, new page)", async () => {
    const storage = memStorage();
    const a = await setup({ storage });
    await a.drag(-10000, -10000);
    await a.drag(120, 90);
    const dropped = a.pos();
    const b = await setup({ storage });
    assert.deepEqual(b.pos(), dropped);
  });

  test("a keyboard move also persists", async () => {
    const storage = memStorage();
    const a = await setup({ storage });
    await a.drag(-10000, -10000);
    await a.key(a.bubble, "ArrowRight");
    const moved = a.pos();
    const b = await setup({ storage });
    assert.deepEqual(b.pos(), moved);
  });

  test("a stored position off a smaller screen is clamped on load", async () => {
    const storage = memStorage();
    const a = await setup({ storage });
    await a.drag(20000, 20000);
    const small = fakeWin(300, 500);
    const b = await setup({ storage, win: small });
    assertInside(b.pos(), small);
  });

  test("garbage or throwing storage is not fatal; the bubble mounts inside the viewport", async () => {
    const garbage = { getItem: () => "{not json", setItem: () => {}, removeItem: () => {} };
    const a = await setup({ storage: garbage });
    assertInside(a.pos(), a.win);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => {} };
    const b = await setup({ storage: throwing });
    assertInside(b.pos(), b.win);
    await b.drag(50, 50);
    assertInside(b.pos(), b.win);
  });
});

// Covers: MEM-099
// Requirement: B4: in the panel the user lists, switches, creates and renames chats; delete takes a click plus a
// confirm (cancel keeps the chat) and is always followed by an Undo that revives the chat.
describe("MEM-099 Pal bubble: manage chats", () => {
  test("every live chat is listed; New creates a chat, lists it and makes it active", async () => {
    const t = await setup();
    await t.click(t.bubble);
    assert.equal(t.chatItems().length, 2);
    await t.click(t.visible("new"));
    const all = await t.chats.listChats();
    assert.equal(all.length, 3);
    assert.equal(t.chatItems().length, 3);
    assert.ok(t.chatItems().some((n) => n.dataset.palChat === all[0].id), "new chat listed");
    assert.equal(t.by("title").textContent, all[0].title, "new chat is active");
  });

  test("Rename saves a new title on Enter; a blank title keeps the old one", async () => {
    const t = await setup();
    await t.click(t.bubble);
    await t.click(t.visible("rename"));
    let input = t.visible("rename-input");
    assert.ok(input && input.tagName === "INPUT", "rename input shown");
    assert.equal(input.value, "Newer", "prefilled with the current title");
    input.value = "Groceries";
    await t.key(input, "Enter");
    assert.ok((await t.chats.listChats()).some((c) => c.title === "Groceries"));
    assert.equal(t.by("title").textContent, "Groceries");
    await t.click(t.visible("rename"));
    input = t.visible("rename-input");
    input.value = "   ";
    await t.key(input, "Enter");
    assert.ok((await t.chats.listChats()).some((c) => c.title === "Groceries"), "blank rename refused");
    assert.equal(t.by("title").textContent, "Groceries");
  });

  test("Delete needs a confirm; cancel keeps the chat", async () => {
    const t = await setup();
    await t.click(t.bubble);
    await t.click(t.visible("delete"));
    assert.ok(t.visible("confirm-delete"), "a confirm step appears");
    assert.equal((await t.chats.listChats()).length, 2, "one click deletes nothing");
    await t.click(t.visible("cancel-delete"));
    assert.equal((await t.chats.listChats()).length, 2);
    assert.equal(t.visible("confirm-delete"), null, "confirm step dismissed");
  });

  test("confirmed delete removes the chat from the list, then Undo revives it", async () => {
    const t = await setup();
    await t.click(t.bubble);
    const target = (await t.chats.listChats())[0];
    await t.click(t.visible("delete"));
    await t.click(t.visible("confirm-delete"));
    assert.ok(!(await t.chats.listChats()).some((c) => c.id === target.id), "chat soft-deleted in the store");
    assert.ok(!t.chatItems().some((n) => n.dataset.palChat === target.id), "chat gone from the list");
    const undo = t.visible("undo");
    assert.ok(undo, "an Undo is offered after every delete");
    await t.click(undo);
    assert.ok((await t.chats.listChats()).some((c) => c.id === target.id), "Undo revives the chat");
    assert.ok(t.chatItems().some((n) => n.dataset.palChat === target.id), "revived chat listed again");
  });
});

// Covers: MEM-099
// Requirement: B2 NFR: touch drag must not scroll the page and the stylesheet is ASCII-only.
describe("MEM-099 Pal bubble stylesheet", () => {
  test("static/pal_bubble.css exists, is ASCII-only and sets touch-action: none", () => {
    const css = readFileSync(new URL("./pal_bubble.css", import.meta.url), "utf8");
    assert.ok(/^[\x00-\x7f]*$/.test(css), "ASCII only");
    assert.match(css, /touch-action\s*:\s*none/);
  });
});

// Covers: MEM-099
// Requirement: the bubble opens the database through the page-wide shared open (static/db/client.js
// sharedOpenDb), so other modules on the page (MEM-088) reuse its lock and worker instead of opening again.
describe("pal_bubble self-mount uses the shared database open", () => {
  const src = readFileSync(new URL("./pal_bubble.js", import.meta.url), "utf8");
  const selfMount = src.slice(src.indexOf("async function selfMount"));

  test("selfMount calls sharedOpenDb from ./db/client.js", () => {
    assert.ok(src.includes("async function selfMount"), "pal_bubble.js must define selfMount");
    assert.match(selfMount, /\{\s*sharedOpenDb\s*\}\s*=\s*await import\("\.\/db\/client\.js"\)/);
    assert.match(selfMount, /sharedOpenDb\(\{/);
  });

  test("selfMount does not call openDb directly", () => {
    assert.doesNotMatch(selfMount, /(^|[^A-Za-z])openDb\(/);
  });
});
