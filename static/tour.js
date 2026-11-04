// @ts-check
// Pal's first-run tour (MEM-095), its Settings replay (MEM-112) and step 3's emoji stickers (MEM-117). Ported from
// docs/design/tutorial/preview.js. Step text goes in via textContent only, never parsed as HTML.
import { showTab } from "./tabbar.js";
import { rollAll, rollOne } from "./stickers.js";

export const TOUR_KEY = "memripal.tour.done";

/** @param {number} cp */
function E(cp) { return String.fromCodePoint(cp); }

// story: centered card with an optional locus figure (fig rows: spot, icon, item; sub = nested spots).
// house: Pal's dog house segmented like a station photo: one box [x, y, w, h] per spot in a 320x200 viewBox,
// numbered in walk order; the route through the box centres never crosses itself.
export const STEPS = [
  { target: null, title: "Hi! I'm King Memri.",
    body: "But call me Pal. My dog house is the Memri Palace. Let me show you how it works, then help you build a palace of your own.",
    next: "Show me" },
  { story: true, title: "A trick older than kibble",
    body: "About 2,500 years ago a banquet hall collapsed. The poet Simonides could name every guest by where they had sat. Greek and Roman speakers then used his trick to remember whole speeches.",
    after: "They call it the memory palace. Clearly named after me.",
    next: "Next" },
  { story: true, title: "My Royal Shopping List",
    body: "One item per spot, in the order I walk my dog house:",
    house: [
      { spot: "Doormat", box: [128, 184, 64, 15] },
      { spot: "Water bowl", box: [40, 140, 70, 28] },
      { spot: "Chew-toy throne", box: [40, 82, 76, 36] },
      { spot: "Scratching post", box: [222, 86, 62, 80] },
      { spot: "Window", box: [134, 36, 52, 30] },
    ],
    fig: [
      { spot: "Doormat", icon: E(0x1F953), item: "sizzling bacon" },
      { spot: "Water bowl", icon: E(0x1F3BE), item: "squeaking tennis ball" },
      { spot: "Chew-toy throne", icon: E(0x1F95C), item: "dripping peanut butter" },
      { spot: "Scratching post", icon: E(0x1F3AB), item: "belly-rub voucher, wax paw seal" },
      { spot: "Window", icon: E(0x1F451), item: "spare paper crown, in case of rain, or a coup" },
    ],
    after: "I break each item into keywords and mash their emoji into one sticker. Tap a sticker to re-roll it.",
    next: "Next" },
  { story: true, title: "Then I walk it again",
    body: "At the store I stroll the house in my head. Each spot hands back its item:",
    fig: [
      { spot: "Doormat", icon: E(0x2713), item: "bacon", done: true },
      { spot: "Water bowl", icon: E(0x2713), item: "tennis ball", done: true },
      { spot: "Chew-toy throne", icon: E(0x2713), item: "peanut butter", done: true },
      { spot: "Scratching post", icon: E(0x2713), item: "belly-rub voucher", done: true },
      { spot: "Window", icon: E(0x2713), item: "paper crown", done: true },
      { spot: "(nowhere)", icon: "?", item: "item six", faded: true },
    ],
    after: "Item six I forgot because I didn't put it in the palace. Lesson.",
    next: "Next" },
  { story: true, title: "Five spots for five snacks? Amateur.",
    body: "I park the whole cart on the doormat. The cart is a mini-palace of its own:",
    fig: [
      { spot: "Doormat", icon: E(0x1F6D2), item: "the whole cart", sub: [
        { spot: "Handle", item: "leash" },
        { spot: "Child seat", item: "squeaky duck" },
        { spot: "Basket", item: "kibble" },
        { spot: "Bottom rack", item: "dog shampoo" },
        { spot: "Wheels", item: "four tennis balls" },
      ] },
    ],
    after: "The other spots stay free for my next list.",
    next: "Next" },
  { story: true, title: "A palace inside my palace",
    body: "One spot can hold a whole list, if the picture packs it in:",
    fig: [
      { spot: "Scratching post", icon: E(0x1F3AB), item: "CBE: Commander of the Belly Empire", sub: [
        { spot: "C", item: "Chin" }, { spot: "B", item: "Belly" }, { spot: "E", item: "Ears" },
      ] },
      { spot: "Window", icon: E(0x1F451), item: "the crown's 3 points", sub: [
        { spot: "Point 1", item: "glue" }, { spot: "Point 2", item: "glitter" }, { spot: "Point 3", item: "spare paper" },
      ] },
    ],
    after: "I am very powerful.",
    next: "Next" },
  { target: ".tab[href=\"#routes\"]", title: "Walk a place you know",
    body: "Pick a walk you take often. Stop at a few spots and snap a photo. Each spot becomes a room in your palace.",
    next: "Next" },
  { target: ".drawer-handle", title: "Your routes live here",
    body: "Open this to map a new route. No time to walk? Tap Load demo and try one I made earlier.",
    next: "Next" },
  { target: ".tab[href=\"#recall\"]", title: "Store it, then recall it",
    body: "Put one thing to remember at each spot. Later, walk the route in your head and tell me what you find. I'll keep score.",
    next: "Next" },
  { target: ".tab[href=\"#settings\"]", title: "Now let's build your palace",
    body: "You can replay this tour any time from Settings.",
    next: "Let's go" },
];

const TOAST_MS = 4000;
const SPOT_PAD = 6;
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

/**
 * Wire the #tour dialog, #tour-toast and #tour-replay; open the tour at step 1 for a first-time visitor.
 * @param {any} doc
 * @param {{ getItem: (k: string) => unknown, setItem: (k: string, v: string) => void }} store
 */
export function wireTour(doc, store) {
  const $ = (/** @type {string} */ id) => doc.getElementById(id);
  const tour = $("tour");
  // The app bootstrap tests' id-only fake DOM (fake_dom_test.mjs) has no querySelector or tour markup.
  if (typeof tour?.querySelector !== "function") return;
  // Timers and viewport looked up at call time so test mock timers and resizes apply.
  const win = doc.defaultView ?? globalThis;
  const spot = tour.querySelector(".tour-spot");
  const card = tour.querySelector(".tour-card");
  const dotList = tour.querySelector(".tour-dots");
  const fig = $("tour-fig");
  const house = $("tour-house");
  const after = $("tour-after");
  const back = $("tour-back");
  const next = $("tour-next");
  const toast = $("tour-toast");
  const roll = $("tour-roll");
  let cur = 0;
  // House-step stickers: rolled once, then kept while the page is open so Next/Back shows the same pictures.
  // groups/icons point at the nodes of the step currently drawn, so a re-roll repaints in place and keeps focus.
  /** @type {import("./stickers.js").Composite[] | null} */
  let stickers = null;
  /** @type {any[]} */
  let groups = [];
  /** @type {any[]} */
  let icons = [];
  /** @type {any[]} */
  const rollTimers = [];
  /** @type {any} */
  let toastTimer = null;

  // Dots and total follow STEPS, so adding a step needs no markup change.
  $("tour-total").textContent = String(STEPS.length);
  dotList.replaceChildren(...STEPS.map(() => doc.createElement("li")));

  /** @param {string} tag @param {string} [cls] @param {string} [text] */
  function el(tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  /**
   * A house-step row (sticker given) shows the sticker's parts as its icon plus a keyword caption.
   * @param {any} r @param {import("./stickers.js").Composite} [sticker]
   */
  function figRow(r, sticker) {
    const li = el("li", "fig-row" + (r.done ? " is-done" : "") + (r.faded ? " is-faded" : ""));
    li.appendChild(el("span", "fig-spot", r.spot));
    if (sticker) {
      icons.push(li.appendChild(el("span", "fig-icon", sticker.parts.join(""))));
    } else if (r.icon) {
      li.appendChild(el("span", "fig-icon", r.icon));
    }
    li.appendChild(el("span", "fig-item", r.item));
    if (sticker) li.appendChild(el("span", "tour-kw", sticker.keywords.join(" + ")));
    if (r.sub) {
      const ol = el("ol", "fig-sub");
      for (const c of r.sub) ol.appendChild(figRow(c));
      li.appendChild(ol);
    }
    return li;
  }

  /** @param {string} tag @param {Record<string, string | number>} attrs @param {string} [cls] */
  function svgEl(tag, attrs, cls) {
    const e = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (cls) e.setAttribute("class", cls);
    return e;
  }

  /**
   * Pal's dog house drawn like the v6 loci overlay (docs/design/v6/app.js lociOverlay): outline boxes, a dotted
   * route through the box centres, numbered pins at each box's top-left.
   * @param {{ spot: string, box: number[] }[]} spots
   */
  function houseFig(spots) {
    const svg = svgEl("svg", {
      viewBox: `0 0 ${HOUSE_W} ${HOUSE_H}`, role: "img",
      "aria-label": `Pal's dog house split into ${spots.length} numbered spots: `
        + spots.map((s, i) => `${i + 1} ${s.spot}`).join(", "),
    });
    // The house itself: roof, walls, door, ground.
    svg.appendChild(svgEl("path",
      { d: "M16 80 L160 10 L304 80 M32 80 V180 H288 V80 M140 180 V150 A20 20 0 0 1 180 150 V180 M8 180 H312" },
      "h-shape"));
    svg.appendChild(svgEl("polyline",
      { points: spots.map(({ box: b }) => `${b[0] + b[2] / 2},${b[1] + b[3] / 2}`).join(" ") }, "route-line"));
    // All outlines first, then labels, then pins, so a later box never paints over an earlier pin.
    for (const { box: b } of spots) {
      const r = { x: b[0], y: b[1], width: b[2], height: b[3], rx: 6 };
      svg.appendChild(svgEl("rect", r, "o-under"));
      svg.appendChild(svgEl("rect", r, "o-line"));
    }
    for (const { spot, box: b } of spots) {
      const words = spot.length > LABEL_WRAP ? spot.split(" ") : [spot];
      const cx = b[0] + b[2] / 2;
      const t = svgEl("text",
        { x: cx, y: b[1] + b[3] / 2 - ((words.length - 1) * LABEL_LEAD) / 2 + 3.5, "text-anchor": "middle" }, "o-label");
      words.forEach((w, n) => {
        const line = svgEl("tspan", { x: cx, dy: n ? LABEL_LEAD : 0 });
        line.textContent = w;
        t.appendChild(line);
      });
      svg.appendChild(t);
    }
    spots.forEach(({ box: b }, i) => {
      const cx = Math.max(PIN_R + 1, b[0]);
      const cy = Math.max(PIN_R + 1, b[1]);
      const g = svgEl("g", {}, "pin");
      g.appendChild(svgEl("circle", { cx, cy, r: PIN_R }));
      const n = svgEl("text", { x: cx, y: cy + 3.8, "text-anchor": "middle" });
      n.textContent = String(i + 1);
      g.appendChild(n);
      svg.appendChild(g);
    });
    return svg;
  }

  /**
   * One locus's sticker, anchored at its box's top-right corner (pins hold the top-left) and clamped so the
   * badge stays inside the viewBox. Its parts are painted by paintSticker.
   * @param {string} spot @param {number[]} b @param {number} i
   */
  function stickerGroup(spot, b, i) {
    const x = Math.min(Math.max(b[0] + b[2], STICKER_R), HOUSE_W - STICKER_R);
    const y = Math.min(Math.max(b[1], STICKER_R), HOUSE_H - STICKER_R);
    const g = svgEl("g",
      { transform: `translate(${x} ${y})`, role: "button", tabindex: 0, "aria-label": `Re-roll ${spot}` }, "tour-sticker");
    g.addEventListener("click", () => reroll([i]));
    g.addEventListener("keydown", (/** @type {any} */ e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault(); // Space would otherwise scroll the page
      reroll([i]);
    });
    return g;
  }

  /** @param {any} g @param {import("./stickers.js").Composite} s */
  function paintSticker(g, s) {
    // compose() yields 1..3 parts, one per keyword, so every part has an offset.
    const parts = s.parts.map((p, n) => {
      const [dx, dy] = STICKER_OFFSETS[n];
      const t = svgEl("text", {
        x: dx, y: dy, "font-size": n ? STICKER_SMALL : STICKER_BIG,
        "text-anchor": "middle", "dominant-baseline": "central",
      });
      t.textContent = p;
      return t;
    });
    g.replaceChildren(svgEl("circle", { r: STICKER_R }), ...parts);
  }

  /**
   * Re-roll the given loci on the drawn house step: new composites, repainted sticker and row icon, a spin.
   * @param {number[]} idx
   */
  function reroll(idx) {
    let rolled = /** @type {import("./stickers.js").Composite[]} */ (stickers);
    for (const i of idx) rolled = rollOne(rolled, i);
    stickers = rolled;
    for (const i of idx) {
      const g = groups[i];
      paintSticker(g, stickers[i]);
      icons[i].textContent = stickers[i].parts.join("");
      g.classList.add("is-rolling");
      win.clearTimeout(rollTimers[i]);
      rollTimers[i] = win.setTimeout(() => g.classList.remove("is-rolling"), ROLL_MS);
    }
  }

  function placeSpot() {
    const sel = /** @type {any} */ (STEPS[cur]).target || null;
    const target = sel ? doc.querySelector(sel) : null;
    if (target) {
      const r = target.getBoundingClientRect();
      spot.style.top = `${r.top - SPOT_PAD}px`;
      spot.style.left = `${r.left - SPOT_PAD}px`;
      spot.style.width = `${r.width + 2 * SPOT_PAD}px`;
      spot.style.height = `${r.height + 2 * SPOT_PAD}px`;
      spot.classList.remove("is-empty");
    } else {
      // Collapse to a point at screen centre so the card shows with no cut-out.
      spot.classList.add("is-empty");
      spot.style.top = `${win.innerHeight / 2}px`;
      spot.style.left = `${win.innerWidth / 2}px`;
      spot.style.width = "0px";
      spot.style.height = "0px";
    }
  }

  /** @param {number} i */
  function show(i) {
    cur = i;
    const s = /** @type {any} */ (STEPS[i]);
    // Unhide first: focus() is a no-op on an element inside a hidden dialog.
    tour.hidden = false;
    tour.classList.toggle("is-welcome", s.target === null);
    tour.classList.toggle("is-story", Boolean(s.story));
    $("tour-n").textContent = String(i + 1);
    [...dotList.children].forEach((d, n) => d.classList.toggle("is-current", n === i));
    $("tour-title").textContent = s.title;
    $("tour-body").textContent = s.body;
    // #tour-house is optional markup (older shells lack it); the figure only draws where it exists.
    // Sticker items come from the house step's fig rows (one per box, same order). Math.random is read inside
    // compose at call time, so tests can mock it.
    const rolled = s.house ? (stickers ??= rollAll(s.fig.map((/** @type {any} */ r) => r.item))) : null;
    groups = [];
    icons = [];
    if (house) {
      const svg = rolled ? houseFig(s.house) : null;
      if (svg) {
        groups = s.house.map((/** @type {any} */ h, /** @type {number} */ n) => stickerGroup(h.spot, h.box, n));
        groups.forEach((g, n) => paintSticker(g, rolled[n]));
        svg.append(...groups);
      }
      house.replaceChildren(...(svg ? [svg] : []));
      house.hidden = !s.house;
    }
    fig.replaceChildren(...(s.fig ?? []).map((/** @type {any} */ r, /** @type {number} */ n) => figRow(r, rolled?.[n])));
    fig.hidden = !s.fig;
    roll.hidden = !s.house;
    after.textContent = s.after ?? "";
    after.hidden = !s.after;
    back.hidden = i === 0;
    next.textContent = s.next;
    placeSpot();
    next.focus();
  }

  function hideToast() {
    win.clearTimeout(toastTimer);
    toastTimer = null;
    toast.hidden = true;
  }

  function showToast() {
    win.clearTimeout(toastTimer);
    toast.hidden = false;
    toastTimer = win.setTimeout(hideToast, TOAST_MS);
  }

  /** @param {boolean} skipped */
  function close(skipped) {
    tour.hidden = true;
    try {
      store.setItem(TOUR_KEY, "1");
    } catch {
      // Storage full or disabled: the tour still closes; it may reopen next load.
    }
    if (skipped) showToast();
  }

  next.addEventListener("click", () => {
    if (cur < STEPS.length - 1) show(cur + 1);
    else close(false);
  });
  back.addEventListener("click", () => { if (cur > 0) show(cur - 1); });
  // Visible only on the house step, so groups always belong to the drawn house.
  roll.addEventListener("click", () => reroll(groups.map((_, n) => n)));
  $("tour-skip").addEventListener("click", () => close(true));
  $("tour-replay")?.addEventListener("click", () => {
    showTab("routes", doc);
    hideToast();
    show(0);
  });
  win.addEventListener("resize", () => { if (!tour.hidden) placeSpot(); });

  doc.addEventListener("keydown", (/** @type {any} */ e) => {
    if (tour.hidden) return;
    if (e.key === "Escape") { close(true); return; }
    if (e.key !== "Tab" || !tour.contains(doc.activeElement)) return;
    // Focus trap: cycle the card's visible buttons only.
    const btns = [...card.querySelectorAll("button")].filter((b) => !b.hidden);
    if (!btns.length) return;
    e.preventDefault();
    const at = btns.indexOf(doc.activeElement);
    const to = e.shiftKey ? (at <= 0 ? btns.length - 1 : at - 1) : (at + 1) % btns.length;
    btns[to].focus();
  });

  let seen;
  try {
    seen = store.getItem(TOUR_KEY);
  } catch {
    // Storage disabled: stay hidden rather than nag on every load.
    return;
  }
  if (seen === null || seen === undefined) show(0);
}
