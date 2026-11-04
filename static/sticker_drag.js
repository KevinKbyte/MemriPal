// @ts-check
// Sticker drag + snap (MEM-131, ADR 0077): a tap on a placed sticker never regenerates it. A press that moves past
// DRAG_SLOP_PX drags the sticker; the drop snaps it to the segmented object (locus box) under or nearest the drop
// point. Shared by the tour's dog house (tour.js) and the photo's sticker layer (sticker_board.js).

/** Pointer travel (CSS px) that turns a press into a drag; below it the press is a tap. */
export const DRAG_SLOP_PX = 6;

/** @typedef {{x1: number, y1: number, x2: number, y2: number}} Box */

/**
 * Distance from (x, y) to the box's edge; 0 inside or on it.
 * @param {number} x @param {number} y @param {Box} b
 */
export function boxDistance(x, y, b) {
  const dx = Math.max(b.x1 - x, 0, x - b.x2);
  const dy = Math.max(b.y1 - y, 0, y - b.y2);
  return Math.hypot(dx, dy);
}

/**
 * Index of the box a drop at (x, y) binds to: the smallest box containing the point (a nested object beats the
 * one around it), else the box with the nearest edge; ties keep the lower index. -1 for no usable box.
 * @param {number} x @param {number} y @param {Array<Box | null | undefined>} boxes
 */
export function nearestBox(x, y, boxes) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
  let best = -1;
  let bestDist = Infinity;
  let bestArea = Infinity;
  boxes.forEach((b, i) => {
    if (!b || ![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite)) return;
    const d = boxDistance(x, y, b);
    // Area only ranks boxes that contain the point; outside, the nearest edge alone decides.
    const area = d === 0 ? Math.abs((b.x2 - b.x1) * (b.y2 - b.y1)) : Infinity;
    if (d < bestDist || (d === bestDist && area < bestArea)) {
      best = i;
      bestDist = d;
      bestArea = area;
    }
  });
  return best;
}

/**
 * Wire press-drag-drop on one sticker element. onMove/onDrop get client coordinates and the pointer event; onTap
 * fires for a press that never left the slop. Click events are not used, so a tap can never reach a regenerate
 * handler by accident.
 * @param {any} el
 * @param {{ onMove?: (x: number, y: number, ev: any) => void, onDrop: (x: number, y: number, ev: any) => void,
 *   onTap?: () => void, onCancel?: () => void, slop?: number }} handlers
 */
export function wireDrag(el, { onMove, onDrop, onTap, onCancel, slop = DRAG_SLOP_PX }) {
  /** @type {{ id: unknown, x: number, y: number } | null} */
  let down = null;
  let dragging = false;
  const end = () => {
    down = null;
    dragging = false;
    el.classList.remove("is-dragging");
  };
  el.addEventListener("pointerdown", (/** @type {any} */ e) => {
    if (typeof e.button === "number" && e.button > 0) return; // right/middle button: not a drag
    down = { id: e.pointerId, x: e.clientX, y: e.clientY };
    dragging = false;
    el.setPointerCapture?.(e.pointerId);
  });
  el.addEventListener("pointermove", (/** @type {any} */ e) => {
    if (!down || e.pointerId !== down.id) return;
    if (!dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) < slop) return;
    dragging = true;
    el.classList.add("is-dragging");
    e.preventDefault?.();
    onMove?.(e.clientX, e.clientY, e);
  });
  el.addEventListener("pointerup", (/** @type {any} */ e) => {
    if (!down || e.pointerId !== down.id) return;
    const wasDrag = dragging;
    end();
    if (wasDrag) onDrop(e.clientX, e.clientY, e);
    else onTap?.();
  });
  el.addEventListener("pointercancel", () => {
    if (!down) return;
    end();
    onCancel?.();
  });
}
