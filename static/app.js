// @ts-check
// MemriPal frontend: backend health plus photo upload -> numbered memory loci (MEM-017).
// Served as a raw ES module (no build step). Model-derived text is only ever set via textContent.

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

/**
 * Upload the server's demo photo byte-for-byte: a browser re-encode would change the processed
 * sha and miss the fixture replay ("fixture_missing").
 * @param {typeof fetch} fetchFn
 * @returns {Promise<Response>} the /loci response
 */
export async function demoUpload(fetchFn) {
  const demo = await fetchFn("/demo/photo.jpg");
  if (!demo.ok) throw new Error(`http_${demo.status}`);
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

async function showHealth() {
  const el = byId("status");
  if (!el) return;
  try {
    const resp = await fetch("/healthz");
    const health = resp.ok ? await resp.json() : null;
    el.textContent = formatHealth(health);
    // The privacy notice only applies when the photo actually leaves for Meta's APIs.
    const notice = byId("meta-notice");
    if (notice && health && health.mode === "meta") notice.hidden = false;
  } catch {
    el.textContent = formatHealth(null);
  }
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
  ctx.font = "bold 18px sans-serif";
  ctx.textBaseline = "top";
  list.replaceChildren();
  for (const locus of payload.loci) {
    if (locus.box) {
      const { x1, y1, x2, y2 } = locus.box;
      ctx.strokeStyle = "#ff3b30";
      ctx.strokeRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
      ctx.fillStyle = "#ff3b30";
      ctx.fillRect(x1 * scale, y1 * scale, 28, 24);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(String(locus.n), x1 * scale + 4, y1 * scale + 3);
    }
    // Label only: the <ol id="loci"> marker supplies the number, matching the canvas badge.
    const item = deps.doc.createElement("li");
    item.textContent = locus.label;
    list.append(item);
  }
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
      const code = payload && typeof payload.error === "string" ? payload.error : `http_${resp.status}`;
      status.textContent = `Upload failed: ${code}`;
      return;
    }
    if (await drawResult(payload, isCurrent, deps)) status.textContent = `Found ${payload.loci.length} places`;
  } catch {
    if (isCurrent()) status.textContent = `Upload failed: ${failure}`;
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
  return showUpload(
    async () => postLoci(deps.fetch, await deps.encode(file)),
    "could not read or send the photo",
    deps,
  );
}

/**
 * "Load demo" click handler.
 * @param {UploadDeps} deps
 */
export function onLoadDemo(deps) {
  return showUpload(() => demoUpload(deps.fetch), "could not load the demo photo", deps);
}

function wireUpload() {
  // Bound: an unbound window.fetch called as deps.fetch throws "Illegal invocation".
  /** @type {UploadDeps} */
  const deps = { doc: document, loadImage, fetch: fetch.bind(globalThis), encode: reencodeJpeg };
  const input = /** @type {HTMLInputElement | null} */ (byId("photo"));
  if (input) input.addEventListener("change", () => onPhotoChange(input, deps));
  const demo = byId("load-demo");
  if (demo) demo.addEventListener("click", () => onLoadDemo(deps));
}

// Guard keeps the module importable under node --test.
if (typeof document !== "undefined") {
  showHealth();
  wireUpload();
}
