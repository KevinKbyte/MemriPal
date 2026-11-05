// @ts-check
// Spend cap notice (MEM-121): when the server's Meta spend cap is reached it says how it is coping in
// X-Memripal-Spend-Cap; the page names the cap in a dismissible top toast.
// Bring your own key (MEM-122): only when that toast says "capped", it offers a key field. The
// key lives in this module's memory only (no web storage, IndexedDB or cookie), rides only in X-Memripal-Meta-Key
// on the 6 model routes, and is dropped on reload, on pagehide (bfcache), on "Forget key", at its limit and when
// Meta refuses it.

export const SPEND_CAP_HEADER = "X-Memripal-Spend-Cap";
export const KEY_HEADER = "X-Memripal-Meta-Key";
export const OUTCOME_HEADER = "X-Memripal-Byok";
// Same set as flow.js PASSCODE_ROUTES: the model routes, and nothing else ever sees the key.
export const KEY_ROUTES = new Set(["/loci", "/split", "/associate", "/scenes", "/recall/audio", "/chat"]);
const MAX_KEY_CHARS = 512;

const CAP = "Free demo credit is used up (Meta spend cap reached)";

// Allowlist: the header value is never rendered itself, only mapped to one of these messages.
export const SPEND_CAP_MESSAGES = Object.freeze({
  saved: `${CAP}: showing saved results.`,
  backup: `${CAP}: chat continues on the backup provider.`,
  capped: `${CAP}: live AI steps are paused. Load demo and the saved replay still work.`,
});

export const BYOK_COPY = Object.freeze({
  prompt:
    "Free demo credit is used up. To keep going, paste your own Meta API key. It stays in this tab only, is never saved, and stops at $5.",
  label: "Meta API key",
  submit: "Continue",
  chip: "Using your key ($5 limit)",
  forget: "Forget key",
  limit: "Your $5 limit is reached. Key forgotten.",
  invalid: "That doesn't look like a Meta API key.",
});

/** @param {string} model */
export function rejectedMessage(model) {
  return `Your key can't use ${model}`;
}

// Model ids the server names in "rejected:<model>"; anything else is not rendered.
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** @type {WeakSet<object>} documents whose toast was dismissed this page session */
const dismissed = new WeakSet();
/** @type {WeakMap<object, any>} each document's toast parts, once built */
const toasts = new WeakMap();
/** @type {WeakMap<object, string>} the key held for each document: memory only, gone on reload */
const keys = new WeakMap();
/** @type {WeakMap<object, any>} each document's "using your key" chip, once built */
const chips = new WeakMap();

/**
 * @param {unknown} state
 * @returns {string | null}
 */
export function spendCapMessage(state) {
  // Own-property check: "toString" and friends are not states.
  if (typeof state !== "string" || !Object.hasOwn(SPEND_CAP_MESSAGES, state)) return null;
  return SPEND_CAP_MESSAGES[/** @type {keyof typeof SPEND_CAP_MESSAGES} */ (state)];
}

/**
 * The server's rule (400 bad_meta_key otherwise): 1-512 printable ASCII chars, no whitespace.
 * @param {unknown} raw
 */
export function metaKeyOk(raw) {
  return typeof raw === "string" && raw.length > 0 && raw.length <= MAX_KEY_CHARS && /^[\x21-\x7e]+$/.test(raw);
}

/** @param {any} doc @returns {string | null} */
export function heldKey(doc) {
  return keys.get(doc) ?? null;
}

/**
 * Wraps a fetch: resolves the same Response, calling onCap(state) for an allowlisted header value.
 * @param {(input: any, init?: any) => Promise<any>} fetchFn
 * @param {(state: string) => void} onCap
 * @returns {any}
 */
export function withSpendCapNotice(fetchFn, onCap) {
  return async (/** @type {any} */ input, /** @type {any} */ init) => {
    const res = await fetchFn(input, init);
    const state = res?.headers?.get?.(SPEND_CAP_HEADER);
    if (spendCapMessage(state) !== null) onCap(state);
    return res;
  };
}

/**
 * Wraps a fetch: while a key is held, adds it as X-Memripal-Meta-Key on the model routes only, then acts on
 * the server's X-Memripal-Byok answer ("limit", "rejected:<model>", "invalid"); the Response passes through.
 * @param {(input: any, init?: any) => Promise<any>} fetchFn
 * @param {any} doc
 * @returns {any}
 */
export function withMetaKey(fetchFn, doc) {
  return async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const key = heldKey(doc);
    if (key === null || !KEY_ROUTES.has(String(url))) return fetchFn(url, init);
    const headers = new Headers(init.headers);
    headers.set(KEY_HEADER, key);
    const res = await fetchFn(url, { ...init, headers });
    const outcome = res?.headers?.get?.(OUTCOME_HEADER);
    if (outcome === "limit") {
      forgetKey(doc);
      showChip(doc, BYOK_COPY.limit, false);
    } else if (outcome === "invalid") {
      forgetKey(doc);
      showKeyPrompt(doc, BYOK_COPY.invalid);
    } else if (typeof outcome === "string" && outcome.startsWith("rejected:")) {
      const model = outcome.slice("rejected:".length);
      if (MODEL_ID.test(model)) {
        forgetKey(doc);
        showKeyPrompt(doc, rejectedMessage(model));
      }
    }
    return res;
  };
}

/** Drops the key and hides the chip. @param {any} doc */
export function forgetKey(doc) {
  keys.delete(doc);
  const chip = chips.get(doc);
  if (chip) chip.root.hidden = true;
}

/**
 * The back/forward cache keeps a page's memory, key included (security review, 2026-11-04): pagehide forgets the
 * key, hides the chip and empties the field; a pageshow restored from that cache (persisted) does the same, in
 * case pagehide never ran. A no-op without a window (node tests, workers).
 * @param {any} win
 * @param {any} doc
 */
export function forgetOnPageHide(win, doc) {
  if (!win || typeof win.addEventListener !== "function") return;
  const clear = () => {
    forgetKey(doc);
    const parts = toasts.get(doc);
    if (parts) parts.prompt.input.value = "";
  };
  win.addEventListener("pagehide", clear);
  win.addEventListener("pageshow", (/** @type {any} */ ev) => {
    if (ev?.persisted) clear();
  });
}

/**
 * @param {any} doc
 * @param {string} tag
 * @param {string} [text]
 */
function el(doc, tag, text) {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The key prompt inside the toast: copy, key field, Continue, an inline error. Not a <form> and not a password
 * field (security review, 2026-11-04): Chrome ignores autocomplete=off on a password field in a form and offers
 * to save it, so this is a plain text field masked in style.css (#byok-key), with no name, that Continue or
 * Enter reads.
 * @param {any} doc
 */
function buildPrompt(doc) {
  const form = el(doc, "div");
  form.id = "byok";
  form.hidden = true;
  form.setAttribute("role", "group");
  form.setAttribute("aria-label", BYOK_COPY.label);
  // A readable measure on desktop; [hidden] in style.css still wins over this display.
  Object.assign(form.style, {
    pointerEvents: "auto", flexBasis: "100%", maxWidth: "34rem", display: "grid", gap: "0.5rem",
  });
  const copy = el(doc, "p", BYOK_COPY.prompt);
  copy.style.margin = "0";
  const field = el(doc, "div");
  field.classList.add("field");
  const label = el(doc, "label", BYOK_COPY.label);
  label.setAttribute("for", "byok-key");
  const input = el(doc, "input");
  input.id = "byok-key";
  input.type = "text";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("aria-describedby", "byok-error");
  // Password managers that look past autocomplete=off: 1Password, LastPass, Bitwarden.
  input.setAttribute("data-1p-ignore", "");
  input.setAttribute("data-lpignore", "true");
  input.setAttribute("data-bwignore", "");
  const row = el(doc, "div");
  row.classList.add("btn-row");
  const submit = el(doc, "button", BYOK_COPY.submit);
  submit.type = "button";
  submit.classList.add("btn", "btn-primary");
  const error = el(doc, "p");
  error.id = "byok-error";
  error.setAttribute("role", "alert");
  error.style.margin = "0";
  error.hidden = true;
  field.append(label, input);
  row.append(submit);
  form.append(copy, field, row, error);
  const accept = () => {
    const key = String(input.value ?? "");
    // Cleared either way: the field never keeps a key on screen.
    input.value = "";
    if (!metaKeyOk(key)) {
      error.textContent = BYOK_COPY.invalid;
      error.hidden = false;
      return;
    }
    keys.set(doc, key);
    error.hidden = true;
    form.hidden = true;
    const parts = toasts.get(doc);
    if (parts) parts.toast.hidden = true;
    showChip(doc, BYOK_COPY.chip, true);
  };
  submit.addEventListener("click", accept);
  input.addEventListener("keydown", (/** @type {any} */ ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    accept();
  });
  return { form, input, error };
}

/**
 * Asking for a key: the toast's own line hides and its Dismiss, under the form, reads "Not now".
 * @param {any} parts
 * @param {boolean} asking
 */
function setAsking(parts, asking) {
  parts.text.hidden = asking;
  parts.prompt.form.hidden = !asking;
  parts.dismiss.textContent = asking ? "Not now" : "Dismiss";
}

/**
 * Shows (creating on first use) the spend cap toast; a dismissed toast stays hidden for the page session.
 * Built here rather than in index.html so the notice needs no markup change. For "capped" with no key held,
 * the toast becomes the key prompt (MEM-122); its Dismiss becomes "Not now".
 * @param {any} doc
 * @param {unknown} state
 */
export function showSpendCap(doc, state) {
  const message = spendCapMessage(state);
  if (message === null || dismissed.has(doc) || !doc.body) return;
  const parts = toastParts(doc);
  parts.text.textContent = message;
  const asking = state === "capped" && heldKey(doc) === null;
  setAsking(parts, asking);
  if (asking) parts.prompt.error.hidden = true;
  parts.toast.hidden = false;
}

/**
 * The key prompt again, with `error` (a refused or malformed key); shown even if the toast was dismissed,
 * since the visitor just acted on it.
 * @param {any} doc
 * @param {string} error
 */
export function showKeyPrompt(doc, error) {
  if (!doc.body) return;
  dismissed.delete(doc);
  const parts = toastParts(doc);
  parts.text.textContent = SPEND_CAP_MESSAGES.capped;
  setAsking(parts, true);
  parts.prompt.error.textContent = error;
  parts.prompt.error.hidden = false;
  parts.toast.hidden = false;
}

/** @param {any} doc */
function toastParts(doc) {
  let built = toasts.get(doc);
  if (built) return built;
  const toast = el(doc, "div");
  toast.id = "spend-cap";
  toast.classList.add("notice", "toast");
  toast.setAttribute("role", "status");
  // It can stay up for the whole session, so it never blocks the controls under it; only its controls are live.
  toast.style.pointerEvents = "none";
  toast.style.flexWrap = "wrap";
  const text = el(doc, "span");
  const button = el(doc, "button", "Dismiss");
  button.style.pointerEvents = "auto";
  button.classList.add("btn");
  button.type = "button";
  button.addEventListener("click", () => {
    dismissed.add(doc);
    toast.hidden = true;
  });
  const prompt = buildPrompt(doc);
  // After the form, so while asking it sits under Continue; beside the text otherwise.
  toast.append(text, prompt.form, button);
  doc.body.prepend(toast);
  built = { toast, text, prompt, dismiss: button };
  toasts.set(doc, built);
  return built;
}

/**
 * The small "using your key" chip (with Forget key), or a closing line once the key is gone.
 * @param {any} doc
 * @param {string} text
 * @param {boolean} withForget
 */
function showChip(doc, text, withForget) {
  let chip = chips.get(doc);
  if (!chip) {
    const root = el(doc, "div");
    root.id = "byok-chip";
    root.classList.add("notice");
    root.setAttribute("role", "status");
    Object.assign(root.style, {
      // Top, where the toast was: the bottom of the page holds the route's action buttons and the tab bar.
      position: "fixed", top: "calc(8px + env(safe-area-inset-top, 0px))", right: "16px", zIndex: "20",
      display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.25rem 0.375rem 0.25rem 0.75rem",
      maxWidth: "calc(100vw - 32px)", pointerEvents: "none", fontSize: "0.875rem",
    });
    const label = el(doc, "span");
    const forget = el(doc, "button", BYOK_COPY.forget);
    forget.type = "button";
    forget.classList.add("btn");
    forget.style.pointerEvents = "auto";
    forget.addEventListener("click", () => forgetKey(doc));
    root.append(label, forget);
    doc.body.append(root);
    chip = { root, label, forget };
    chips.set(doc, chip);
  }
  chip.label.textContent = text;
  // The closing line has nothing left to forget, so the button goes.
  chip.root.replaceChildren(...(withForget ? [chip.label, chip.forget] : [chip.label]));
  chip.root.hidden = false;
}
