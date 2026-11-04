// @ts-check
// Street-photo scenes (MEM-098, ADR 0064): a scene derived from a Mapillary street photo must carry the
// full CC BY-SA 4.0 credit. Only a verified Mapillary image page under that exact licence earns a credit;
// anything else yields no credit and no image. Pure module: the DOM and fetch seams are injected.

export const LICENCE = "CC BY-SA 4.0";
export const LICENCE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";
// Official logos, used unmodified for attribution. Both PNGs are opaque tiles named for their background
// colour: -white is a white tile (dark wordmark) for light themes, -dark a dark tile (white wordmark) for dark.
const LOGO_LIGHT_BG = "img/mapillary-logo-white.png";
const LOGO_DARK_BG = "img/mapillary-logo-dark.png";
// Anchored and https-only, so lookalike hosts, embedded URLs and javascript: links never match.
// The id charset is what baseline.py's urllib quote() can emit.
const IMAGE_PAGE = /^https:\/\/www\.mapillary\.com\/app\/\?pKey=[A-Za-z0-9._~%-]+$/;
const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * @typedef {{author: string, image_url: string, licence: string, licence_url: string, ai_modified: true}} Credit
 */

/**
 * @param {any} raw a /baseline answer (or a Credit)
 * @returns {Credit | null}
 */
export function creditBlock(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { author, image_url, licence } = raw;
  if (licence !== LICENCE) return null;
  if (typeof image_url !== "string" || !IMAGE_PAGE.test(image_url)) return null;
  if (typeof author !== "string" || !author.trim()) return null;
  return { author, image_url, licence, licence_url: LICENCE_URL, ai_modified: true };
}

/**
 * @param {any} doc
 * @param {string} href
 */
function link(doc, href) {
  const a = doc.createElement("a");
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
  return a;
}

/**
 * @param {any} doc
 * @param {string} tag
 * @param {string} text
 */
function textEl(doc, tag, text) {
  const node = doc.createElement(tag);
  // textContent only: an author string is never parsed as markup.
  node.textContent = text;
  return node;
}

/**
 * Credit block in licence order: logo link, contributor, original-image link, AI-modified note, licence link.
 * @param {any} doc
 * @param {any} credit
 * @param {{theme?: string}} [opts]
 * @returns {any} the credit element, or null when the credit is not valid
 */
export function renderCredit(doc, credit, { theme } = {}) {
  const c = creditBlock(credit);
  if (!c) return null;
  const root = doc.createElement("div");
  root.className = "street-credit";

  const logoLink = link(doc, c.image_url);
  const logo = doc.createElement("img");
  logo.setAttribute("src", theme === "dark" ? LOGO_DARK_BG : LOGO_LIGHT_BG);
  logo.setAttribute("alt", "Mapillary");
  logoLink.append(logo);

  const original = link(doc, c.image_url);
  original.textContent = "Original image";
  const licence = link(doc, c.licence_url);
  licence.textContent = c.licence;

  root.append(logoLink, textEl(doc, "span", c.author), original, textEl(doc, "span", "AI-modified"), licence);
  return root;
}

/**
 * @param {unknown} v
 * @param {number} max
 * @returns {v is number}
 */
function inRange(v, max) {
  return typeof v === "number" && Number.isFinite(v) && v >= -max && v <= max;
}

/**
 * Asks POST /baseline for the station's street photo; image and credit come back together or not at all.
 * @param {{lat: number, lon: number}} coords
 * @param {{fetchJson: (path: string, init: {method: string, body: {lat: number, lon: number}}) => Promise<any>}} deps
 * @returns {Promise<{image: string | null, credit: Credit | null}>}
 */
export async function fetchStreetPhoto(coords, { fetchJson }) {
  const lat = coords?.lat;
  const lon = coords?.lon;
  if (!inRange(lat, 90) || !inRange(lon, 180)) throw new RangeError("invalid coords");
  const answer = await fetchJson("/baseline", { method: "POST", body: { lat, lon } });
  const credit = creditBlock(answer);
  const image = answer?.image;
  if (!credit || typeof image !== "string" || !JPEG_DATA_URL.test(image)) return { image: null, credit: null };
  return { image, credit };
}
