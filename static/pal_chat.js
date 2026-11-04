// @ts-check
// Pal chat view (MEM-116): messenger-style bubbles, empty-state greeting, typing indicator and the bottom
// composer for the Pal panel (pal_bubble.js). DOM-only helpers; no innerHTML (text goes in via textContent).
import { MAX_MESSAGE_CHARS } from "./chat_store.js";

export const PAL_FACE = "/static/assets/pal-idle.svg";
export const GREETING = "Hi, I'm Pal! Ask me about your palace, a stop on your route, or what to practise next.";

/** @param {any} doc @param {string} tag @param {string} pal @param {string} [cls] @param {string} [text] */
function el(doc, tag, pal, cls, text) {
  const n = doc.createElement(tag);
  if (pal) n.dataset.pal = pal;
  if (cls) n.classList.add(...cls.split(" "));
  if (text !== undefined) n.textContent = text;
  return n;
}

/** @param {any} doc */
function face(doc) {
  const img = el(doc, "img", "avatar", "pal-avatar");
  img.src = PAL_FACE;
  img.alt = "";
  return img;
}

/** Local "h:mm AM" for a valid ISO string, else "". @param {unknown} iso */
export function timeLabel(iso) {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * One <li> per message (user right, Pal left with face, time under the text), or the greeting when empty.
 * @param {any} doc @param {{role: string, text: string, created_at?: string}[]} msgs
 */
export function messageNodes(doc, msgs) {
  if (!msgs.length) {
    const li = el(doc, "li", "empty", "pal-empty");
    const img = face(doc);
    img.classList.add("pal-empty-face");
    li.append(img, el(doc, "p", "", "pal-empty-text", GREETING));
    return [li];
  }
  return msgs.map((m) => {
    const mine = m.role === "user";
    const li = el(doc, "li", "message", `pal-msg ${mine ? "pal-msg--user" : "pal-msg--pal"}`);
    li.dataset.role = m.role;
    const bubble = el(doc, "div", "", "pal-msg-bubble");
    bubble.append(el(doc, "p", "", "pal-msg-text", m.text));
    const label = timeLabel(m.created_at);
    if (label) {
      const time = el(doc, "time", "", "pal-msg-time", label);
      time.setAttribute("datetime", /** @type {string} */ (m.created_at));
      bubble.append(time);
    }
    if (!mine) li.append(face(doc));
    li.append(bubble);
    return li;
  });
}

/** The three-dot "Pal is typing" row. @param {any} doc */
export function typingNode(doc) {
  const li = el(doc, "li", "typing", "pal-msg pal-msg--pal pal-typing");
  li.setAttribute("aria-label", "Pal is typing");
  const bubble = el(doc, "div", "", "pal-msg-bubble");
  for (let i = 0; i < 3; i++) bubble.append(el(doc, "span", "", "pal-dot"));
  li.append(face(doc), bubble);
  return li;
}

/**
 * Bottom composer: auto-growing textarea + send button. Enter sends, Shift+Enter is a newline, blank never
 * sends. onSend gets the trimmed text; the box clears before it runs.
 * @param {any} doc @param {(text: string) => unknown} onSend
 */
export function createComposer(doc, onSend) {
  const form = el(doc, "div", "composer", "pal-composer");
  const input = el(doc, "textarea", "composer-input", "pal-composer-input");
  input.rows = 1;
  input.maxLength = MAX_MESSAGE_CHARS;
  input.placeholder = "Message Pal";
  input.setAttribute("aria-label", "Message Pal");
  const send = el(doc, "button", "send", "pal-send");
  send.type = "button";
  send.setAttribute("aria-label", "Send");
  send.textContent = "\u27a4";
  send.disabled = true;
  const sync = () => {
    send.disabled = !String(input.value ?? "").trim();
    if (input.style) {
      input.style.height = "auto";
      if (input.scrollHeight) input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    }
  };
  const submit = () => {
    const text = String(input.value ?? "").trim();
    if (!text) return;
    input.value = "";
    sync();
    onSend(text);
  };
  input.addEventListener("input", sync);
  input.addEventListener("keydown", (/** @type {any} */ ev) => {
    if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return;
    ev.preventDefault();
    submit();
  });
  send.addEventListener("click", submit);
  form.append(input, send);
  return { form, input, send };
}
