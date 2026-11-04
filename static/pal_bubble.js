// @ts-check
// Pal chat bubble (MEM-099, ADR 0064 amendment 2026-11-03): a draggable button on every screen that opens
// a panel of on-device chats (chat_store.js). Self-mounts in the browser; importing it in node is inert.
import { isTitle, MAX_TITLE_CHARS } from "./chat_store.js";

const POS_KEY = "memripal.palBubble.pos";
const STYLE_HREF = "/static/pal_bubble.css";
const SIZE = 56; // fallback before layout; pal_bubble.css .pal-bubble
const MARGIN = 8;
const STEP = 16; // arrow-key move, px
const DRAG_START = 4; // px of travel before a press becomes a drag (so a tap still opens)

/** @param {any} node @param {any} root  Walks parents: no contains() needed. */
function within(node, root) {
  for (let n = node; n; n = n.parentNode) if (n === root) return true;
  return false;
}

/** @param {number} v @param {number} size @param {number} extent */
function clamp(v, size, extent) {
  const hi = Math.max(MARGIN, extent - size - MARGIN);
  return Math.max(0, Math.min(Math.max(v, MARGIN), hi, extent - size));
}

/**
 * Links pal_bubble.css once from <head>, so index.html needs only the module <script> (its <link> list is
 * pinned). Walks head.children: the test fake DOM has no querySelector.
 * @param {any} doc
 */
function linkStylesheet(doc) {
  const linked = [...doc.head.children].some(
    (/** @type {any} */ n) =>
      n.tagName === "LINK" && n.getAttribute("rel") === "stylesheet" && n.getAttribute("href") === STYLE_HREF,
  );
  if (linked) return;
  const link = doc.createElement("link");
  link.setAttribute("rel", "stylesheet");
  link.setAttribute("href", STYLE_HREF);
  doc.head.append(link);
}

/** @param {{doc: any, win: any, storage: any, chats: any}} deps */
export async function mountPalBubble({ doc, win, storage, chats }) {
  /** @param {string} tag @param {string} pal @param {string} [text] */
  const make = (tag, pal, text) => {
    const n = doc.createElement(tag);
    if (pal) n.dataset.pal = pal;
    if (text !== undefined) n.textContent = text;
    if (tag === "button") n.type = "button";
    return n;
  };
  linkStylesheet(doc);
  const root = make("div", "root");
  const bubble = make("button", "bubble", "Pal");
  bubble.className = "pal-bubble";
  bubble.setAttribute("aria-label", "Open Pal chats");
  bubble.setAttribute("aria-expanded", "false");
  const panel = make("section", "panel");
  panel.className = "pal-panel";
  panel.setAttribute("aria-label", "Pal chats");
  panel.hidden = true;
  const title = make("h2", "title");
  const renameInput = make("input", "rename-input");
  renameInput.maxLength = MAX_TITLE_CHARS;
  renameInput.setAttribute("aria-label", "Chat title");
  renameInput.hidden = true;
  const newBtn = make("button", "new", "New chat");
  const renameBtn = make("button", "rename", "Rename");
  const deleteBtn = make("button", "delete", "Delete");
  const confirmRow = make("div", "confirm-row", "Delete this chat? ");
  confirmRow.append(make("button", "confirm-delete", "Delete"), make("button", "cancel-delete", "Cancel"));
  confirmRow.hidden = true;
  const undoRow = make("div", "undo-row", "Chat deleted. ");
  const undoBtn = make("button", "undo", "Undo");
  undoRow.append(undoBtn);
  undoRow.hidden = true;
  const list = make("ul", "chats");
  const messages = make("ol", "messages");
  panel.append(title, renameInput, newBtn, renameBtn, deleteBtn, confirmRow, undoRow, list, messages);
  root.append(bubble, panel);
  doc.body.append(root);

  /** @type {string | null} */
  let activeId = null;
  /** @type {string | null} */
  let deletedId = null;

  // --- position: clamped, persisted; storage may throw or hold garbage ---
  const size = () => {
    const r = bubble.getBoundingClientRect();
    return { w: r.width || SIZE, h: r.height || SIZE };
  };
  let pos = { x: win.innerWidth, y: win.innerHeight - 96 };
  try {
    const saved = JSON.parse(storage.getItem(POS_KEY));
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) pos = { x: saved.x, y: saved.y };
  } catch {
    // unreadable or garbage: keep the default corner
  }
  /** @param {number} x @param {number} y */
  const place = (x, y) => {
    const { w, h } = size();
    pos = { x: clamp(x, w, win.innerWidth), y: clamp(y, h, win.innerHeight) };
    bubble.style.left = `${pos.x}px`;
    bubble.style.top = `${pos.y}px`;
  };
  const save = () => {
    try {
      storage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
      // storage denied: the position just does not survive a reload
    }
  };
  place(pos.x, pos.y);
  win.addEventListener("resize", () => place(pos.x, pos.y));

  // --- drag: pointer events cover mouse and touch; a drag swallows the click that follows ---
  /** @type {{id: number, cx: number, cy: number, x: number, y: number} | null} */
  let press = null;
  let dragged = false;
  bubble.addEventListener("pointerdown", (/** @type {any} */ ev) => {
    if (ev.button !== 0) return;
    press = { id: ev.pointerId, cx: ev.clientX, cy: ev.clientY, x: pos.x, y: pos.y };
    dragged = false;
    bubble.setPointerCapture?.(ev.pointerId);
  });
  bubble.addEventListener("pointermove", (/** @type {any} */ ev) => {
    if (!press || ev.pointerId !== press.id) return;
    const dx = ev.clientX - press.cx;
    const dy = ev.clientY - press.cy;
    if (!dragged && Math.hypot(dx, dy) < DRAG_START) return;
    dragged = true;
    place(press.x + dx, press.y + dy);
  });
  const release = (/** @type {any} */ ev) => {
    if (!press || ev.pointerId !== press.id) return;
    press = null;
    if (dragged) save();
  };
  bubble.addEventListener("pointerup", release);
  bubble.addEventListener("pointercancel", release);

  // --- open / collapse ---
  const setOpen = async (/** @type {boolean} */ open) => {
    panel.hidden = !open;
    bubble.setAttribute("aria-expanded", String(open));
    if (open) await render();
  };
  bubble.addEventListener("click", () => {
    if (dragged) {
      dragged = false;
      return;
    }
    setOpen(panel.hidden);
  });
  const ARROWS = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
  bubble.addEventListener("keydown", (/** @type {any} */ ev) => {
    if (ev.key === "Enter") {
      // preventDefault also stops the browser's own Enter -> click, which would toggle it back.
      ev.preventDefault();
      setOpen(panel.hidden);
    } else if (ev.key in ARROWS) {
      ev.preventDefault();
      const [dx, dy] = ARROWS[/** @type {keyof typeof ARROWS} */ (ev.key)];
      place(pos.x + dx, pos.y + dy);
      save();
    }
  });
  doc.addEventListener("keydown", (/** @type {any} */ ev) => {
    if (ev.key === "Escape" && !panel.hidden) setOpen(false);
  });
  doc.addEventListener("pointerdown", (/** @type {any} */ ev) => {
    if (!panel.hidden && !within(ev.target, root)) setOpen(false);
  });

  // --- chats ---
  async function render() {
    const all = chats ? await chats.listChats() : [];
    let active = all.find((/** @type {any} */ c) => c.id === activeId) ?? all[0] ?? null;
    activeId = active ? active.id : null;
    title.textContent = active ? active.title : chats ? "No chats yet" : "Chats unavailable in this tab";
    newBtn.hidden = !chats;
    renameBtn.hidden = deleteBtn.hidden = !active;
    list.replaceChildren(...all.map((/** @type {any} */ c) => {
      const li = make("li", "");
      const b = make("button", "", c.title);
      b.dataset.palChat = c.id;
      if (c.id === activeId) b.className = "pal-chat-active";
      b.addEventListener("click", () => {
        activeId = c.id;
        render();
      });
      li.append(b);
      return li;
    }));
    const msgs = active ? await chats.listMessages(active.id) : [];
    messages.replaceChildren(...msgs.map((/** @type {any} */ m) => {
      const li = make("li", "message", `${m.role === "user" ? "You" : "Pal"}: ${m.text}`);
      li.dataset.role = m.role;
      return li;
    }));
  }

  newBtn.addEventListener("click", async () => {
    activeId = (await chats.createChat()).id;
    await render();
  });
  renameBtn.addEventListener("click", () => {
    renameInput.value = title.textContent;
    renameInput.hidden = false;
    renameInput.focus();
  });
  renameInput.addEventListener("keydown", async (/** @type {any} */ ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation(); // cancels the rename only, not the whole panel
      renameInput.hidden = true;
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const value = renameInput.value.trim();
      renameInput.hidden = true;
      // A blank title is refused here; the store would refuse it too.
      if (isTitle(value) && activeId) await chats.renameChat(activeId, value);
      await render();
    }
  });
  // Delete = click plus confirm, then an Undo that revives the soft-deleted chat.
  deleteBtn.addEventListener("click", () => {
    confirmRow.hidden = false;
  });
  confirmRow.addEventListener("click", async (/** @type {any} */ ev) => {
    const pal = ev.target?.dataset?.pal;
    if (pal !== "confirm-delete" && pal !== "cancel-delete") return;
    confirmRow.hidden = true;
    if (pal === "cancel-delete" || !activeId) return;
    await chats.deleteChat(activeId);
    deletedId = activeId;
    activeId = null;
    undoRow.hidden = false;
    await render();
  });
  undoBtn.addEventListener("click", async () => {
    if (!deletedId) return;
    activeId = (await chats.reviveChat(deletedId)).id;
    deletedId = null;
    undoRow.hidden = true;
    await render();
  });
  return { root, bubble, panel };
}

// Browser self-mount. The chat store is optional: when the db is locked by another tab the bubble still
// shows, with chats unavailable.
async function selfMount() {
  /** @type {any} */
  let chats = null;
  try {
    // The page-wide shared open: other modules on the page reuse this lock and worker.
    const { sharedOpenDb } = await import("./db/client.js");
    const { createChatStore } = await import("./chat_store.js");
    const opened = await sharedOpenDb({
      locks: navigator.locks,
      createWorker: () => new Worker(new URL("./db/worker.js", import.meta.url), { type: "module" }),
    });
    if (opened.status === "ready") chats = createChatStore(/** @type {any} */ (opened.db));
  } catch {
    // no OPFS / Web Locks / workers: mount without chats
  }
  /** @type {any} */
  let storage = null;
  try {
    storage = window.localStorage;
  } catch {
    // storage access denied; position falls back to the default corner
  }
  await mountPalBubble({ doc: document, win: window, storage, chats });
}

if (typeof document !== "undefined" && typeof window !== "undefined") selfMount();
