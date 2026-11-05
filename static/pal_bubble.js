// @ts-check
// Pal chat bubble (MEM-099, ADR 0064 amendment 2026-11-03): a draggable button on every screen that opens
// a panel of on-device chats (chat_store.js). Self-mounts in the browser; importing it in node is inert.
import { isTitle, MAX_TITLE_CHARS } from "./chat_store.js";
import { getActor } from "./copilot_bridge.js";
import { messageNodes, typingNode, createComposer } from "./pal_chat.js";

const POS_KEY = "memripal.palBubble.pos";
const STYLE_HREF = "/static/pal_bubble.css";
const FACE_SRC = "/static/assets/pal-still.svg";
// tour.js keeps body data-tour-target = the open step's target selector (ADR 0072); the bubble is inert
// while the tour is open unless that step targets it.
const TOUR_SELF = ".pal-bubble";
const SIZE = 56; // fallback before layout; pal_bubble.css .pal-bubble
const MARGIN = 8;
const STEP = 16; // arrow-key move, px
const DRAG_START = 4; // px of travel before a press becomes a drag (so a tap still opens)
const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_ATTRS = {
  viewBox: "0 0 24 24",
  width: "18",
  height: "18",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
  "aria-hidden": "true",
  focusable: "false",
};
const ICON_MENU = "M4 6h16M4 12h16M4 18h16";
const ICON_PLUS = "M12 5v14M5 12h14";
const ICON_PENCIL = "M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4";
const ICON_TRASH = "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6";

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

/**
 * act(text) runs first (MEM-132): a string answer is the Pal message and reply is skipped; null falls through.
 * @param {{doc: any, win: any, storage: any, chats: any,
 *   reply?: (text: string, history: {role: string, text: string}[]) => Promise<string>,
 *   act?: (text: string) => Promise<string | null> | string | null}} deps
 */
export async function mountPalBubble({ doc, win, storage, chats, reply, act }) {
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
  const bubble = make("button", "bubble");
  bubble.className = "pal-bubble";
  bubble.setAttribute("aria-label", "Open Pal chats");
  bubble.setAttribute("aria-expanded", "false");
  // Decorative: the aria-label already names Pal. pal_bubble.css crops it to the head.
  const face = make("img", "face");
  face.className = "pal-bubble-face";
  face.src = FACE_SRC;
  face.alt = "";
  bubble.append(face);
  const blocked = () => {
    const t = doc.body.dataset?.tourTarget;
    return t !== undefined && t !== TOUR_SELF;
  };
  const syncDisabled = () => {
    if (blocked()) bubble.setAttribute("aria-disabled", "true");
    else bubble.removeAttribute("aria-disabled");
  };
  const panel = make("section", "panel");
  panel.className = "pal-panel";
  panel.setAttribute("aria-label", "Pal chats");
  panel.hidden = true;
  /** Labelled icon-only button (MEM-115): the aria-label carries the name, the svg is decorative. */
  const iconButton = (/** @type {string} */ pal, /** @type {string} */ label, /** @type {string} */ d) => {
    const b = make("button", pal);
    b.className = "pal-icon-btn";
    b.setAttribute("aria-label", label);
    b.setAttribute("title", label);
    const svg = doc.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries(ICON_ATTRS)) svg.setAttribute(k, v);
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
    b.append(svg);
    return b;
  };
  // Header (MEM-115): sidenav toggle | active title as plain text | new-chat icon. No text-button row.
  const header = make("div", "header");
  header.className = "pal-header";
  const sidenavToggle = iconButton("sidenav-toggle", "Chats", ICON_MENU);
  sidenavToggle.setAttribute("aria-expanded", "false");
  const title = make("h2", "title");
  const renameInput = make("input", "rename-input");
  renameInput.maxLength = MAX_TITLE_CHARS;
  renameInput.setAttribute("aria-label", "Chat title");
  renameInput.hidden = true;
  const newBtn = iconButton("new", "New chat", ICON_PLUS);
  header.append(sidenavToggle, title, renameInput, newBtn);
  // Created once; render() re-appends them into the active row so exactly one of each exists.
  const renameBtn = iconButton("rename", "Rename chat", ICON_PENCIL);
  const deleteBtn = iconButton("delete", "Delete chat", ICON_TRASH);
  const confirmRow = make("div", "confirm-row", "Delete this chat? ");
  confirmRow.className = "pal-confirm-row";
  confirmRow.append(make("button", "confirm-delete", "Delete"), make("button", "cancel-delete", "Cancel"));
  confirmRow.hidden = true;
  const undoRow = make("div", "undo-row", "Chat deleted. ");
  undoRow.className = "pal-undo-row";
  const undoBtn = make("button", "undo", "Undo");
  undoRow.append(undoBtn);
  undoRow.hidden = true;
  // Never the hidden attribute: CSS shows it as a drawer (narrow) or a column (>= 720px).
  const sidenav = make("nav", "sidenav");
  sidenav.className = "pal-sidenav";
  sidenav.setAttribute("aria-label", "Chat history");
  const sidenavLabel = make("p", "", "Chats");
  sidenavLabel.className = "pal-sidenav-label";
  const list = make("ul", "chats");
  sidenav.append(sidenavLabel, list, confirmRow);
  const setDrawer = (/** @type {boolean} */ open) => {
    panel.classList.toggle("pal-sidenav-open", open);
    sidenavToggle.setAttribute("aria-expanded", String(open));
  };
  sidenavToggle.addEventListener("click", () => setDrawer(!panel.classList.contains("pal-sidenav-open")));
  const messages = make("ol", "messages");
  messages.className = "pal-messages";
  messages.setAttribute("aria-live", "polite");
  const errorNote = make("p", "chat-error", "Pal couldn't answer just now. Try again.");
  errorNote.className = "pal-chat-error";
  errorNote.setAttribute("role", "alert");
  errorNote.hidden = true;
  const composer = createComposer(doc, (/** @type {string} */ text) => sendMessage(text));
  panel.append(header, sidenav, messages, undoRow, errorNote, composer.form);
  root.append(bubble, panel);
  doc.body.append(root);

  /** @type {string | null} */
  let activeId = null;
  /** @type {string | null} */
  let deletedId = null;
  let typing = false;

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
  syncDisabled();
  if (win.MutationObserver) {
    new win.MutationObserver(syncDisabled).observe(doc.body, { attributes: true, attributeFilter: ["data-tour-target"] });
  }

  // --- drag: pointer events cover mouse and touch; a drag swallows the click that follows ---
  /** @type {{id: number, cx: number, cy: number, x: number, y: number} | null} */
  let press = null;
  let dragged = false;
  bubble.addEventListener("pointerdown", (/** @type {any} */ ev) => {
    if (ev.button !== 0 || blocked()) return;
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
    if (blocked()) return;
    if (dragged) {
      dragged = false;
      return;
    }
    setOpen(panel.hidden);
  });
  const ARROWS = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
  bubble.addEventListener("keydown", (/** @type {any} */ ev) => {
    if (blocked()) return;
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
      b.addEventListener("click", () => {
        activeId = c.id;
        setDrawer(false);
        render();
      });
      li.append(b);
      if (c.id === activeId) {
        b.className = "pal-chat-active";
        li.className = "pal-chat-row-active";
        li.append(renameBtn, deleteBtn);
      }
      return li;
    }));
    const msgs = active ? await chats.listMessages(active.id) : [];
    messages.replaceChildren(...messageNodes(doc, msgs));
    if (typing) messages.append(typingNode(doc));
    messages.scrollTop = messages.scrollHeight;
    composer.form.hidden = !chats;
  }

  /** @param {string} text */
  async function sendMessage(text) {
    if (!chats) return;
    if (!activeId) activeId = (await chats.createChat()).id;
    errorNote.hidden = true;
    const chatId = activeId;
    await chats.appendMessage(chatId, { role: "user", text });
    if (!reply && !act) {
      await render();
      return;
    }
    typing = true;
    await render();
    try {
      let answer = act ? await act(text) : null;
      if (answer == null && reply) {
        const history = (await chats.listMessages(chatId)).map((/** @type {any} */ m) => ({ role: m.role, text: m.text }));
        answer = await reply(text, history);
      }
      if (typeof answer === "string" && answer.trim()) await chats.appendMessage(chatId, { role: "assistant", text: answer.trim() });
    } catch {
      errorNote.hidden = false;
    } finally {
      typing = false;
      await render();
    }
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
  // The actor is read per message: wireApp may set it after the bubble mounts.
  // app.js already loaded these on the page; imported lazily so node tests of this module stay light.
  const [{ withApiBase }, { withPasscode }, { withMetaKey }, { createPalReply }] = await Promise.all([
    import("./api_base.js"),
    import("./flow.js"),
    import("./byok.js"),
    import("./pal_reply.js"),
  ]);
  const live = createPalReply(withMetaKey(withPasscode(withApiBase(fetch.bind(globalThis)), document), document));
  const reply = (/** @type {string} */ text, /** @type {{role: string, text: string}[]} */ history) =>
    live(text, toChatHistory(history));
  await mountPalBubble({ doc: document, win: window, storage, chats, reply, act: (t) => getActor()?.act(t) ?? null });
}

/**
 * The bubble's stored turns as POST /chat history (MEM-142): {role, content}, user/assistant only, minus
 * the just-sent message (the server appends it), capped to the route's last 40.
 * @param {{role: string, text: string}[]} history
 */
export function toChatHistory(history) {
  const turns = history.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string");
  if (turns.length && turns[turns.length - 1].role === "user") turns.pop();
  return turns.slice(-40).map((m) => ({ role: m.role, content: m.text }));
}

if (typeof document !== "undefined" && typeof window !== "undefined") selfMount();
