// Covers: MEM-116
// Requirement: the Pal chat panel reads like Messenger / WhatsApp / ChatGPT (MEM-116): user bubbles right, Pal
// bubbles left with Pal's face, each with a timestamp; an empty chat shows a Pal greeting; a composer at the bottom
// sends on Enter (Shift+Enter is a newline, blank text never sends), shows a typing indicator while Pal replies, and
// the message list scrolls to the newest message. Tested through mountPalBubble with the fake DOM.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakePage, find, findAll, settle, deferred } from "./fake_dom_test.mjs";
import { mountPalBubble } from "./pal_bubble.js";

function fakeWin() {
  return { innerWidth: 375, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
}

function fakeChats(seed = []) {
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const chat = { id: id(), title: "Chat", messages: seed.map((m) => ({ id: id(), ...m })) };
  return {
    chat,
    async listChats() { return [{ id: chat.id, title: chat.title }]; },
    async createChat() { return { id: chat.id, title: chat.title }; },
    async listMessages() { return chat.messages.map((m) => ({ ...m })); },
    async appendMessage(cid, { role, text }) {
      const m = { id: id(), chat_id: cid, role, text, created_at: "2026-11-04T19:05:00.000Z" };
      chat.messages.push(m);
      return m;
    },
  };
}

async function open(chats, extra = {}) {
  const page = fakePage(["head", "body"]);
  page.doc.head = page.els.head;
  page.doc.body = page.els.body;
  await mountPalBubble({ doc: page.doc, win: fakeWin(), storage: null, chats, ...extra });
  const body = page.doc.body;
  const by = (pal) => find(body, (n) => n.dataset?.pal === pal);
  page.fire(by("bubble"), "click");
  await settle();
  return { page, body, by, all: (pal) => findAll(body, (n) => n.dataset?.pal === pal, { visibleOnly: true }) };
}

async function type(t, text, init = {}) {
  const input = t.by("composer-input");
  input.value = text;
  t.page.fire(input, "input");
  t.page.fire(input, "keydown", { key: "Enter", ...init });
  await settle();
}

describe("Pal chat panel: messenger-style bubbles", () => {
  test("user messages sit right, Pal's left with a face avatar, each with a time", async () => {
    const t = await open(fakeChats([
      { role: "user", text: "hi pal", created_at: "2026-11-04T19:01:00.000Z" },
      { role: "assistant", text: "hello!", created_at: "2026-11-04T19:02:00.000Z" },
    ]));
    const [u, p] = t.all("message");
    assert.ok(u.classList.contains("pal-msg--user"), "user bubble class");
    assert.ok(p.classList.contains("pal-msg--pal"), "Pal bubble class");
    assert.ok(find(p, (n) => n.dataset?.pal === "avatar" && n.tagName === "IMG"), "Pal bubble has the face");
    assert.equal(find(u, (n) => n.dataset?.pal === "avatar"), null, "user bubble has no Pal face");
    for (const m of [u, p]) {
      const time = find(m, (n) => n.tagName === "TIME");
      assert.ok(time, "timestamp element");
      assert.match(time.getAttribute("datetime"), /^2026-11-04T19:0[12]/);
      assert.ok(time.textContent.length > 0);
    }
    assert.ok(u.textContent.includes("hi pal") && p.textContent.includes("hello!"));
  });

  test("a message with no created_at still renders, with no time", async () => {
    const t = await open(fakeChats([{ role: "user", text: "legacy" }]));
    const [m] = t.all("message");
    assert.ok(m.textContent.includes("legacy"));
    assert.equal(find(m, (n) => n.tagName === "TIME"), null);
  });

  test("an empty chat shows Pal's greeting, gone once a message exists", async () => {
    const t = await open(fakeChats());
    const empty = t.by("empty");
    assert.ok(empty && !empty.hidden, "greeting shows");
    assert.match(empty.textContent, /Pal/);
    await type(t, "first");
    assert.equal(t.all("empty").length, 0, "greeting gone");
  });
});

describe("Pal chat panel: composer", () => {
  test("Enter sends the trimmed text as a user message and clears the box", async () => {
    const chats = fakeChats();
    const t = await open(chats);
    await type(t, "  remember the bagel  ");
    assert.deepEqual(chats.chat.messages.map((m) => [m.role, m.text]), [["user", "remember the bagel"]]);
    assert.equal(t.by("composer-input").value, "");
    assert.equal(t.all("message").length, 1);
  });

  test("Shift+Enter does not send; blank text never sends", async () => {
    const chats = fakeChats();
    const t = await open(chats);
    await type(t, "line one", { shiftKey: true });
    assert.equal(chats.chat.messages.length, 0, "Shift+Enter is a newline");
    await type(t, "   ");
    assert.equal(chats.chat.messages.length, 0, "blank refused");
    assert.equal(t.by("send").disabled, true, "send disabled while blank");
  });

  test("the send button sends too", async () => {
    const chats = fakeChats();
    const t = await open(chats);
    const input = t.by("composer-input");
    input.value = "via button";
    t.page.fire(input, "input");
    assert.equal(t.by("send").disabled, false);
    t.page.fire(t.by("send"), "click");
    await settle();
    assert.equal(chats.chat.messages[0]?.text, "via button");
  });

  test("a typing indicator shows while Pal replies, then the reply lands as a Pal bubble", async () => {
    const chats = fakeChats();
    const gate = deferred();
    const seen = [];
    const t = await open(chats, { reply: async (text) => { seen.push(text); await gate.promise; return "got it"; } });
    await type(t, "what's at stop 2?");
    assert.deepEqual(seen, ["what's at stop 2?"]);
    assert.equal(t.all("typing").length, 1, "typing indicator while waiting");
    gate.resolve();
    await settle();
    assert.equal(t.all("typing").length, 0, "indicator gone after the reply");
    assert.deepEqual(chats.chat.messages.map((m) => m.role), ["user", "assistant"]);
    assert.ok(t.all("message")[1].classList.contains("pal-msg--pal"));
  });

  test("a failing reply clears the indicator and keeps the user message", async () => {
    const chats = fakeChats();
    const t = await open(chats, { reply: async () => { throw new Error("offline"); } });
    await type(t, "hello?");
    assert.equal(t.all("typing").length, 0);
    assert.deepEqual(chats.chat.messages.map((m) => m.role), ["user"]);
    assert.ok(t.by("chat-error") && !t.by("chat-error").hidden, "error notice shows");
  });

  test("the message list scrolls to the newest message", async () => {
    const t = await open(fakeChats());
    const list = t.by("messages");
    list.scrollHeight = 900;
    await type(t, "scroll me");
    assert.equal(list.scrollTop, 900);
  });
});

describe("Pal chat panel: CSS", () => {
  const css = readFileSync(new URL("./pal_bubble.css", import.meta.url), "utf8");
  test("bubbles use theme tokens and the composer sticks to the panel bottom", () => {
    assert.match(css, /\.pal-msg--user[^{]*\{[^}]*var\(--primary/);
    assert.match(css, /\.pal-composer[^{]*\{[^}]*position:\s*sticky/);
    assert.match(css, /\.pal-composer[^{]*\{[^}]*bottom:\s*0/);
  });
  test("typing dots stop under prefers-reduced-motion", () => {
    assert.match(css, /prefers-reduced-motion[\s\S]*\.pal-typing/);
  });
});
