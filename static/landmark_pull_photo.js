// @ts-check
// Pull a Mapillary street photo for a landmark with no user photo (MEM-137, ADR 0080). Pure module over
// injected doc/fetch/storage seams. A user photo always wins: nothing renders for an item with photo_ref.
// Pulled images are data:image/jpeg only (the detail dialog's photo rule); every one carries its CC BY-SA
// credit, and all text goes through textContent.

import { creditBlock } from "./street_photo.js";

const PULL_TEXT = "No photo yet? Pull a street photo";
const STORE_PREFIX = "memripal.pulledPhoto.";
const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;
const FIVE_YEARS_MS = 5 * 365 * 86_400_000;
// Score weights: 20 m of distance costs as much as 1/3 of a full facing swing; recency and quality only
// separate near-ties.
const METRES_PER_POINT = 20;
const FACING_WEIGHT = 3;
const RECENCY_WEIGHT = 0.2;
const QUALITY_WEIGHT = 0.1;
// Unknown compass/date/quality score halfway, so an unknown camera ranks between facing and facing away.
const UNKNOWN = 0.5;

/**
 * @typedef {{ image: string, author: string, image_url: string, licence: string, lat?: number, lon?: number,
 *   compass_angle?: number | null, captured_at?: number | null, quality_score?: number | null }} Candidate
 */

/** @param {unknown} v @param {number} max @returns {v is number} */
const inRange = (v, max) => typeof v === "number" && Number.isFinite(v) && v >= -max && v <= max;

/** @param {any} c @returns {boolean} */
const positioned = (c) => Boolean(c) && typeof c === "object" && inRange(c.lat, 90) && inRange(c.lon, 180);

/** @param {any} c @returns {boolean} a credited candidate with a data:image/jpeg image */
const usable = (c) => Boolean(creditBlock(c)) && typeof c.image === "string" && JPEG_DATA_URL.test(c.image);

/**
 * @param {{ lat: number, lon: number }} target
 * @param {{ lat: number, lon: number }} cam
 * @returns {{ d: number, bearing: number }} distance in m and compass bearing camera -> target
 */
function geo(target, cam) {
  const dy = (target.lat - cam.lat) * DEG;
  const dx = (target.lon - cam.lon) * DEG * Math.cos(cam.lat * DEG);
  return { d: Math.hypot(dx, dy) * EARTH_RADIUS_M, bearing: (Math.atan2(dx, dy) / DEG + 360) % 360 };
}

/** @param {any} c @param {{ lat: number, lon: number }} target @param {number} now */
function score(c, target, now) {
  const { d, bearing } = geo(target, c);
  let facing = UNKNOWN;
  if (inRange(c.compass_angle, 720)) {
    // Circular difference in [0, 180]: 355 deg is 5 deg off north.
    const diff = Math.abs(((((c.compass_angle - bearing) % 360) + 540) % 360) - 180);
    facing = 1 - diff / 180;
  }
  const age = inRange(c.captured_at, 1e15) ? (now - c.captured_at) / FIVE_YEARS_MS : null;
  const recency = age === null ? UNKNOWN : Math.min(1, Math.max(0, 1 - age));
  const quality = inRange(c.quality_score, 1) && c.quality_score >= 0 ? c.quality_score : UNKNOWN;
  return -d / METRES_PER_POINT + facing * FACING_WEIGHT + recency * RECENCY_WEIGHT + quality * QUALITY_WEIGHT;
}

/**
 * Candidates best first; ones without a valid position are dropped. Never mutates the input.
 * @param {unknown} list
 * @param {unknown} target {lat, lon} of the landmark
 * @param {{ now?: number }} [opts]
 * @returns {Candidate[]}
 */
export function rankCandidates(list, target, { now = Date.now() } = {}) {
  if (!Array.isArray(list) || !positioned(target)) return [];
  const t = /** @type {{ lat: number, lon: number }} */ (target);
  return list
    .filter(positioned)
    .map((c) => ({ c, s: score(c, t, now) }))
    // Ties break on the image page URL so the order never depends on the input order.
    .sort((a, b) => b.s - a.s || (a.c.image_url < b.c.image_url ? -1 : a.c.image_url > b.c.image_url ? 1 : 0))
    .map((x) => x.c);
}

/** @param {any} item @returns {{ lat: number, lon: number } | null} station coords, else POI lat/lng */
function coordsOf(item) {
  const c = item?.station?.coords;
  if (c && inRange(c.lat, 90) && inRange(c.lon, 180)) return { lat: c.lat, lon: c.lon };
  const p = item?.poi;
  if (p && inRange(p.lat, 90) && inRange(p.lng, 180)) return { lat: p.lat, lon: p.lng };
  return null;
}

/**
 * Ask POST /baseline for the landmark's candidates. Never rejects.
 * @param {any} item
 * @param {{ fetchFn: (path: string, init: any) => Promise<Response> }} deps
 * @returns {Promise<{ best: Candidate | null, candidates: Candidate[], credit: any, error?: string }>}
 */
export async function pullPhotos(item, { fetchFn }) {
  const target = coordsOf(item);
  const empty = { best: null, candidates: [], credit: null };
  if (!target) return empty;
  try {
    const resp = await fetchFn("/baseline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target),
    });
    if (!resp.ok) return { ...empty, error: `status ${resp.status}` };
    const answer = await resp.json();
    const raw = Array.isArray(answer?.candidates) ? answer.candidates : [answer];
    const valid = raw.filter((c) => c && typeof c === "object" && usable(c));
    // A legacy single answer (fixture replay) has no position: keep it after the ranked ones.
    const candidates = [...rankCandidates(valid, target), ...valid.filter((c) => !positioned(c))];
    const best = candidates[0] ?? null;
    return { best, candidates, credit: best ? creditBlock(best) : null };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.name : "error" };
  }
}

/**
 * Pulled choice per landmark key: in memory, persisted through an optional localStorage-shaped storage.
 * @param {{ storage?: { getItem(k: string): string | null, setItem(k: string, v: string): void,
 *   removeItem(k: string): void } }} [opts]
 */
export function createPhotoStore({ storage } = {}) {
  /** @type {Map<string, any>} */
  const mem = new Map();
  return {
    /** @param {string} key */
    get(key) {
      if (mem.has(key)) return mem.get(key);
      try {
        const raw = storage?.getItem(STORE_PREFIX + key);
        const value = raw ? JSON.parse(raw) : null;
        return value && typeof value === "object" ? value : null;
      } catch {
        return null;
      }
    },
    /** @param {string} key @param {Candidate} choice */
    set(key, choice) {
      mem.set(key, choice);
      try {
        storage?.setItem(STORE_PREFIX + key, JSON.stringify(choice));
      } catch {
        // Storage disabled or full: the in-memory choice still serves this page.
      }
    },
    /** @param {string} key */
    clear(key) {
      mem.delete(key);
      try {
        storage?.removeItem(STORE_PREFIX + key);
      } catch {
        // As in set: the in-memory delete already took effect.
      }
    },
  };
}

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function make(doc, tag, className, text) {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** @param {Document} doc @param {string} href @param {string} text */
function link(doc, href, text) {
  const a = make(doc, "a", "", text);
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
  return a;
}

/**
 * Text-only credit: no logo img, so every img the pull renders stays data:image/jpeg.
 * @param {Document} doc @param {any} choice
 */
function renderPullCredit(doc, choice) {
  const c = /** @type {NonNullable<ReturnType<typeof creditBlock>>} */ (creditBlock(choice));
  const p = make(doc, "p", "lm-pull-photo-credit", "Street photo by ");
  p.append(
    make(doc, "span", "lm-pull-photo-author", c.author),
    " on Mapillary: ",
    link(doc, c.image_url, "Original image"),
    ", ",
    link(doc, c.licence_url, c.licence),
  );
  return p;
}

/** @param {Document} doc @param {string} src @param {string} alt */
function photo(doc, src, alt) {
  const img = doc.createElement("img");
  img.setAttribute("alt", alt);
  img.src = src;
  return img;
}

/**
 * Mount the pull UI for one landmark into container. Renders nothing when the item has a user photo or no
 * coords. onPhoto gets the chosen candidate, or null after Undo.
 * @param {any} container
 * @param {any} item
 * @param {{ doc: Document, fetchFn: (path: string, init: any) => Promise<Response>,
 *   store: { get(k: string): any, set(k: string, v: any): void, clear(k: string): void },
 *   onPhoto?: (choice: Candidate | null) => void }} deps
 */
export function mountPullPhoto(container, item, { doc, fetchFn, store, onPhoto }) {
  if (!item || item.photo_ref || !coordsOf(item)) return;
  const root = make(doc, "div", "lm-pull-photo-panel");
  container.append(root);
  /** @type {Candidate[]} */
  let candidates = [];

  /** @param {string} [message] */
  const showButton = (message) => {
    const btn = make(doc, "button", "lm-pull-photo", PULL_TEXT);
    btn.setAttribute("type", "button");
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const out = await pullPhotos(item, { fetchFn });
      if (out.best) {
        candidates = out.candidates;
        choose(out.best);
        return;
      }
      showButton(out.error ? "Could not pull a street photo. Try again." : "No street photos nearby");
    });
    root.replaceChildren(btn);
    if (message) root.append(make(doc, "p", "lm-pull-photo-note", message));
  };

  /** @param {Candidate} choice */
  const choose = (choice) => {
    store.set(item.key, choice);
    onPhoto?.(choice);
    show(choice);
  };

  /** @param {Candidate} choice */
  const show = (choice) => {
    const result = make(doc, "div", "lm-pull-photo-result");
    result.append(
      photo(doc, choice.image, `Street photo near ${item.name ?? "this landmark"}`),
      renderPullCredit(doc, choice),
    );
    const undo = make(doc, "button", "lm-pull-photo-undo", "Undo");
    undo.setAttribute("type", "button");
    undo.addEventListener("click", () => {
      store.clear(item.key);
      onPhoto?.(null);
      candidates = [];
      showButton();
    });
    const others = candidates.filter((c) => c.image_url !== choice.image_url);
    const parts = [result];
    if (others.length) {
      const picker = make(doc, "div", "lm-pull-photo-picker");
      for (const other of others) {
        const pick = make(doc, "button", "lm-pull-photo-pick");
        pick.setAttribute("type", "button");
        pick.setAttribute("aria-label", `Use the photo by ${other.author}`);
        pick.append(photo(doc, other.image, ""));
        pick.addEventListener("click", () => choose(other));
        picker.append(pick);
      }
      parts.push(picker);
    }
    root.replaceChildren(...parts, undo);
  };

  // A stored choice is re-checked: storage is client-writable, so it must pass the same image/credit rules.
  const stored = store.get(item.key);
  if (stored && usable(stored)) show(stored);
  else showButton();
}
