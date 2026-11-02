// @ts-check
// Recall end screen (MEM-033): the said-vs-palace list plus a "Mark got it" override on each missed
// point. The override rewrites the saved run in place: same id, timestamp and transcript.

import { renderSaidVsPalace } from "./rehearsals.js";

/** @typedef {import("./rehearsals.js").Rehearsal} Rehearsal */

/**
 * Copy of `record` with point `i` overruled to got; every other point is kept as is.
 * @param {Rehearsal} record
 * @param {number} i
 * @returns {Rehearsal}
 */
export function markPointGot(record, i) {
  const marked = { ...record, points: record.points.map((p, j) => (j === i ? { ...p, got: true, override: true, span: null } : p)) };
  // Route runs: hits keys are station ids in route order, the same order as points (routeRun), so point i
  // is key i. Station ids are non-integer strings, so insertion order survives JSON round-trips.
  const id = record.hits ? Object.keys(record.hits)[i] : undefined;
  if (id !== undefined) marked.hits = { ...record.hits, [id]: true };
  return marked;
}

/**
 * Whether point `i` counts: got, and on a route run also a hit. A route point said out of order is got
 * but not a hit (MEM-080).
 * @param {Rehearsal} record
 * @param {number} i
 */
export function pointCounted(record, i) {
  if (!record.points[i].got) return false;
  const id = record.hits ? Object.keys(record.hits)[i] : undefined;
  return id === undefined || record.hits?.[id] === true;
}

/**
 * @param {Rehearsal} record
 * @param {any} doc
 * @param {(i: number) => void} onMark called with the point index of the clicked row
 */
export function renderEndScreen(record, doc, onMark) {
  const list = renderSaidVsPalace(record, doc);
  // Rows are in record.points order, so a row's index is its point's index.
  Array.from(list.children).forEach((row, i) => {
    if (pointCounted(record, i)) return;
    const button = doc.createElement("button");
    button.type = "button";
    button.dataset.action = "mark-got";
    button.textContent = "Mark got it";
    button.setAttribute("aria-label", `Mark got it: ${record.points[i].label}`);
    button.addEventListener("click", () => onMark(i));
    row.append(button);
  });
  return list;
}
