// @ts-check
// Scene panel (MEM-029): one POST /scenes per valid association, at most 3 in flight; a tier-1
// scene is shown zoomed to its locus with a full-size overlay, anything else as
// "Scene unavailable: <code>". Model text only ever reaches the page via textContent.

/** Matches the server's MAX_CONCURRENT_SCENES, so the client never queues work server-side. */
export const MAX_SCENES_IN_FLIGHT = 3;

// Leaves some room around the locus so the edited object is seen in its surroundings.
const ZOOM_MARGIN = 0.8;

const SAFE_SRC = /^(data:image\/(png|jpeg|webp);base64,|blob:)/;

/**
 * @typedef {{x1: number, y1: number, x2: number, y2: number}} Box
 * @typedef {{tier: 1, image: string, width?: number, height?: number} | {tier: 3, reason: string}} SceneResult
 * @typedef {{item: string, locus: {n: number, label: string, box?: Box},
 *   entry: {record: Record<string, string>, status: string, sig?: string} | null}} SceneCard
 * @typedef {Pick<Document, "getElementById" | "createElement" | "addEventListener">} SceneDoc
 */

/**
 * Only server base64 rasters or Blob URLs may become an img src: no script, SVG or remote URLs.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeImageSrc(value) {
  return typeof value === "string" && SAFE_SRC.test(value);
}

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Zoom for `transform-origin: 0 0; transform: scale(s) translate(tx*100%, ty*100%)`: the box is
 * centred where the edges allow, fully in frame, and the photo always covers the frame.
 * @param {Box | null | undefined} box
 * @param {number} width
 * @param {number} height
 * @returns {{scale: number, tx: number, ty: number}}
 */
export function zoomFor(box, width, height) {
  const identity = { scale: 1, tx: 0, ty: 0 };
  if (!box || !(width > 0) || !(height > 0)) return identity;
  const { x1, y1, x2, y2 } = box;
  if (![x1, y1, x2, y2, width, height].every(Number.isFinite)) return identity;
  const fx1 = clamp(x1 / width, 0, 1);
  const fx2 = clamp(x2 / width, 0, 1);
  const fy1 = clamp(y1 / height, 0, 1);
  const fy2 = clamp(y2 / height, 0, 1);
  if (!(fx2 > fx1) || !(fy2 > fy1)) return identity;
  const scale = Math.max(1, ZOOM_MARGIN * Math.min(1 / (fx2 - fx1), 1 / (fy2 - fy1)));
  // Centre the box, then clamp into [1/s - 1, 0] so no edge of the frame is left uncovered.
  const lo = 1 / scale - 1;
  const tx = clamp(0.5 / scale - (fx1 + fx2) / 2, lo, 0);
  const ty = clamp(0.5 / scale - (fy1 + fy2) / 2, lo, 0);
  // + 0 turns a -0 into 0.
  return { scale, tx: tx + 0, ty: ty + 0 };
}

/**
 * @param {SceneDoc} doc
 * @param {string} tag
 * @param {unknown} text
 */
function textEl(doc, tag, text) {
  const e = doc.createElement(tag);
  e.textContent = text == null ? "" : String(text);
  return e;
}

/** The thumbnail that opened each overlay, so closing it hands keyboard focus back. */
const openers = new WeakMap();

/**
 * Close-on-click and close-on-Escape, wired once per overlay however many runs share it.
 * @param {SceneDoc} doc
 * @param {HTMLElement} overlay
 */
function wireOverlay(doc, overlay) {
  if (overlay.dataset.wired === "1") return;
  overlay.dataset.wired = "1";
  const close = () => {
    overlay.hidden = true;
    overlay.replaceChildren();
    openers.get(overlay)?.focus();
    openers.delete(overlay);
  };
  overlay.addEventListener("click", close);
  doc.addEventListener("keydown", (ev) => {
    if (/** @type {KeyboardEvent} */ (ev).key === "Escape" && !overlay.hidden) close();
  });
}

/**
 * The scene for one card: a zoomed <img> (click opens the full-size overlay) for a safe tier-1
 * result, otherwise the "Scene unavailable" text. Shared with the walk view (encode.js).
 * @param {SceneDoc} doc
 * @param {SceneResult | null} result null = no scene was requested for this card
 * @param {Box | undefined} box
 * @param {HTMLElement | null} overlay
 * @param {string} alt "<item> at <locus>", so a screen reader hears what the scene shows
 * @returns {HTMLElement}
 */
export function sceneView(doc, result, box, overlay, alt) {
  if (!result || result.tier !== 1 || !isSafeImageSrc(result.image)) {
    const reason = result && result.tier === 3 ? result.reason : result ? "bad_image" : "skipped";
    // A demo server only has scenes recorded for its demo photo; say so instead of the raw code.
    if (reason === "fixture_missing") return textEl(doc, "p", "Scene unavailable: no demo scene for this");
    return textEl(doc, "p", `Scene unavailable: ${reason}`);
  }
  const src = result.image;
  const frame = doc.createElement("div");
  frame.className = "scene-frame";
  const img = /** @type {HTMLImageElement} */ (doc.createElement("img"));
  img.src = src;
  img.alt = alt;
  const { scale, tx, ty } = zoomFor(box, Number(result.width), Number(result.height));
  img.style.transformOrigin = "0 0";
  img.style.transform = `scale(${scale}) translate(${tx * 100}%, ${ty * 100}%)`;
  if (overlay) {
    const open = () => {
      const full = /** @type {HTMLImageElement} */ (doc.createElement("img"));
      full.src = src;
      full.alt = `${alt}, full size`;
      // No listener of its own: the click bubbles to the overlay's close handler.
      const close = /** @type {HTMLButtonElement} */ (textEl(doc, "button", "Close"));
      close.type = "button";
      overlay.replaceChildren(full, close);
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", `${alt}, full size`);
      openers.set(overlay, img);
      overlay.hidden = false;
      close.focus();
    };
    img.tabIndex = 0;
    img.addEventListener("click", open);
    img.addEventListener("keydown", (ev) => {
      const key = /** @type {KeyboardEvent} */ (ev).key;
      if (key !== "Enter" && key !== " ") return;
      ev.preventDefault();
      open();
    });
  }
  frame.append(img);
  return frame;
}

/**
 * One POST /scenes; never throws: every failure becomes a tier-3 result with a short code.
 * @param {SceneCard} card
 * @param {string} image
 * @param {typeof fetch} fetchFn
 * @returns {Promise<SceneResult>}
 */
async function requestScene(card, image, fetchFn) {
  /** @param {string} reason @returns {SceneResult} */
  const fail = (reason) => ({ tier: 3, reason });
  const sig = card.entry && card.entry.sig;
  // A record stored before signing (MEM-036) would only earn a 403, so it is never sent.
  if (typeof sig !== "string") return fail("unsigned");
  let resp;
  try {
    resp = await fetchFn("/scenes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, box: card.locus.box, record: card.entry && card.entry.record, sig }),
    });
  } catch {
    return fail("network");
  }
  const payload = await resp.json().catch(() => null);
  if (!resp.ok) return fail(payload && typeof payload.error === "string" ? payload.error : `http_${resp.status}`);
  if (payload && payload.tier === 1) {
    if (!isSafeImageSrc(payload.image)) return fail("bad_image");
    return { tier: 1, image: payload.image, width: payload.width, height: payload.height };
  }
  if (payload && payload.tier === 3 && typeof payload.reason === "string") return fail(payload.reason);
  return fail("bad_response");
}

/**
 * Render a scene for every eligible card (valid record + locus box) into #scenes, in card order.
 * @param {SceneCard[]} cards
 * @param {{doc: SceneDoc, fetch: typeof fetch, image?: string}} deps
 * @returns {Promise<Array<SceneResult | null>>} one entry per card; null = skipped
 */
export async function runScenes(cards, deps) {
  /** @type {Array<SceneResult | null>} */
  const results = cards.map(() => null);
  const panel = deps.doc.getElementById("scenes");
  const overlay = deps.doc.getElementById("scene-overlay");
  if (panel) panel.replaceChildren();
  if (overlay) wireOverlay(deps.doc, overlay);
  const image = deps.image;
  // The server rejects every request without a photo, so send nothing at all.
  if (!image) return results;
  if (panel) panel.setAttribute("aria-busy", "true");
  /** @type {Array<{index: number, card: SceneCard, slot: HTMLElement}>} */
  const jobs = [];
  cards.forEach((card, index) => {
    if (!card.entry || card.entry.status !== "valid" || !card.locus || !card.locus.box) return;
    const section = deps.doc.createElement("section");
    const slot = textEl(deps.doc, "div", "Rendering scene...");
    section.append(textEl(deps.doc, "h3", `${card.locus.n}. ${card.item} at ${card.locus.label}`), slot);
    if (panel) panel.append(section);
    jobs.push({ index, card, slot });
  });
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const result = await requestScene(job.card, image, deps.fetch);
      results[job.index] = result;
      const alt = [job.card.item, job.card.locus.label].filter(Boolean).join(" at ") || "Scene";
      job.slot.replaceChildren(sceneView(deps.doc, result, job.card.locus.box, overlay, alt));
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(MAX_SCENES_IN_FLIGHT, jobs.length) }, worker));
  } finally {
    // The panel announces once, when every scene has settled, not once per card.
    if (panel) panel.removeAttribute("aria-busy");
  }
  return results;
}
