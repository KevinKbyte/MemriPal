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
 * @param {{n: number, label: string}} locus
 * @returns {string}
 */
export function locusCaption({ n, label }) {
  return `${n}. ${label}`;
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
 * @param {LociResponse} payload
 */
async function drawResult(payload) {
  const canvas = /** @type {HTMLCanvasElement | null} */ (byId("scene"));
  const list = byId("loci");
  if (!canvas || !list) return;
  const img = new Image();
  img.src = payload.image;
  await img.decode();
  const maxW = canvas.parentElement ? canvas.parentElement.clientWidth : payload.width;
  const scale = fitScale(payload.width, payload.height, maxW);
  canvas.width = Math.round(payload.width * scale);
  canvas.height = Math.round(payload.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
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
    const item = document.createElement("li");
    item.textContent = locusCaption(locus);
    list.append(item);
  }
}

/**
 * @param {File} file
 */
async function upload(file) {
  const status = byId("upload-status");
  if (!status) return;
  status.textContent = "Finding places in your photo...";
  try {
    const body = await reencodeJpeg(file);
    const resp = await fetch("/loci", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok) {
      const code = payload && typeof payload.error === "string" ? payload.error : `http_${resp.status}`;
      status.textContent = `Upload failed: ${code}`;
      return;
    }
    await drawResult(payload);
    status.textContent = `Found ${payload.loci.length} places`;
  } catch {
    status.textContent = "Upload failed: could not read or send the photo";
  }
}

function wireUpload() {
  const input = /** @type {HTMLInputElement | null} */ (byId("photo"));
  if (!input) return;
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (file) upload(file);
  });
}

// Guard keeps the module importable under node --test.
if (typeof document !== "undefined") {
  showHealth();
  wireUpload();
}
