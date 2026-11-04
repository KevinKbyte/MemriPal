// @ts-check
// Pal's first-run tour (MEM-095), its Settings replay (MEM-112) and step 3's emoji stickers (MEM-117, drawn by
// tour_house.js). Ported from docs/design/tutorial/preview.js. Step text goes in via textContent only, never parsed
// as HTML.
import { showTab } from "./tabbar.js";
import { wireHouse } from "./tour_house.js";

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
    after: "I break each item into keywords and mash their emoji into one sticker. "
      + "Drag a sticker onto another spot, or tap New sticker for a fresh one.",
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
  const houseStep = wireHouse(doc, win, $("tour-roll"), $("tour-roll-undo"));
  let cur = 0;
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

  /** @param {any} r */
  function figRow(r) {
    const li = el("li", "fig-row" + (r.done ? " is-done" : "") + (r.faded ? " is-faded" : ""));
    li.appendChild(el("span", "fig-spot", r.spot));
    if (r.icon) li.appendChild(el("span", "fig-icon", r.icon));
    li.appendChild(el("span", "fig-item", r.item));
    if (r.sub) {
      const ol = el("ol", "fig-sub");
      for (const c of r.sub) ol.appendChild(figRow(c));
      li.appendChild(ol);
    }
    return li;
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
    // pal_bubble.js reads this to stay inert unless the step targets it (ADR 0072).
    doc.body.dataset.tourTarget = s.target ?? "";
    // Unhide first: focus() is a no-op on an element inside a hidden dialog.
    tour.hidden = false;
    tour.classList.toggle("is-welcome", s.target === null);
    tour.classList.toggle("is-story", Boolean(s.story));
    $("tour-n").textContent = String(i + 1);
    [...dotList.children].forEach((d, n) => d.classList.toggle("is-current", n === i));
    $("tour-title").textContent = s.title;
    $("tour-body").textContent = s.body;
    // #tour-house is optional markup (older shells lack it); the figure only draws where it exists.
    // Sticker items come from the house step's fig rows (one per box, same order).
    if (!s.house) houseStep.leave();
    const drawn = s.house ? houseStep.draw(s, Boolean(house)) : null;
    if (house) {
      house.replaceChildren(...(drawn?.svg ? [drawn.svg] : []));
      house.hidden = !s.house;
    }
    fig.replaceChildren(...(drawn ? drawn.lis : (s.fig ?? []).map(figRow)));
    fig.hidden = !s.fig;
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
    delete doc.body.dataset.tourTarget;
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
  $("tour-skip").addEventListener("click", () => close(true));
  $("tour-replay")?.addEventListener("click", () => {
    showTab("routes", doc);
    hideToast();
    houseStep.reset(); // a replay rolls step 3 fresh (MEM-109) with no selection or undo history (MEM-130)
    show(0);
  });
  win.addEventListener("resize", () => { if (!tour.hidden) placeSpot(); });

  doc.addEventListener("keydown", (/** @type {any} */ e) => {
    if (tour.hidden) return;
    if (e.key === "Escape") { close(true); return; }
    if (e.key !== "Tab" || !tour.contains(doc.activeElement)) return;
    // Focus trap: cycle the card's visible buttons and the house step's stickers, in document order.
    const btns = [...card.querySelectorAll("button, .tour-sticker")].filter((b) => !b.hidden);
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
