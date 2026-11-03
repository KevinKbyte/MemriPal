// @ts-check
// Route review (MEM-030, MEM-081): reorder by dragging a row's grip (or ArrowUp/ArrowDown/Home/End
// on it); remove only via Edit -> trash -> Remove, then an Undo snackbar. Split out of encode.js.
// Labels reach the page via textContent only; icons are built with createElementNS (CSP: no HTML).

/** @typedef {import("./encode.js").Locus} Locus */

/**
 * Route review state: moves, a drop is only pending until confirmed, Undo is a stack.
 * @param {Locus[]} loci never mutated
 */
export function createRouteReview(loci) {
  let order = [...loci];
  /** @type {number | null} */
  let pending = null;
  /** @type {Array<{index: number, locus: Locus}>} */
  const dropped = [];
  /** @param {number} i */
  const inRange = (i) => Number.isInteger(i) && i >= 0 && i < order.length;
  /** @param {number} from @param {number} to */
  const moveTo = (from, to) => {
    if (!inRange(from) || !inRange(to) || from === to) return false;
    const [locus] = order.splice(from, 1);
    order.splice(to, 0, locus);
    // The pending index would now point at a different locus.
    pending = null;
    return true;
  };
  return {
    order: () => [...order],
    moveTo,
    /**
     * @param {number} i
     * @param {number} delta -1 (up) or 1 (down)
     */
    move: (i, delta) => (delta === 1 || delta === -1) && moveTo(i, i + delta),
    /** @param {number} i */
    requestDrop(i) {
      pending = inRange(i) ? i : null;
    },
    pendingDrop: () => pending,
    cancelDrop() {
      pending = null;
    },
    confirmDrop() {
      if (pending === null) return false;
      const index = pending;
      dropped.push({ index, locus: order[index] });
      order = order.filter((_, k) => k !== index);
      pending = null;
      return true;
    },
    undo() {
      const last = dropped.pop();
      if (!last) return false;
      order = [...order.slice(0, last.index), last.locus, ...order.slice(last.index)];
      pending = null;
      return true;
    },
    canUndo: () => dropped.length > 0,
    /** The place the next Undo restores, for the snackbar text. */
    lastDropped: () => dropped.at(-1)?.locus ?? null,
  };
}

/**
 * Drop slot while dragging: how many of the other rows' vertical midpoints lie above the pointer.
 * @param {number[]} mids
 * @param {number} y clientY
 */
export function dropSlot(mids, y) {
  return mids.filter((m) => m < y).length;
}

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {unknown} text
 */
export function textEl(doc, tag, text) {
  const e = doc.createElement(tag);
  e.textContent = text == null ? "" : String(text);
  return e;
}

/**
 * @param {Document} doc
 * @param {string} action data-action, the stable hook tests and styles use
 * @param {string} text
 * @param {string} label accessible name naming the locus
 * @param {(() => void) | null} onClick
 * @param {string[]} [classes]
 */
function actionButton(doc, action, text, label, onClick, classes = []) {
  const b = /** @type {HTMLButtonElement} */ (doc.createElement("button"));
  b.type = "button";
  b.dataset.action = action;
  b.textContent = text;
  b.setAttribute("aria-label", label);
  b.classList.add("btn", ...classes);
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Decorative grip (six dots) or trash icon; the button carries the accessible name.
 * @param {Document} doc
 * @param {"grip" | "trash"} name
 */
function icon(doc, name) {
  /** @param {string} tag @param {Record<string, string | number>} attrs */
  const make = (tag, attrs) => {
    const e = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  const grip = name === "grip";
  const svg = make("svg", { viewBox: grip ? "0 0 20 20" : "0 0 24 24", "aria-hidden": "true", focusable: "false" });
  if (grip) {
    for (const cy of [4, 10, 16]) svg.append(make("circle", { cx: 7, cy, r: 1.6 }), make("circle", { cx: 13, cy, r: 1.6 }));
  } else {
    svg.append(make("path", { d: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" }));
  }
  return svg;
}

/** @param {Element} list */
const rowsOf = (list) => /** @type {HTMLElement[]} */ (Array.from(list.children).filter((c) => c.tagName === "LI"));

/**
 * Put `li` at `slot` among the other rows by moving those siblings, never `li` itself: moving the
 * dragged node would detach its grip, and a browser drops pointer capture on a detached node.
 * @param {Element} list
 * @param {HTMLElement} li
 * @param {number} slot
 */
function placeAt(list, li, slot) {
  const all = rowsOf(list);
  const at = all.indexOf(li);
  const others = all.filter((r) => r !== li);
  if (slot < at) {
    const after = all[at + 1] ?? null;
    for (let k = slot; k < at; k++) list.insertBefore(others[k], after);
  } else {
    for (let k = at; k < slot; k++) list.insertBefore(others[k], li);
  }
}

/**
 * Show the review list; resolves with the reviewed order once Generate is clicked. Page-root
 * handlers are assigned (not added), so a later run's review never inherits an earlier one's
 * listeners (Load demo is disabled while a run is pending, so two reviews never overlap).
 * @param {Locus[]} loci
 * @param {Document} doc
 * @returns {Promise<Locus[]>}
 */
export function reviewRoute(loci, doc) {
  const panel = doc.getElementById("route-review");
  const list = doc.getElementById("route");
  const generate = doc.getElementById("generate");
  // Optional: older pages (and some test pages) lack these.
  const undo = doc.getElementById("route-undo");
  const edit = doc.getElementById("route-edit");
  const live = doc.getElementById("route-live");
  const toast = doc.getElementById("route-toast");
  const toastText = doc.getElementById("route-toast-text");
  const review = createRouteReview(loci);
  if (!panel || !list || !generate) return Promise.resolve(review.order());
  let editing = false;
  /** Live drag: the lifted row and its index when lifted. Rows are never re-rendered mid-drag. */
  /** @type {{li: HTMLElement, from: number} | null} */
  let drag = null;

  /** @param {Locus | null} [focus] whose grip takes focus after the rebuild */
  const render = (focus = null) => {
    drag = null;
    list.classList.remove("is-dragging");
    const all = review.order();
    /** @type {HTMLButtonElement | null} */
    let target = null;
    list.replaceChildren(
      ...all.map((locus, i) => {
        const li = /** @type {HTMLElement} */ (doc.createElement("li"));
        li.classList.add("route-row");
        /** @param {() => unknown} change */
        const act = (change) => () => {
          change();
          render();
        };
        const grip = actionButton(doc, "drag", "", `Reorder ${locus.label}`, null, ["route-grip"]);
        grip.append(icon(doc, "grip"));
        if (focus === locus) target = grip;
        /** @param {boolean} commit */
        const end = (commit) => {
          if (!drag || drag.li !== li) return;
          if (commit) review.moveTo(drag.from, rowsOf(list).indexOf(li));
          render();
        };
        grip.addEventListener("keydown", (ev) => {
          if (ev.key === "Escape") {
            if (drag?.li === li) ev.preventDefault();
            end(false);
            return;
          }
          const to = new Map([["ArrowUp", i - 1], ["ArrowDown", i + 1], ["Home", 0], ["End", all.length - 1]]).get(ev.key);
          if (to === undefined || drag) return;
          ev.preventDefault();
          if (!review.moveTo(i, to)) return;
          render(locus);
          if (live) live.textContent = `${locus.label} moved to position ${to + 1} of ${all.length}`;
        });
        grip.addEventListener("pointerdown", (ev) => {
          if (drag || ev.button !== 0) return;
          ev.preventDefault();
          drag = { li, from: i };
          grip.setPointerCapture(ev.pointerId);
          li.classList.add("dragging");
          list.classList.add("is-dragging");
        });
        grip.addEventListener("pointermove", (ev) => {
          if (drag?.li !== li) return;
          const mids = rowsOf(list)
            .filter((r) => r !== li)
            .map((r) => {
              const box = r.getBoundingClientRect();
              return box.top + box.height / 2;
            });
          placeAt(list, li, dropSlot(mids, ev.clientY));
        });
        grip.addEventListener("pointerup", () => end(true));
        grip.addEventListener("pointercancel", () => end(false));
        const label = textEl(doc, "span", locus.label);
        label.classList.add("route-label");
        li.append(grip, label);
        if (editing && review.pendingDrop() === i) {
          li.classList.add("confirming");
          const ask = textEl(doc, "span", "Remove this place?");
          ask.classList.add("route-ask");
          li.append(
            ask,
            actionButton(doc, "confirm-drop", "Remove", `Remove ${locus.label}`, act(() => review.confirmDrop()), ["route-confirm"]),
            actionButton(doc, "cancel-drop", "Keep", `Keep ${locus.label}`, act(() => review.cancelDrop())),
          );
        } else if (editing) {
          const trash = actionButton(doc, "drop", "", `Remove ${locus.label}`, act(() => review.requestDrop(i)), ["route-trash"]);
          trash.append(icon(doc, "trash"));
          li.append(trash);
        }
        return li;
      }),
    );
    // Focused only once in the page: a detached button cannot take focus. (Cast: tsc narrows a
    // let assigned inside the map callback back to null.)
    /** @type {HTMLButtonElement | null} */ (target)?.focus();
    const canUndo = review.canUndo();
    if (toast) toast.hidden = !canUndo;
    if (undo) undo.hidden = !canUndo;
    if (toastText) toastText.textContent = canUndo ? `Removed ${review.lastDropped()?.label ?? ""}` : "";
  };

  /** @param {boolean} on */
  const setEditing = (on) => {
    editing = on;
    if (!on) review.cancelDrop();
    if (edit) {
      edit.setAttribute("aria-pressed", String(on));
      edit.textContent = on ? "Done" : "Edit";
    }
  };
  if (edit) {
    edit.onclick = () => {
      setEditing(!editing);
      render();
    };
  }
  if (undo) {
    undo.onclick = () => {
      review.undo();
      render();
    };
  }
  setEditing(false);
  render();
  panel.hidden = false;
  return new Promise((resolve) => {
    generate.onclick = () => {
      generate.onclick = null;
      panel.hidden = true;
      if (toast) toast.hidden = true;
      if (undo) undo.hidden = true;
      resolve(review.order());
    };
  });
}
