// @ts-check
// Rehearsal history (MEM-033): one row per stored run with View and Delete (confirm, then Undo), the
// per-point hit rates, and a pane showing the viewed run's said-vs-palace from its stored record
// alone. Stored text is user/model text, so it is set via textContent only.

import { deleteRehearsalWithUndo, hitRates, renderSaidVsPalace } from "./rehearsals.js";

/** @typedef {import("./rehearsals.js").Rehearsal} Rehearsal */

/**
 * @param {{
 *   doc: Document,
 *   rehearsals: ReturnType<typeof import("./rehearsals.js").createRehearsalStore>,
 *   confirm: () => boolean | Promise<boolean>,
 *   palaceId: string,
 * }} deps
 * @returns {() => Promise<void>} re-renders the history from the store
 */
export function createHistory({ doc, rehearsals, confirm, palaceId }) {
  /** @param {string} id */
  const byId = (id) => doc.getElementById(id);
  /** @param {string} tag @param {string} text */
  const textEl = (tag, text) => {
    const e = doc.createElement(tag);
    e.textContent = text;
    return e;
  };
  /** @type {string | null} */
  let viewedId = null;

  /** @param {string} text @param {string} label @param {() => void} onClick */
  const button = (text, label, onClick) => {
    const b = /** @type {HTMLButtonElement} */ (doc.createElement("button"));
    b.type = "button";
    b.textContent = text;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", onClick);
    return b;
  };

  const showSection = () => {
    const section = byId("history");
    if (section) section.hidden = false;
  };
  // Created on the first failed read and only hidden again once a read succeeds.
  /** @type {HTMLElement | null} */
  let unavailable = null;

  // Never rejects: an unreadable store (IndexedDB failed to open) says so, and the page keeps working.
  const render = async () => {
    let runs;
    try {
      runs = await rehearsals.list(palaceId);
    } catch {
      byId("rehearsals")?.replaceChildren();
      byId("hit-rates")?.replaceChildren();
      byId("history-view")?.replaceChildren();
      if (!unavailable) {
        unavailable = textEl("p", "History unavailable");
        unavailable.setAttribute("role", "status");
        byId("history")?.prepend(unavailable);
      }
      unavailable.hidden = false;
      showSection();
      return;
    }
    if (unavailable) unavailable.hidden = true;
    byId("rehearsals")?.replaceChildren(...runs.map(runItem));
    byId("hit-rates")?.replaceChildren(
      ...hitRates(runs).map((h) => textEl("li", `${h.label}: ${h.hits}/${h.runs}${h.chronic ? " (chronic miss)" : ""}`)),
    );
    // Re-read from the store, so the pane follows an override and empties once its run is removed.
    const viewed = runs.find((r) => r.id === viewedId);
    byId("history-view")?.replaceChildren(...(viewed ? [renderSaidVsPalace(viewed, doc)] : []));
    // Never re-hidden: Undo after removing the last run must stay reachable.
    if (runs.length) showSection();
  };

  /** @param {Rehearsal} run */
  const runItem = (run) => {
    const li = doc.createElement("li");
    const got = run.points.filter((p) => p.got || p.override).length;
    // Stored as UTC ISO; shown in the user's own locale and time zone.
    const when = new Date(run.timestamp).toLocaleString();
    const view = button("View", `View the rehearsal of ${when}`, () => {
      viewedId = run.id;
      void render();
    });
    const del = button("Delete", `Delete the rehearsal of ${when}`, () => void removeRun(run.id));
    del.dataset.action = "delete-rehearsal";
    li.append(textEl("span", `${when}: ${got}/${run.points.length} recalled `), view, del);
    return li;
  };

  /** @param {string} id */
  const removeRun = async (id) => {
    const undo = byId("rehearsal-undo");
    /** @param {() => Promise<void>} restore */
    const showUndo = (restore) => {
      if (!undo) return;
      undo.hidden = false;
      undo.onclick = async () => {
        undo.onclick = null;
        undo.hidden = true;
        await restore();
        await render();
      };
    };
    if (await deleteRehearsalWithUndo(id, { store: rehearsals, confirm, showUndo })) await render();
  };

  return render;
}
