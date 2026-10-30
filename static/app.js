// @ts-check
// MemriPal frontend: backend health plus photo upload -> numbered memory loci (MEM-017).
// Served as a raw ES module (no build step). Model-derived text is only ever set via textContent.

import { selectStore, withPasscode, wireApp } from "./flow.js";
import { associationKey, createPalaceStore } from "./palace_store.js";
import { browserGeolocate, createPlaceState, lookupPlace, readGps, wirePlace } from "./place.js";
import { createRehearsalStore } from "./rehearsals.js";
import { migrateLocalStorage } from "./storage_migrate.js";

export { isPublicHost, showPublicBanner } from "./public_banner.js";
// MEM-044 F15: canvas badge colours (v6 --bad on white, >= 4.5:1); a canvas cannot read CSS tokens.
export const BADGE_FILL = "#A1341A", BADGE_TEXT = "#FFFFFF";

/**
 * @typedef {{x1: number, y1: number, x2: number, y2: number}} LocusBox
 * @typedef {{n: number, label: string, phrase?: string, box?: LocusBox}} Locus
 * @typedef {{image: string, width: number, height: number, loci: Locus[]}} LociResponse
 */

/**
 * @param {{status?: string, mode?: string} | null} health
 * @returns {string}
 */
export function formatHealth(health) {
  if (!health || health.status !== "ok") return "Backend unavailable";
  return `Backend ok (${health.mode} mode)`;
}

/**
 * Scale that fits an imgW-wide image into maxW without ever upscaling; 1 for any unusable argument.
 * @param {number} imgW
 * @param {number} imgH
 * @param {number} maxW
 * @returns {number}
 */
export function fitScale(imgW, imgH, maxW) {
  const usable = [imgW, imgH, maxW].every((v) => Number.isFinite(v) && v > 0);
  return usable ? Math.min(1, maxW / imgW) : 1;
}

/**
 * @param {typeof fetch} fetchFn
 * @param {BodyInit} body
 * @returns {Promise<Response>}
 */
function postLoci(fetchFn, body) {
  return fetchFn("/loci", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body });
}

/** A non-ok HTTP answer; its message ("HTTP 503") is user-facing, unlike other send errors. */
class HttpStatusError extends Error {}

/** @param {number} status */
function httpStatusText(status) {
  return `HTTP ${status}`;
}

/**
 * Upload the server's demo photo byte-for-byte: a browser re-encode would change the processed
 * sha and miss the fixture replay ("fixture_missing"). A page opened as /?room=<room_id> loads that
 * generated test room instead (MEM-043); an empty ?room= is the same as no param (Q23).
 * @param {typeof fetch} fetchFn
 * @param {string} [search] the page's location.search
 * @returns {Promise<Response>} the /loci response
 */
export async function demoUpload(fetchFn, search) {
  const room = new URLSearchParams(search ?? "").get("room");
  const url = room ? `/demo/photo.jpg?room=${encodeURIComponent(room)}` : "/demo/photo.jpg";
  const demo = await fetchFn(url);
  if (!demo.ok) throw new HttpStatusError(httpStatusText(demo.status));
  return postLoci(fetchFn, await demo.arrayBuffer());
}

/**
 * Stale-response gate: only the most recently issued token is current.
 * @returns {{next: () => number, isCurrent: (token: number) => boolean}}
 */
export function latestOnly() {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (token) => token === latest,
  };
}

/** @param {string} id */
function byId(id) {
  return document.getElementById(id);
}

/**
 * Re-encode in the browser: canvas output drops EXIF (incl. GPS) and bakes in the orientation.
 * @param {File} file
 * @returns {Promise<Blob>}
 */
async function reencodeJpeg(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))), "image/jpeg", 0.9);
  });
}

/**
 * @param {string} src
 * @returns {Promise<HTMLImageElement>} the image once decoded
 */
async function loadImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/**
 * Page seams the upload flow uses; injected so node --test can drive the real flow.
 * @typedef {{
 *   doc: Pick<Document, "getElementById" | "createElement">,
 *   loadImage: (src: string) => Promise<CanvasImageSource>,
 *   fetch: typeof fetch,
 *   encode: (file: File) => Promise<BodyInit>,
 *   place?: ReturnType<typeof createPlaceState>,
 *   geolocate?: () => Promise<{lat: number, lon: number} | null>,
 * }} UploadDeps
 */

/**
 * @param {LociResponse} payload
 * @param {() => boolean} isCurrent re-checked after the async decode, so a newer upload wins
 * @param {UploadDeps} deps
 * @returns {Promise<boolean>} whether the result was drawn
 */
async function drawResult(payload, isCurrent, deps) {
  const canvas = /** @type {HTMLCanvasElement | null} */ (deps.doc.getElementById("scene"));
  const list = deps.doc.getElementById("loci");
  if (!canvas || !list) return false;
  const img = await deps.loadImage(payload.image);
  if (!isCurrent()) return false;
  const maxW = canvas.parentElement ? canvas.parentElement.clientWidth : payload.width;
  const scale = fitScale(payload.width, payload.height, maxW);
  canvas.width = Math.round(payload.width * scale);
  canvas.height = Math.round(payload.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 3;
  // Under half scale (a phone) full-size badges of neighbouring loci overlap, so they shrink.
  const small = scale < 0.5;
  const [bw, bh, padX, padY] = small ? [18, 16, 2, 2] : [28, 24, 4, 3];
  ctx.font = small ? "bold 12px sans-serif" : "bold 18px sans-serif";
  ctx.textBaseline = "top";
  list.replaceChildren();
  for (const locus of payload.loci) {
    if (locus.box) {
      const { x1, y1, x2, y2 } = locus.box;
      ctx.strokeStyle = BADGE_FILL;
      ctx.strokeRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
      ctx.fillStyle = BADGE_FILL;
      ctx.fillRect(x1 * scale, y1 * scale, bw, bh);
      ctx.fillStyle = BADGE_TEXT;
      ctx.fillText(String(locus.n), x1 * scale + padX, y1 * scale + padY);
    }
    // Label only: the <ol id="loci"> marker supplies the number, matching the canvas badge.
    const item = deps.doc.createElement("li");
    item.textContent = locus.label;
    list.append(item);
  }
  // Never un-hidden: once a palace has been drawn the empty state is gone for the session.
  const empty = deps.doc.getElementById("empty-state");
  if (empty) empty.hidden = true;
  return true;
}

// One gate for every upload source, so a photo pick and "Load demo" never race each other.
const uploads = latestOnly();

/**
 * @param {() => Promise<Response>} send
 * @param {string} failure status text when the photo cannot be read or sent
 * @param {UploadDeps} deps
 */
export async function showUpload(send, failure, deps) {
  const status = deps.doc.getElementById("upload-status");
  if (!status) return;
  const token = uploads.next();
  const isCurrent = () => uploads.isCurrent(token);
  status.textContent = "Finding places in your photo...";
  // Clear the previous result up front, so a failed upload never leaves the old photo on screen.
  const canvas = /** @type {HTMLCanvasElement | null} */ (deps.doc.getElementById("scene"));
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
  const list = deps.doc.getElementById("loci");
  if (list) list.replaceChildren();
  try {
    const resp = await send();
    const payload = await resp.json().catch(() => null);
    if (!isCurrent()) return;
    if (!resp.ok) {
      const code = payload && typeof payload.error === "string" ? payload.error : httpStatusText(resp.status);
      // A demo (fixture-mode) server only replays the demo photo, so point at the one thing that works.
      status.textContent =
        code === "fixture_missing"
          ? "Upload failed: this demo server only knows its demo photo. Use Load demo instead."
          : `Upload failed: ${code}`;
      return;
    }
    if (payload === null) {
      status.textContent = "Upload failed: unreadable response from the server";
      return;
    }
    if (await drawResult(payload, isCurrent, deps)) status.textContent = `Found ${payload.loci.length} places`;
  } catch (err) {
    if (isCurrent()) status.textContent = `Upload failed: ${err instanceof HttpStatusError ? err.message : failure}`;
  }
}

/**
 * Photo input change handler.
 * @param {{files: ArrayLike<File> | null, value: string}} input
 * @param {UploadDeps} deps
 * @returns {Promise<void> | undefined}
 */
export function onPhotoChange(input, deps) {
  const file = input.files && input.files[0];
  // Clear the value so re-picking the same photo fires change again.
  input.value = "";
  if (!file) return undefined;
  const place = deps.place;
  // Opt-in only (MEM-025): with the toggle off neither the GPS nor the location is ever read.
  if (place && place.enabled()) {
    const geolocate = deps.geolocate;
    // GPS from the ORIGINAL bytes: the re-encode below strips EXIF (ADR 0009, 0022).
    const coords = async () =>
      readGps(new Uint8Array(await file.arrayBuffer())) ?? (geolocate ? await geolocate() : null);
    void lookupPlace(coords, { doc: deps.doc, fetch: deps.fetch, place });
  }
  return showUpload(
    async () => postLoci(deps.fetch, await deps.encode(file)),
    "could not read or send the photo",
    deps,
  );
}

/**
 * Opt-in place lookup for "Load demo" (MEM-025).
 * @param {Pick<UploadDeps, "doc" | "fetch" | "place">} deps
 */
export function lookupDemoPlace(deps) {
  const place = deps.place;
  if (!place || !place.enabled()) return;
  // The demo photo is EXIF-free (MEM-005), so a sidecar stands in for its GPS.
  const coords = async () => {
    const resp = await deps.fetch("/demo/place.json");
    return resp.ok ? resp.json() : null;
  };
  void lookupPlace(coords, { doc: deps.doc, fetch: deps.fetch, place });
}

/**
 * "Load demo" handler with the upload-only flow (the page runs flow.js's full demo palace).
 * @param {UploadDeps} deps
 */
export function onLoadDemo(deps) {
  lookupDemoPlace(deps);
  const send = () => demoUpload(deps.fetch, globalThis.location?.search);
  return showUpload(send, "could not load the demo photo", deps);
}

/** KAVE COGS channels, in the order the association panel shows them (MEM-022). */
export const KAVE_CHANNELS = Object.freeze([
  "kinesthetic",
  "auditory",
  "visual",
  "emotional",
  "conceptual",
  "olfactory",
  "gustatory",
  "spatial",
]);

/**
 * @typedef {{item: string, locus: {n: number, label: string}}} AssocPair
 * @typedef {{record: Record<string, string>, status: "valid" | "invalid", sig?: string}} AssocEntry
 * @typedef {{
 *   doc: Pick<Document, "getElementById" | "createElement">,
 *   fetch: typeof fetch,
 *   store: ReturnType<typeof import("./palace_store.js").createPalaceStore>,
 *   image?: string,
 *   place?: ReturnType<typeof createPlaceState>,
 * }} AssocDeps
 */

/**
 * One POST /associate (S3b contract: body {image, item, locus}; locus is the short label), plus
 * `place` {title, extract} only when one is typed or confirmed (MEM-025); coords never ride here.
 * Throws on a network error or non-2xx, so the caller stores nothing for that pair.
 * @param {AssocPair} pair
 * @param {AssocDeps} deps
 * @returns {Promise<AssocEntry>}
 */
async function requestAssociation(pair, deps) {
  /** @type {{image?: string, item: string, locus: string, place?: {title: string, extract: string}}} */
  const body = { image: deps.image, item: pair.item, locus: pair.locus.label };
  const place = deps.place ? deps.place.current() : null;
  if (place) body.place = place;
  const resp = await deps.fetch("/associate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(payload && typeof payload.error === "string" ? payload.error : `http_${resp.status}`);
  }
  if (!payload || typeof payload.record !== "object" || payload.record === null) throw new Error("bad_response");
  /** @type {AssocEntry} */
  const entry = { record: payload.record, status: payload.status === "valid" ? "valid" : "invalid" };
  // Kept beside the record, never inside it: the server signed the record as sent (MEM-036).
  if (typeof payload.sig === "string") entry.sig = payload.sig;
  return entry;
}

/**
 * @param {AssocDeps["doc"]} doc
 * @param {string} tag
 * @param {unknown} text
 */
function textEl(doc, tag, text) {
  const e = doc.createElement(tag);
  e.textContent = text == null ? "" : String(text);
  return e;
}

/**
 * Panel card: item and locus, the 8 channels in KAVE order, then the D16 question and answer.
 * @param {AssocPair} pair
 * @param {AssocEntry | null} entry null when generation failed
 * @param {string} failure
 * @param {AssocDeps["doc"]} doc
 */
function associationCard(pair, entry, failure, doc) {
  const card = doc.createElement("section");
  card.append(textEl(doc, "h3", `${pair.locus.n}. ${pair.item} at ${pair.locus.label}`));
  if (!entry) {
    card.append(textEl(doc, "p", `Could not generate: ${failure}`));
    return card;
  }
  if (entry.status !== "valid") card.append(textEl(doc, "p", "Needs regeneration"));
  const list = doc.createElement("dl");
  for (const channel of KAVE_CHANNELS) {
    list.append(textEl(doc, "dt", channel), textEl(doc, "dd", entry.record[channel]));
  }
  card.append(list, textEl(doc, "p", entry.record.question), textEl(doc, "p", entry.record.answer));
  return card;
}

/**
 * Generate associations one pair at a time, saving each record the moment it arrives. A resume
 * reuses valid stored records and regenerates only missing or invalid ones.
 * @param {AssocPair[]} pairs
 * @param {AssocDeps} deps
 */
export async function runAssociations(pairs, deps) {
  const status = deps.doc.getElementById("assoc-status");
  const panel = deps.doc.getElementById("associations");
  if (!status || !panel) return;
  panel.replaceChildren();
  // The server rejects every request without a photo, so fail fast instead of N doomed POSTs.
  if (!deps.image) {
    status.textContent = "Upload a photo before generating associations.";
    return;
  }
  let done = 0;
  let failed = 0;
  const showProgress = () => {
    status.textContent = `${done} of ${pairs.length}` + (failed ? ` (${failed} failed)` : "");
  };
  showProgress();
  for (const pair of pairs) {
    const key = associationKey(pair.item, pair.locus.label);
    /** @type {AssocEntry | null} */
    let entry = await deps.store.get(key);
    let failure = "";
    if (!entry || entry.status !== "valid") {
      try {
        const fresh = await requestAssociation(pair, deps);
        await deps.store.put(key, fresh);
        entry = fresh;
      } catch (err) {
        // Keep a stored invalid record visible; a failed regeneration must not hide it.
        failure = err instanceof Error ? err.message : "unknown";
        if (!entry) failed += 1;
      }
    }
    if (entry) done += 1;
    panel.append(associationCard(pair, entry, failure, deps.doc));
    showProgress();
  }
}

function wireUpload() {
  // Bound: an unbound window.fetch called as deps.fetch throws "Illegal invocation".
  /** @type {UploadDeps} */
  const place = createPlaceState({
    // Lazy: merely touching window.localStorage throws where storage is disabled.
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, v) => localStorage.setItem(k, v),
  });
  wirePlace(document, place);
  const deps = {
    doc: document,
    loadImage,
    fetch: fetch.bind(globalThis),
    encode: reencodeJpeg,
    place,
    geolocate: browserGeolocate,
  };
  const input = /** @type {HTMLInputElement | null} */ (byId("photo"));
  if (input) input.addEventListener("change", () => onPhotoChange(input, { ...deps, fetch: withPasscode(deps.fetch, document) }));
  return deps;
}

// Guard keeps the module importable under node --test.
if (typeof document !== "undefined") {
  const media = navigator.mediaDevices;
  // Distinct databases: createIdbAdapter only creates its object store on a database's first open.
  const palace = { dbName: "memripal-palace", storeName: "palace", prefix: "memripal.palace:" };
  const rehearsal = { dbName: "memripal-rehearsals", storeName: "rehearsals", prefix: "memripal.rehearsal:" };
  const palaceAdapter = selectStore(globalThis, palace);
  const rehearsalAdapter = selectStore(globalThis, rehearsal);
  // Pre-IndexedDB records move over before wireApp renders history (MEM-039); without IndexedDB the
  // localStorage fallback keeps serving them. Lazy: touching localStorage throws where it is disabled.
  const migrated = globalThis.indexedDB
    ? Promise.all([
        migrateLocalStorage(() => localStorage, palace.prefix, palaceAdapter),
        migrateLocalStorage(() => localStorage, rehearsal.prefix, rehearsalAdapter),
      ])
    : Promise.resolve();
  void migrated.then(() =>
    wireApp({
      ...wireUpload(),
      store: createPalaceStore(palaceAdapter),
      rehearsals: createRehearsalStore(rehearsalAdapter),
      getUserMedia: media ? media.getUserMedia.bind(media) : undefined,
      AudioContext: globalThis.AudioContext || /** @type {any} */ (globalThis).webkitAudioContext,
      location,
      confirm: () => window.confirm("Delete this rehearsal?"),
    }),
  );
}
