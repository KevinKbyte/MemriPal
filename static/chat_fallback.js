// @ts-check
// Spark fallback notice (MEM-108): when the server answered a Spark call on Meta because the open-weights
// provider failed (X-Memripal-Chat-Fallback, MEM-107), say so in a dismissible top toast.

export const CHAT_FALLBACK_HEADER = "X-Memripal-Chat-Fallback";

// Allowlist: the header value is never rendered itself, only mapped to one of these labels.
export const CHAT_FALLBACK_LABELS = Object.freeze({ baseten: "Baseten", fireworks: "Fireworks", local: "the local server" });

/** @type {WeakSet<object>} documents whose toast was dismissed this page session */
const dismissed = new WeakSet();

/**
 * @param {unknown} provider
 * @returns {string | null}
 */
export function chatFallbackMessage(provider) {
  // Own-property check: "toString" and friends are not providers.
  if (typeof provider !== "string" || !Object.hasOwn(CHAT_FALLBACK_LABELS, provider)) return null;
  const label = CHAT_FALLBACK_LABELS[/** @type {keyof typeof CHAT_FALLBACK_LABELS} */ (provider)];
  return `Open-weights Spark on ${label} is unavailable; continuing on Meta's hosted model`;
}

/**
 * Wraps a fetch: resolves the same Response, calling onFallback(provider) for an allowlisted header value.
 * @param {(input: any, init?: any) => Promise<any>} fetchFn
 * @param {(provider: string) => void} onFallback
 */
export function withChatFallbackNotice(fetchFn, onFallback) {
  return async (/** @type {any} */ input, /** @type {any} */ init) => {
    const res = await fetchFn(input, init);
    const provider = res?.headers?.get?.(CHAT_FALLBACK_HEADER);
    if (chatFallbackMessage(provider) !== null) onFallback(provider);
    return res;
  };
}

/**
 * @param {{getElementById: (id: string) => any}} doc
 * @param {unknown} provider
 */
export function showChatFallback(doc, provider) {
  const message = chatFallbackMessage(provider);
  const toast = doc.getElementById("chat-fallback");
  const text = doc.getElementById("chat-fallback-text");
  if (message === null || !toast || !text || dismissed.has(doc)) return;
  text.textContent = message;
  toast.hidden = false;
}

/** @param {{getElementById: (id: string) => any}} doc */
export function wireChatFallback(doc) {
  doc.getElementById("chat-fallback-dismiss")?.addEventListener("click", () => {
    dismissed.add(doc);
    const toast = doc.getElementById("chat-fallback");
    if (toast) toast.hidden = true;
  });
}
