// @ts-check
// Sticker pool (MEM-045, ADR 0068): emoji seeds plus the user's uploaded and generated stickers, each with a text
// description, and one placement per locus of a place. Pure and DOM-free; the kv is injected (selectStore in app.js).

import { BASE_STICKERS } from "./stickers.js";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_DESC = 60;
export const UPLOAD_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export const SEED_TIME = "1970-01-01T00:00:00.000Z";

// Stored images are re-encoded rasters only: svg could carry script, and remote URLs would leak a fetch.
const IMAGE_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const STORED_KINDS = new Set(["upload", "generated"]);

/**
 * @typedef {{ id: string, kind: "emoji" | "upload" | "generated", desc: string, image: string, created_at: string }} Entry
 * @typedef {{ placeKey: string, n: number, stickerId: string, placed_at: string }} Placement
 * @typedef {{ get: (k: string) => Promise<any>, put: (k: string, v: any) => Promise<void>,
 *   delete: (k: string) => Promise<unknown>, list: () => Promise<any[]> }} Kv
 */

/** @returns {Entry[]} */
export function emojiEntries() {
  return BASE_STICKERS.map((s) => ({
    id: `emoji:${s.name}`,
    kind: /** @type {const} */ ("emoji"),
    desc: [s.name, ...s.words].join(" "),
    image: s.emoji,
    created_at: SEED_TIME,
  }));
}

/** @param {unknown} desc @returns {string | null} trimmed desc, or null when empty or too long */
function cleanDesc(desc) {
  if (typeof desc !== "string") return null;
  const t = desc.trim();
  return t && t.length <= MAX_DESC ? t : null;
}

/**
 * @param {{ type?: string, size?: number } | null | undefined} file
 * @param {unknown} desc
 * @returns {string | null} a Pal-voiced reason the upload is refused, else null
 */
export function uploadError(file, desc) {
  if (!file) return "Pick a picture first and I'll stick it on!";
  if (!UPLOAD_TYPES.includes(String(file.type ?? ""))) return "I can only stick JPEG, PNG, WebP or GIF pictures.";
  const size = Number(file.size);
  if (!(size > 0)) return "That picture looks empty. Try another one?";
  if (size > MAX_UPLOAD_BYTES) return "That picture is too big for me (2 MB max).";
  if (cleanDesc(desc) === null) return `Tell me what it shows in 1 to ${MAX_DESC} characters.`;
  return null;
}

/** @param {unknown} placeKey @param {unknown} n */
function checkSpot(placeKey, n) {
  if (typeof placeKey !== "string" || !placeKey) throw new Error("sticker place key must be a non-empty string");
  if (!Number.isInteger(n) || /** @type {number} */ (n) < 1) throw new Error("sticker locus must be a positive integer");
}

const stickerKey = (/** @type {string} */ id) => `sticker:${id}`;
// JSON keeps a place key holding ":" from colliding with another place's locus.
const spotKey = (/** @type {string} */ placeKey, /** @type {number} */ n) => `place:${JSON.stringify([placeKey, n])}`;

/**
 * @param {Kv} kv
 * @param {{ now: () => string, newId: () => string }} opts
 */
export function createStickerPool(kv, { now, newId }) {
  const seeds = new Map(emojiEntries().map((e) => [e.id, e]));

  // kv.list yields values only, so each value carries its type.
  /** @param {"sticker" | "placement"} type */
  const stored = async (type) => (await kv.list()).filter((v) => v && v.type === type).map((v) => v.value);

  /** @param {string} id @returns {Promise<Entry | null>} */
  async function get(id) {
    const seed = seeds.get(id);
    if (seed) return { ...seed };
    const v = await kv.get(stickerKey(id));
    return v && v.type === "sticker" ? v.value : null;
  }

  return {
    /** @returns {Promise<Entry[]>} */
    async list() {
      /** @type {Entry[]} */
      const own = await stored("sticker");
      own.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
      return [...emojiEntries(), ...own];
    },

    /** @param {{ kind?: unknown, desc?: unknown, image?: unknown }} input @returns {Promise<Entry>} */
    async add({ kind, desc, image } = {}) {
      if (typeof kind !== "string" || !STORED_KINDS.has(kind)) throw new Error("sticker kind must be upload or generated");
      const clean = cleanDesc(desc);
      if (clean === null) throw new Error(`sticker desc must be 1 to ${MAX_DESC} characters`);
      if (typeof image !== "string" || !IMAGE_URL.test(image)) throw new Error("sticker image must be a jpeg, png or webp data URL");
      const entry = /** @type {Entry} */ ({ id: newId(), kind, desc: clean, image, created_at: now() });
      await kv.put(stickerKey(entry.id), { type: "sticker", value: entry });
      return entry;
    },

    get,

    /** @param {string} placeKey @param {number} n @param {string} stickerId @returns {Promise<Placement>} */
    async place(placeKey, n, stickerId) {
      checkSpot(placeKey, n);
      if (!(await get(stickerId))) throw new Error("unknown sticker");
      const placement = { placeKey, n, stickerId, placed_at: now() };
      await kv.put(spotKey(placeKey, n), { type: "placement", value: placement });
      return placement;
    },

    /** @param {string} placeKey @returns {Promise<Placement[]>} */
    async placements(placeKey) {
      /** @type {Placement[]} */
      const all = await stored("placement");
      return all.filter((p) => p.placeKey === placeKey).sort((a, b) => a.n - b.n);
    },

    /** @param {string} placeKey @param {number} n @returns {Promise<Placement | null>} */
    async unplace(placeKey, n) {
      const key = spotKey(placeKey, n);
      const v = await kv.get(key);
      if (!v || v.type !== "placement") return null;
      await kv.delete(key);
      return v.value;
    },

    /** Undo of unplace: puts the removed placement back as it was. @param {Placement} placement */
    async restore(placement) {
      checkSpot(placement?.placeKey, placement?.n);
      await kv.put(spotKey(placement.placeKey, placement.n), { type: "placement", value: { ...placement } });
    },
  };
}
