// @ts-check
// Landmark photo slots (MEM-141, ADR 0081): SAM 3.1 segments the user's own landmark photo via the unchanged
// POST /loci, and the three Payoff parts get placed into the largest distinct regions. Labels from the model
// are untrusted, so every one is written with textContent.
import { apiUrl } from "./api_base.js";

/**
 * @typedef {{ x1: number, y1: number, x2: number, y2: number }} Box
 * @typedef {{ n: number, label: string, box: Box, outline: number[][] }} Slot
 * @typedef {{ source: "live" | "cached" | "sample", image: string, width: number, height: number,
 *   slots: Slot[] }} SlotResult
 */

export const PAYOFF_PARTS = [
  { id: "resolve", label: "Resolve the question" },
  { id: "useful", label: "Something useful" },
  { id: "memorable", label: "Something memorable" },
];
export const SLOT_COUNT = 3;

// svg+xml is excluded on purpose: an SVG data URL can carry script.
const SAFE_IMAGE = /^data:image\/(jpeg|png|webp);base64,/;
const SVG_NS = "http://www.w3.org/2000/svg";
const BADGES = { live: "Live SAM 3.1", cached: "Cached SAM 3.1", sample: "Sample photo" };

const posNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** @param {any} json a POST /loci reply */
export function parseSegmentation(json) {
  if (!json || typeof json !== "object") return null;
  const { image, width, height, loci } = json;
  if (typeof image !== "string" || !SAFE_IMAGE.test(image)) return null;
  if (!posNum(width) || !posNum(height) || !Array.isArray(loci)) return null;
  return { image, width, height, loci };
}

/** @param {any} box @returns {Box | null} */
function cleanBox(box) {
  if (!box || typeof box !== "object") return null;
  const { x1, y1, x2, y2 } = box;
  if (![x1, y1, x2, y2].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return x2 > x1 && y2 > y1 ? { x1, y1, x2, y2 } : null;
}

const area = (b) => (b.x2 - b.x1) * (b.y2 - b.y1);

/** @param {any} outline @param {Box} box */
function cleanOutline(outline, box) {
  const ok =
    Array.isArray(outline) &&
    outline.length >= 3 &&
    outline.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (ok) return outline.map((p) => [p[0], p[1]]);
  return [
    [box.x1, box.y1],
    [box.x2, box.y1],
    [box.x2, box.y2],
    [box.x1, box.y2],
  ];
}

/** @param {any[]} loci @param {number} count @returns {Slot[]} */
export function pickSlots(loci, count) {
  /** @type {Map<string, { label: string, box: Box, outline: any }>} */
  const byLabel = new Map();
  for (const l of Array.isArray(loci) ? loci : []) {
    const box = cleanBox(l?.box);
    if (!box) continue;
    const label = String(l.label ?? "");
    const key = label.toLowerCase();
    const prev = byLabel.get(key);
    if (!prev || area(box) > area(prev.box)) byLabel.set(key, { label, box, outline: l.outline });
  }
  return [...byLabel.values()]
    .sort((a, b) => area(b.box) - area(a.box))
    .slice(0, count)
    .sort((a, b) => a.box.y1 - b.box.y1 || a.box.x1 - b.box.x1)
    .map((s, i) => ({ n: i + 1, label: s.label, box: s.box, outline: cleanOutline(s.outline, s.box) }));
}

/** @param {any} json @param {SlotResult["source"]} source @returns {SlotResult | null} */
function toResult(json, source) {
  const seg = parseSegmentation(json);
  if (!seg) return null;
  const slots = pickSlots(seg.loci, SLOT_COUNT);
  if (slots.length < SLOT_COUNT) return null;
  return { source, image: seg.image, width: seg.width, height: seg.height, slots };
}

const cacheKey = (id) => `memripal.slots.${id}`;

/** @param {any} storage @param {string} landmarkId @returns {SlotResult | null} */
function readCache(storage, landmarkId) {
  try {
    const raw = storage?.getItem(cacheKey(landmarkId));
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || typeof c.image !== "string" || !SAFE_IMAGE.test(c.image)) return null;
    if (!posNum(c.width) || !posNum(c.height) || !Array.isArray(c.slots) || c.slots.length < SLOT_COUNT) return null;
    return { source: "cached", image: c.image, width: c.width, height: c.height, slots: c.slots };
  } catch {
    return null;
  }
}

/**
 * The offline path: the cached live result for this landmark, else the bundled fixture, else null.
 * @param {{ fetch: typeof fetch, storage?: any, landmarkId: string, fixtureUrl: string }} opts
 */
export async function fallbackResult({ fetch, storage, landmarkId, fixtureUrl }) {
  const cached = readCache(storage, landmarkId);
  if (cached) return cached;
  try {
    const resp = await fetch(fixtureUrl);
    if (!resp.ok) return null;
    return toResult(await resp.json(), "sample");
  } catch {
    return null;
  }
}

/**
 * POST the photo to /loci; never rejects. Falls back to the cache, then the bundled fixture, then null.
 * @param {{ fetch: typeof fetch, file: Blob, storage?: any, landmarkId: string, fixtureUrl: string,
 *   timeoutMs?: number }} opts
 * @returns {Promise<SlotResult | null>}
 */
export async function segmentLandmark({ fetch, file, storage, landmarkId, fixtureUrl, timeoutMs = 45000 }) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl?.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  try {
    const resp = await Promise.race([
      fetch(apiUrl("/loci"), {
        method: "POST",
        body: file,
        headers: { "Content-Type": file?.type || "image/jpeg" },
        signal: ctrl?.signal,
      }),
      timeout,
    ]);
    if (resp.ok) {
      const live = toResult(await Promise.race([resp.json(), timeout]), "live");
      if (live) {
        try {
          const { image, width, height, slots } = live;
          storage?.setItem(cacheKey(landmarkId), JSON.stringify({ image, width, height, slots }));
        } catch {
          // Quota or private-mode storage: the live result still shows, it just is not cached.
        }
        return live;
      }
    }
  } catch {
    // Network error, timeout or bad JSON: fall through to the offline path.
  } finally {
    clearTimeout(timer);
  }
  timeout.catch(() => {});
  return fallbackResult({ fetch, storage, landmarkId, fixtureUrl });
}

/**
 * Pure: `partId` moves to slot `n`; whoever held `n` takes `partId`'s old slot, or becomes unplaced.
 * @param {Record<string, number>} placements @param {string} partId @param {number} n
 */
export function placePart(placements, partId, n) {
  const out = { ...placements };
  const old = out[partId];
  const occupant = Object.keys(out).find((k) => k !== partId && out[k] === n);
  if (occupant !== undefined) {
    if (old === undefined) delete out[occupant];
    else out[occupant] = old;
  }
  out[partId] = n;
  return out;
}

/**
 * @param {{ doc: Document, root: HTMLElement, parts: Array<{ id: string, label: string }>,
 *   wireDrag?: (el: any, opts: { onDrop: (clientX: number, clientY: number) => void }) => void,
 *   nearestBox?: (boxes: Box[], x: number, y: number) => number }} deps
 */
export function createSlotBoard({ doc, root, parts, wireDrag, nearestBox }) {
  /** @type {Record<string, number>} */
  let placements = {};
  /** @type {string | null} */
  let selected = null;
  /** @type {Map<string, any>} */
  let chipEls = new Map();
  /** @type {Map<number, any>} */
  let rowSlotEls = new Map();
  /** @type {Map<number, any>} */
  let shapeEls = new Map();

  const make = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.classList.add(cls);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const svg = (tag, cls) => {
    const e = doc.createElementNS(SVG_NS, tag);
    if (cls) e.classList.add(cls);
    return e;
  };

  function sync() {
    const labelOf = new Map(parts.map((p) => [p.id, p.label]));
    for (const [n, cell] of rowSlotEls) {
      const id = Object.keys(placements).find((k) => placements[k] === n);
      cell.textContent = id ? labelOf.get(id) ?? id : "Empty";
      shapeEls.get(n)?.classList.toggle("is-filled", Boolean(id));
    }
    for (const [id, chip] of chipEls) {
      chip.setAttribute("aria-pressed", String(selected === id));
      chip.classList.toggle("is-placed", placements[id] !== undefined);
    }
  }

  function place(partId, n) {
    placements = placePart(placements, partId, n);
    selected = null;
    sync();
  }

  function onSlotTap(n) {
    if (selected !== null) place(selected, n);
  }

  /** @param {SlotResult} result */
  function show(result) {
    placements = {};
    selected = null;
    chipEls = new Map();
    rowSlotEls = new Map();
    shapeEls = new Map();

    const badge = make("p", "slot-badge", BADGES[result.source] ?? BADGES.sample);
    badge.dataset.source = result.source;

    const photo = make("div", "slot-photo");
    const img = make("img", "slot-img");
    img.alt = "Your landmark photo";
    img.src = result.image;
    const overlay = svg("svg", "slot-overlay");
    overlay.setAttribute("viewBox", `0 0 ${result.width} ${result.height}`);
    overlay.setAttribute("preserveAspectRatio", "none");
    for (const s of result.slots) {
      const shape = svg("polygon", "slot-shape");
      shape.setAttribute("points", s.outline.map((p) => `${p[0]},${p[1]}`).join(" "));
      shape.setAttribute("data-n", String(s.n));
      shape.addEventListener("click", () => onSlotTap(s.n));
      shapeEls.set(s.n, shape);
      // Photo-px units: scale with the photo so the number reads at any upload size.
      const size = Math.max(12, Math.round(result.width / 18));
      const num = svg("text", "slot-num");
      num.setAttribute("x", String(s.box.x1 + size / 3));
      num.setAttribute("y", String(s.box.y1 + size / 3));
      num.setAttribute("font-size", String(size));
      num.textContent = String(s.n);
      overlay.append(shape, num);
    }
    photo.append(img, overlay);

    const rows = make("ol", "slot-rows");
    for (const s of result.slots) {
      const row = make("li", "slot-row");
      row.setAttribute("data-n", String(s.n));
      const placed = make("span", "slot-row-part");
      row.append(make("span", "slot-row-n", String(s.n)), make("span", "slot-row-label", s.label), placed);
      row.addEventListener("click", () => onSlotTap(s.n));
      rowSlotEls.set(s.n, placed);
      rows.append(row);
    }

    const tray = make("div", "payoff-tray");
    for (const p of parts) {
      const chip = make("button", "payoff-chip", p.label);
      chip.setAttribute("type", "button");
      chip.addEventListener("click", () => {
        selected = selected === p.id ? null : p.id;
        sync();
      });
      if (wireDrag && nearestBox) {
        wireDrag(chip, {
          onDrop(clientX, clientY) {
            const r = img.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) return;
            const x = ((clientX - r.left) * result.width) / r.width;
            const y = ((clientY - r.top) * result.height) / r.height;
            const i = nearestBox(
              result.slots.map((s) => s.box),
              x,
              y,
            );
            const slot = result.slots[i];
            if (slot) place(p.id, slot.n);
          },
        });
      }
      chipEls.set(p.id, chip);
      tray.append(chip);
    }

    root.replaceChildren(badge, photo, tray, rows);
    sync();
  }

  return { show, placements: () => ({ ...placements }), place };
}
