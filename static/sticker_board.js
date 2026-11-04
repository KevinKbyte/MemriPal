// @ts-check
// Sticker board (MEM-045, ADR 0068): stick your own picture on a locus of the landmark photo. Owns #sticker-panel
// and one .sticker-layer over #scene-wrap. Every user text goes in via textContent; image srcs are pool data URLs.

import { cropScene, stickMemorized } from "./sticker_gen.js";
import { uploadError } from "./sticker_pool.js";
import { createUndoStack } from "./undo_stack.js";

/**
 * @typedef {{x1: number, y1: number, x2: number, y2: number}} Box
 * @typedef {{n: number, label: string, box?: Box}} Locus
 * @typedef {{placeKey: string, width: number, height: number, loci: Locus[]}} View
 * @typedef {ReturnType<typeof import("./sticker_pool.js").createStickerPool>} Pool
 */

const READ_FAILED = "Oops, I couldn't read that picture. Try another one?";

/** @param {number} v */
const pct = (v) => `${Number(v.toFixed(2))}%`;

/**
 * @param {{ doc: Document, pool: Pool, makeImage: (file: File) => Promise<string>,
 *   undo?: ReturnType<typeof createUndoStack>, crop?: import("./sticker_gen.js").Crop }} deps
 */
export function createStickerBoard({ doc, pool, makeImage, undo = createUndoStack(), crop = cropScene }) {
  const $ = (/** @type {string} */ id) => /** @type {any} */ (doc.getElementById(id));
  const panel = $("sticker-panel");
  const locusSel = $("sticker-locus");
  const fileIn = $("sticker-file");
  const descIn = $("sticker-desc");
  const addBtn = $("sticker-add");
  const error = $("sticker-error");
  const placed = $("sticker-placed");
  const toast = $("sticker-toast");
  const toastText = $("sticker-toast-text");
  const undoBtn = $("sticker-undo");
  const wrap = $("scene-wrap");

  /** @type {View | null} */
  let view = null;
  const layer = doc.createElement("div");
  layer.className = "sticker-layer";
  layer.classList.add("sticker-layer");
  layer.setAttribute("aria-hidden", "true");

  /** @param {string | null} msg */
  const setError = (msg) => {
    if (!error) return;
    error.textContent = msg ?? "";
    error.hidden = msg === null;
  };

  /** @param {string} tag @param {string} text @param {string} [cls] */
  const textEl = (tag, text, cls) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    e.textContent = text;
    return e;
  };

  /** @param {string} action @param {string} text */
  const actionBtn = (action, text) => {
    const b = /** @type {HTMLButtonElement} */ (textEl("button", text, "btn sticker-btn"));
    b.type = "button";
    b.dataset.action = action;
    return b;
  };

  /** @param {{image: string, kind: string, desc: string}} entry */
  function stickerFace(entry) {
    if (entry.kind === "emoji") return textEl("span", entry.image, "sticker-emoji");
    const img = /** @type {HTMLImageElement} */ (doc.createElement("img"));
    img.alt = entry.desc;
    img.setAttribute("alt", entry.desc);
    img.src = entry.image;
    return img;
  }

  /** @param {import("./sticker_pool.js").Placement} p @param {string} label @param {string} desc */
  function placedItem(p, label, desc) {
    const li = doc.createElement("li");
    li.className = "sticker-placed-item";
    const peel = actionBtn("peel", "Peel off");
    const yes = actionBtn("peel-confirm", "Yes, peel it off");
    const keep = actionBtn("peel-cancel", "Keep it");
    yes.hidden = true;
    keep.hidden = true;
    /** @param {boolean} asking */
    const ask = (asking) => {
      peel.hidden = asking;
      yes.hidden = !asking;
      keep.hidden = !asking;
    };
    peel.addEventListener("click", () => ask(true));
    keep.addEventListener("click", () => ask(false));
    yes.addEventListener("click", () => void peelOff(p, desc));
    li.append(textEl("span", `${p.n}. ${label}: ${desc}`, "sticker-placed-text"), peel, yes, keep);
    return li;
  }

  async function render() {
    if (!view) return;
    const v = view;
    const byN = new Map(v.loci.map((l) => [l.n, l]));
    const items = [];
    const faces = [];
    for (const p of await pool.placements(v.placeKey)) {
      const entry = await pool.get(p.stickerId);
      if (!entry) continue;
      const locus = byN.get(p.n);
      // MEM-046: a generated picture is always labelled as such.
      const desc = entry.kind === "generated" ? `${entry.desc} (AI-generated)` : entry.desc;
      items.push(placedItem(p, locus?.label ?? `Spot ${p.n}`, desc));
      const box = locus?.box;
      if (!box || !(v.width > 0) || !(v.height > 0)) continue;
      const s = doc.createElement("div");
      s.className = "sticker";
      s.classList.add("sticker");
      s.style.left = pct(((box.x1 + box.x2) / 2 / v.width) * 100);
      s.style.top = pct(((box.y1 + box.y2) / 2 / v.height) * 100);
      s.append(stickerFace(entry));
      faces.push(s);
    }
    placed?.replaceChildren(...items);
    layer.replaceChildren(...faces);
    if (wrap && layer.parentNode !== wrap) wrap.append(layer);
  }

  /** @param {import("./sticker_pool.js").Placement} p @param {string} desc */
  async function peelOff(p, desc) {
    const removed = await pool.unplace(p.placeKey, p.n);
    if (!removed) return render();
    undo.push({
      label: desc,
      undo: async () => {
        await pool.restore(removed);
        await render();
      },
    });
    if (toastText) toastText.textContent = `Peeled off "${desc}".`;
    if (toast) toast.hidden = false;
    await render();
  }

  async function add() {
    if (!view) return;
    const file = fileIn?.files?.[0] ?? null;
    const desc = String(descIn?.value ?? "");
    const refused = uploadError(file, desc);
    if (refused) return setError(refused);
    let image;
    try {
      image = await makeImage(file);
    } catch {
      return setError(READ_FAILED);
    }
    try {
      const entry = await pool.add({ kind: "upload", desc, image });
      await pool.place(view.placeKey, Number(locusSel?.value), entry.id);
    } catch {
      return setError(READ_FAILED);
    }
    setError(null);
    if (descIn) descIn.value = "";
    if (fileIn) fileIn.value = "";
    await render();
  }

  addBtn?.addEventListener("click", () => void add());
  undoBtn?.addEventListener("click", async () => {
    if (toast) toast.hidden = true;
    await undo.undo();
  });

  return {
    /** @param {View} next */
    async show(next) {
      view = next;
      const loci = Array.isArray(next.loci) ? next.loci : [];
      locusSel?.replaceChildren(
        ...loci.map((l) => {
          const o = /** @type {HTMLOptionElement} */ (textEl("option", `${l.n}. ${l.label}`));
          o.value = String(l.n);
          return o;
        }),
      );
      if (panel) panel.hidden = false;
      await render();
    },

    /**
     * MEM-052: stick each memorized item on its locus of the shown photo; [] before show.
     * @param {import("./sticker_gen.js").Step[]} steps @param {Array<import("./scenes.js").SceneResult | null>} scenes
     */
    async stickMemorized(steps, scenes) {
      if (!view) return [];
      const placed = await stickMemorized(pool, view.placeKey, steps, scenes, { crop });
      await render();
      return placed;
    },
  };
}
