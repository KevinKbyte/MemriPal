// @ts-check
// Map-first shell bottom tab bar (MEM-072): four a.tab links switch the four #tab-<name> panels.

export const TABS = ["routes", "landmarks", "recall", "settings"];

/**
 * Show panel #tab-<name>, hide the other three, and mark only its a.tab current. Unknown name: no-op.
 * @param {string | undefined} name
 * @param {any} [doc]
 */
export function showTab(name, doc = globalThis.document) {
  if (!doc || !TABS.includes(String(name))) return;
  for (const n of TABS) {
    const panel = doc.getElementById(`tab-${n}`);
    if (panel) panel.hidden = n !== name;
  }
  // The test fake DOM lacks querySelectorAll; the panels alone still switch there.
  const tabs = typeof doc.querySelectorAll === "function" ? doc.querySelectorAll("a.tab") : [];
  for (const a of tabs) {
    if (a.getAttribute("href") === `#${name}`) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

/** @param {unknown} hash @returns {string | null} the tab a location hash names, or null. */
function tabFromHash(hash) {
  const name = String(hash ?? "").replace(/^#/, "");
  return TABS.includes(name) ? name : null;
}

/**
 * Wire tab clicks (delegated, so a click on the svg icon counts), the initial hash and hashchange.
 * @param {any} [doc]
 */
export function initTabbar(doc = globalThis.document) {
  if (!doc) return;
  showTab(tabFromHash(doc.location?.hash) ?? "routes", doc);
  const win = doc.defaultView ?? doc;
  win.addEventListener("hashchange", () => {
    const name = tabFromHash(doc.location?.hash);
    if (name) showTab(name, doc);
  });
  doc.addEventListener("click", (/** @type {any} */ ev) => {
    const name = tabFromHash(ev.target?.closest?.("a.tab")?.getAttribute("href"));
    if (!name) return;
    ev.preventDefault();
    showTab(name, doc);
  });
}
