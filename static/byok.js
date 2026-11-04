// @ts-check
// Spend cap notice (MEM-121): when the server's Meta spend cap is reached it says how it is coping in
// X-Memripal-Spend-Cap; the page names the cap in a dismissible top toast. MEM-095 part C (bring your own
// key) builds on this module: its key prompt only ever shows once this notice has fired.

export const SPEND_CAP_HEADER = "X-Memripal-Spend-Cap";

const CAP = "Free demo credit is used up (Meta spend cap reached)";

// Allowlist: the header value is never rendered itself, only mapped to one of these messages.
export const SPEND_CAP_MESSAGES = Object.freeze({
  saved: `${CAP}: showing saved results.`,
  backup: `${CAP}: chat continues on the backup provider.`,
  capped: `${CAP}: live AI steps are paused. Load demo and the saved replay still work.`,
});

/** @type {WeakSet<object>} documents whose toast was dismissed this page session */
const dismissed = new WeakSet();
/** @type {WeakMap<object, {toast: any, text: any}>} each document's toast, once built */
const toasts = new WeakMap();

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
 * Shows (creating on first use) the spend cap toast; a dismissed toast stays hidden for the page session.
 * Built here rather than in index.html so the notice needs no markup change.
 * @param {any} doc
 * @param {unknown} state
 */
export function showSpendCap(doc, state) {
  const message = spendCapMessage(state);
  if (message === null || dismissed.has(doc) || !doc.body) return;
  let built = toasts.get(doc);
  if (!built) {
    const toast = doc.createElement("div");
    toast.id = "spend-cap";
    toast.classList.add("notice", "toast");
    toast.setAttribute("role", "status");
    const text = doc.createElement("span");
    const button = doc.createElement("button");
    button.classList.add("btn");
    button.type = "button";
    button.textContent = "Dismiss";
    button.addEventListener("click", () => {
      dismissed.add(doc);
      toast.hidden = true;
    });
    toast.append(text, button);
    doc.body.prepend(toast);
    built = { toast, text };
    toasts.set(doc, built);
  }
  built.text.textContent = message;
  built.toast.hidden = false;
}
