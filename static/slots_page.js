// @ts-check
// Landmark slots page (MEM-132): upload a landmark photo, SAM 3.1 segments it via POST /loci, place the Payoff
// parts. Shows the cached or bundled sample on load so the page is never empty.
import { withApiBase } from "./api_base.js";
import { PAYOFF_PARTS, createSlotBoard, fallbackResult, segmentLandmark } from "./landmark_slots.js";

const LANDMARK_ID = "kendall";
const FIXTURE_URL = "./fixtures/landmark_slots_kendall.json";

/** sticker_drag.js may be absent from this deploy; tap-to-place works without it. */
async function loadDrag() {
  const mod = await import("./sticker_drag.js").catch(() => null);
  if (!mod || typeof mod.wireDrag !== "function" || typeof mod.nearestBox !== "function") return {};
  return {
    wireDrag: mod.wireDrag,
    // sticker_drag takes (x, y, boxes); the board passes (boxes, x, y) and wants an index.
    nearestBox: (boxes, x, y) => {
      const hit = mod.nearestBox(x, y, boxes);
      return typeof hit === "number" ? hit : boxes.indexOf(hit);
    },
  };
}

async function start() {
  const root = document.getElementById("slots");
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById("slots-photo"));
  const status = document.getElementById("slots-status");
  if (!root || !input || !status) return;
  const board = createSlotBoard({ doc: document, root, parts: PAYOFF_PARTS, ...(await loadDrag()) });
  const storage = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();
  const opts = { fetch: withApiBase(fetch.bind(globalThis)), storage, landmarkId: LANDMARK_ID, fixtureUrl: FIXTURE_URL };

  const initial = await fallbackResult(opts);
  if (initial) board.show(initial);
  status.textContent = initial ? "Upload your own photo to segment it live." : "Upload a photo to begin.";

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    input.disabled = true;
    status.textContent = "Segmenting with SAM 3.1...";
    const result = await segmentLandmark({ ...opts, file });
    input.disabled = false;
    if (!result) {
      status.textContent = "Could not segment that photo. Try again.";
      return;
    }
    board.show(result);
    status.textContent =
      result.source === "live" ? "Tap a part, then tap a slot (or drag it)." : "Live segmentation unavailable; showing a saved result.";
  });
}

start();
