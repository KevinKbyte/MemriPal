// @ts-check
// Generated stickers (MEM-052, ADR 0070): each memorized item's tier-1 scene, cropped to its locus, becomes a pool
// sticker placed on that locus. No extra /scenes call; offline or any failure falls back to a matching emoji, else
// the item is skipped. Never rejects: stickers are decoration and must never break the demo.

import { isSafeImageSrc } from "./scenes.js";
import { MAX_DESC } from "./sticker_pool.js";
import { search } from "./stickers.js";

const SIDE = 128;
// Some photo around the object, so the sticker reads as the item in its place.
const MARGIN = 1.2;

/**
 * @typedef {import("./scenes.js").Box} Box
 * @typedef {import("./scenes.js").SceneResult} SceneResult
 * @typedef {{item: string, locus: {n: number, label?: string, box?: Box}}} Step
 * @typedef {ReturnType<typeof import("./sticker_pool.js").createStickerPool>} Pool
 * @typedef {(src: string, box: Box, width: number, height: number) => Promise<string>} Crop
 */

/**
 * Browser crop: a square around the locus box centre, as a 128px JPEG data URL. Rejects without a DOM.
 * @type {Crop}
 */
export async function cropScene(src, box, width, height) {
  const doc = globalThis.document;
  if (!doc) throw new Error("no DOM to crop in");
  const img = /** @type {HTMLImageElement} */ (doc.createElement("img"));
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = src;
  });
  // The scene may come back at another size than the photo the box was measured on.
  const kx = img.naturalWidth / (width > 0 ? width : img.naturalWidth);
  const ky = img.naturalHeight / (height > 0 ? height : img.naturalHeight);
  const side = Math.min(img.naturalWidth, img.naturalHeight, MARGIN * Math.max((box.x2 - box.x1) * kx, (box.y2 - box.y1) * ky));
  const sx = Math.min(Math.max(0, ((box.x1 + box.x2) / 2) * kx - side / 2), img.naturalWidth - side);
  const sy = Math.min(Math.max(0, ((box.y1 + box.y2) / 2) * ky - side / 2), img.naturalHeight - side);
  const canvas = /** @type {HTMLCanvasElement} */ (doc.createElement("canvas"));
  canvas.width = SIDE;
  canvas.height = SIDE;
  const ctx = canvas.getContext("2d");
  if (!ctx || !(side > 0)) throw new Error("cannot crop");
  ctx.drawImage(img, sx, sy, side, side, 0, 0, SIDE, SIDE);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/**
 * @param {Pool} pool
 * @param {string} placeKey
 * @param {Step[]} steps
 * @param {Array<SceneResult | null>} scenes
 * @param {{crop?: Crop}} [opts]
 * @returns {Promise<Array<{n: number, stickerId: string, kind: "generated" | "emoji"}>>}
 */
export async function stickMemorized(pool, placeKey, steps, scenes, { crop = cropScene } = {}) {
  /** @type {Array<{n: number, stickerId: string, kind: "generated" | "emoji"}>} */
  const placed = [];
  const taken = new Set((await pool.placements(placeKey).catch(() => [])).map((p) => p.n));
  for (const [i, step] of (Array.isArray(steps) ? steps : []).entries()) {
    const desc = String(step?.item ?? "").trim().slice(0, MAX_DESC).trim();
    const n = step?.locus?.n;
    if (!desc || taken.has(n)) continue;
    try {
      const id = await generatedId(pool, desc, step.locus.box, scenes?.[i] ?? null, crop);
      await pool.place(placeKey, n, id);
      placed.push({ n, stickerId: id, kind: "generated" });
    } catch {
      const emoji = search(desc)[0];
      if (!emoji) continue;
      try {
        await pool.place(placeKey, n, `emoji:${emoji.name}`);
        placed.push({ n, stickerId: `emoji:${emoji.name}`, kind: "emoji" });
      } catch {
        // Storage full or unavailable: this item just gets no sticker.
      }
    }
  }
  return placed;
}

/**
 * A generated sticker id for `desc`: the pool's existing one (so a re-run adds no duplicate), else a new crop.
 * Rejects when there is no usable scene, which sends the caller to the emoji fallback.
 * @param {Pool} pool @param {string} desc @param {Box | undefined} box @param {SceneResult | null} scene @param {Crop} crop
 */
async function generatedId(pool, desc, box, scene, crop) {
  const known = (await pool.list()).find((e) => e.kind === "generated" && e.desc === desc);
  if (known) return known.id;
  if (!scene || scene.tier !== 1 || !isSafeImageSrc(scene.image) || !box) throw new Error("no scene");
  const image = await crop(scene.image, box, Number(scene.width), Number(scene.height));
  return (await pool.add({ kind: "generated", desc, image })).id;
}
