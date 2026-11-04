// @ts-check
// Step 3 of Pal's tour: the dog-house figure (MEM-109) and its emoji stickers (MEM-117). Since MEM-131 (ADR 0077)
// a tap, Enter or Space only selects a sticker; a drag or an arrow key swaps it with another spot, "New sticker"
// (#tour-roll) re-rolls the selection (all when none) and "Undo" (#tour-roll-undo) reverts the latest change.
import { rollAll, rollOne } from "./stickers.js";
import { nearestBox, wireDrag } from "./sticker_drag.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const HOUSE_W = 320;
const HOUSE_H = 200;
const PIN_R = 9;
const LABEL_WRAP = 10; // labels longer than this many characters break onto one line per word
const LABEL_LEAD = 11;
const STICKER_R = 13; // badge radius; also the clamp margin that keeps a corner sticker inside the viewBox
const STICKER_BIG = 18;
const STICKER_SMALL = 11;
// Parts after the first overlap it, lower right then lower left, so 2-3 emoji read as one merged picture.
const STICKER_OFFSETS = [[0, 0], [8, 7], [-8, 7]];
const ROLL_MS = 300;
const ARROW_STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** @typedef {import("./stickers.js").Composite} Composite */

/** @param {any} doc @param {string} tag @param {Record<string, string | number>} attrs @param {string} [cls] */
function svgEl(doc, tag, attrs, cls) {
  const e = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (cls) e.setAttribute("class", cls);
  return e;
}

/**
 * Pal's dog house drawn like the v6 loci overlay (docs/design/v6/app.js lociOverlay): outline boxes, a dotted
 * route through the box centres, numbered pins at each box's top-left.
 * @param {any} doc @param {{ spot: string, box: number[] }[]} spots
 */
function houseFig(doc, spots) {
  const svg = svgEl(doc, "svg", {
    viewBox: `0 0 ${HOUSE_W} ${HOUSE_H}`, role: "img",
    "aria-label": `Pal's dog house split into ${spots.length} numbered spots: `
      + spots.map((s, i) => `${i + 1} ${s.spot}`).join(", "),
  });
  // The house itself: roof, walls, door, ground.
  svg.appendChild(svgEl(doc, "path",
    { d: "M16 80 L160 10 L304 80 M32 80 V180 H288 V80 M140 180 V150 A20 20 0 0 1 180 150 V180 M8 180 H312" },
    "h-shape"));
  svg.appendChild(svgEl(doc, "polyline",
    { points: spots.map(({ box: b }) => `${b[0] + b[2] / 2},${b[1] + b[3] / 2}`).join(" ") }, "route-line"));
  // All outlines first, then labels, then pins, so a later box never paints over an earlier pin.
  for (const { box: b } of spots) {
    const r = { x: b[0], y: b[1], width: b[2], height: b[3], rx: 6 };
    svg.appendChild(svgEl(doc, "rect", r, "o-under"));
    svg.appendChild(svgEl(doc, "rect", r, "o-line"));
  }
  for (const { spot, box: b } of spots) {
    const words = spot.length > LABEL_WRAP ? spot.split(" ") : [spot];
    const cx = b[0] + b[2] / 2;
    const t = svgEl(doc, "text",
      { x: cx, y: b[1] + b[3] / 2 - ((words.length - 1) * LABEL_LEAD) / 2 + 3.5, "text-anchor": "middle" }, "o-label");
    words.forEach((w, n) => {
      const line = svgEl(doc, "tspan", { x: cx, dy: n ? LABEL_LEAD : 0 });
      line.textContent = w;
      t.appendChild(line);
    });
    svg.appendChild(t);
  }
  spots.forEach(({ box: b }, i) => {
    const cx = Math.max(PIN_R + 1, b[0]);
    const cy = Math.max(PIN_R + 1, b[1]);
    const g = svgEl(doc, "g", {}, "pin");
    g.appendChild(svgEl(doc, "circle", { cx, cy, r: PIN_R }));
    const n = svgEl(doc, "text", { x: cx, y: cy + 3.8, "text-anchor": "middle" });
    n.textContent = String(i + 1);
    g.appendChild(n);
    svg.appendChild(g);
  });
  return svg;
}

/**
 * A sticker's anchor: its box's top-right corner (pins hold the top-left), clamped so the badge stays inside.
 * @param {number[]} b
 */
function anchorOf(b) {
  return [
    Math.min(Math.max(b[0] + b[2], STICKER_R), HOUSE_W - STICKER_R),
    Math.min(Math.max(b[1], STICKER_R), HOUSE_H - STICKER_R),
  ];
}

/**
 * Wire step 3's stickers. Rolls are kept while the page is open so Next/Back shows the same pictures; reset()
 * (a replay) rolls fresh and forgets the selection and the undo history.
 * @param {any} doc @param {any} win @param {any} roll #tour-roll @param {any} undo #tour-roll-undo
 */
export function wireHouse(doc, win, roll, undo) {
  /** @type {Composite[] | null} */
  let stickers = null;
  /** @type {Composite[][]} */
  const history = [];
  let selected = -1;
  /** @type {{ spot: string, box: number[] }[]} */
  let spots = [];
  /** @type {any} */
  let svg = null;
  // groups/rows point at the nodes of the step currently drawn, so a change repaints in place and keeps focus.
  /** @type {any[]} */
  let groups = [];
  /** @type {{ icon: any, item: any, kw: any }[]} */
  let rows = [];
  /** @type {any[]} */
  const rollTimers = [];
  // A browser fires click after the pointerup that ends a drag; that click must not toggle the selection.
  let swallowClick = false;

  /** @param {string} tag @param {string} [cls] @param {string} [text] */
  function el(tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  /** @param {number} i */
  function place(i) {
    const [x, y] = anchorOf(spots[i].box);
    groups[i]?.setAttribute("transform", `translate(${x} ${y})`);
  }

  /** @param {number} i */
  function paint(i) {
    const s = /** @type {Composite[]} */ (stickers)[i];
    // compose() yields 1..3 parts, one per keyword, so every part has an offset.
    const parts = s.parts.map((p, n) => {
      const [dx, dy] = STICKER_OFFSETS[n];
      const t = svgEl(doc, "text", {
        x: dx, y: dy, "font-size": n ? STICKER_SMALL : STICKER_BIG,
        "text-anchor": "middle", "dominant-baseline": "central",
      });
      t.textContent = p;
      return t;
    });
    groups[i]?.replaceChildren(svgEl(doc, "circle", { r: STICKER_R }), ...parts);
    if (rows[i]) {
      rows[i].icon.textContent = s.parts.join("");
      rows[i].item.textContent = s.text;
      rows[i].kw.textContent = s.keywords.join(" + ");
    }
  }

  /** @param {number} i -1 clears the selection */
  function select(i) {
    selected = i;
    groups.forEach((g, n) => {
      g.classList.toggle("is-selected", n === i);
      g.setAttribute("aria-pressed", String(n === i));
    });
  }

  function syncUndo() {
    undo.hidden = !svg || !history.length;
    // Undo hides itself once the history is empty; keep keyboard focus inside the card.
    if (undo.hidden && doc.activeElement === undo) roll.focus();
  }

  /** Swap loci i and j (sticker, fig row) as one undoable move; the moved sticker stays selected. @param {number} i @param {number} j */
  function swap(i, j) {
    const s = /** @type {Composite[]} */ (stickers);
    history.push(s);
    stickers = s.map((c, n) => (n === i ? s[j] : n === j ? s[i] : c));
    paint(i);
    paint(j);
    select(j);
    syncUndo();
  }

  /** @param {number} clientX @param {number} clientY */
  function toViewBox(clientX, clientY) {
    // getBoundingClientRect, not getScreenCTM: the svg keeps the viewBox aspect, so the rect maps it linearly.
    const r = svg.getBoundingClientRect();
    return [((clientX - r.left) * HOUSE_W) / r.width, ((clientY - r.top) * HOUSE_H) / r.height];
  }

  /** @param {number} i */
  function stickerGroup(i) {
    const g = svgEl(doc, "g",
      { role: "button", tabindex: 0, "aria-pressed": String(i === selected), "aria-label": `Sticker on ${spots[i].spot}` },
      "tour-sticker" + (i === selected ? " is-selected" : ""));
    g.addEventListener("pointerdown", () => { swallowClick = false; });
    wireDrag(g, {
      onMove(cx, cy) {
        const [x, y] = toViewBox(cx, cy);
        g.setAttribute("transform", `translate(${x} ${y})`);
      },
      onDrop(cx, cy) {
        swallowClick = true;
        const [x, y] = toViewBox(cx, cy);
        place(i);
        const j = nearestBox(x, y, spots.map(({ box: b }) => ({ x1: b[0], y1: b[1], x2: b[0] + b[2], y2: b[1] + b[3] })));
        if (j >= 0 && j !== i) swap(i, j);
      },
      onCancel: () => place(i),
    });
    g.addEventListener("click", () => {
      if (swallowClick) { swallowClick = false; return; }
      select(selected === i ? -1 : i);
    });
    g.addEventListener("keydown", (/** @type {any} */ e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); // Space would otherwise scroll the page
        select(selected === i ? -1 : i);
        return;
      }
      const step = /** @type {Record<string, number>} */ (ARROW_STEP)[e.key];
      if (!step) return;
      e.preventDefault();
      const j = i + step;
      if (j < 0 || j >= groups.length) return;
      swap(i, j);
      groups[j].focus();
    });
    return g;
  }

  /** @param {number[]} idx */
  function reroll(idx) {
    let rolled = /** @type {Composite[]} */ (stickers);
    history.push(rolled);
    for (const i of idx) rolled = rollOne(rolled, i);
    stickers = rolled;
    for (const i of idx) {
      const g = groups[i];
      paint(i);
      // Re-adding a class already present does not restart its CSS animation; the layout read between remove
      // and add flushes style so a mid-roll tap spins again (ADR 0067).
      g.classList.remove("is-rolling");
      g.getBoundingClientRect();
      g.classList.add("is-rolling");
      win.clearTimeout(rollTimers[i]);
      rollTimers[i] = win.setTimeout(() => g.classList.remove("is-rolling"), ROLL_MS);
    }
    syncUndo();
  }

  // Both buttons are visible only on the house step, so groups always belong to the drawn house.
  roll.addEventListener("click", () => reroll(selected >= 0 ? [selected] : groups.map((_, n) => n)));
  undo.addEventListener("click", () => {
    const prev = history.pop();
    if (!prev) return;
    stickers = prev;
    groups.forEach((_, n) => paint(n));
    syncUndo();
  });

  return {
    /**
     * Draw the house step: its svg (null when the shell has no #tour-house) and one fig row per spot.
     * Math.random is read inside compose at call time, so tests can mock it.
     * @param {{ house: { spot: string, box: number[] }[], fig: { spot: string, item: string }[] }} step
     * @param {boolean} withSvg
     */
    draw(step, withSvg) {
      stickers ??= rollAll(step.fig.map((r) => r.item));
      spots = step.house;
      svg = withSvg ? houseFig(doc, spots) : null;
      groups = svg ? spots.map((_, n) => stickerGroup(n)) : [];
      if (svg) svg.append(...groups);
      rows = step.fig.map(() => ({ icon: el("span", "fig-icon"), item: el("span", "fig-item"), kw: el("span", "tour-kw") }));
      const lis = step.fig.map((r, n) => {
        const li = el("li", "fig-row");
        li.append(el("span", "fig-spot", r.spot), rows[n].icon, rows[n].item, rows[n].kw);
        return li;
      });
      stickers.forEach((_, n) => { place(n); paint(n); });
      roll.hidden = false;
      syncUndo();
      return { svg, lis };
    },
    /** Leaving the house step: its buttons hide; selection and history stay for Back. */
    leave() {
      svg = null;
      groups = [];
      rows = [];
      roll.hidden = true;
      undo.hidden = true;
    },
    reset() {
      stickers = null;
      history.length = 0;
      selected = -1;
    },
  };
}
