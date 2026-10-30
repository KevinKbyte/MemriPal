// Covers: MEM-044
// Requirement: F15 canvas locus badges stay readable on a 360 px phone: for the demo room (the 12
// fixture loci, 1024x768 photo) drawn into the 302 px wide #scene-wrap of a 360 px viewport, no two
// number badges overlap, each badge is at least 18x16 px, touches its own locus box and stays on the
// canvas, and each number is drawn inside its own badge. Loci 3/4/5 (the three books) crowd today.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { BADGE_FILL, BADGE_TEXT, showUpload } from "./app.js";

// The demo /loci answer in fixture mode (fixtures/demo/photo.jpg through FixtureBackend).
const DEMO = {
  width: 1024,
  height: 768,
  loci: [
    [1, "frame", 120, 40, 320, 180],
    [2, "clock", 560, 60, 660, 160],
    [3, "left book", 180, 250, 240, 420],
    [4, "middle book", 260, 270, 310, 420],
    [5, "right book", 330, 290, 380, 420],
    [6, "plant", 620, 280, 720, 420],
    [7, "lamp", 760, 140, 880, 420],
    [8, "mug", 480, 350, 560, 420],
    [9, "box", 120, 520, 300, 640],
    [10, "radio", 360, 560, 500, 640],
    [11, "vase", 560, 500, 620, 640],
    [12, "bear", 700, 530, 800, 640],
  ].map(([n, label, x1, y1, x2, y2]) => ({ n, label, box: { x1, y1, x2, y2 } })),
};

// 360 px viewport - main padding 2 * 12 - .panel border 2 * 1 - .panel padding 2 * 16.
const WRAP_360 = 302;

/** Draw the demo at wrapWidth; returns the badge rects and the badge number texts. */
async function drawDemo(wrapWidth) {
  const badges = [];
  const texts = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textBaseline: "",
    textAlign: "",
    drawImage() {},
    strokeRect() {},
    clearRect() {},
    fillRect(x, y, w, h) {
      if (this.fillStyle === BADGE_FILL) badges.push({ x, y, w, h });
    },
    fillText(t, x, y) {
      if (this.fillStyle === BADGE_TEXT) texts.push({ t: String(t), x, y });
    },
    measureText: (t) => ({ width: String(t).length * 10 }),
  };
  const canvas = { width: 0, height: 0, parentElement: { clientWidth: wrapWidth }, getContext: () => ctx };
  const list = { children: [], replaceChildren(...c) { this.children = c; }, append(...c) { this.children.push(...c); } };
  const els = { "upload-status": { textContent: "" }, scene: canvas, loci: list };
  const doc = {
    getElementById: (id) => els[id] ?? null,
    createElement: (tag) => ({ tagName: String(tag).toUpperCase(), textContent: "" }),
  };
  const body = { image: "data:image/jpeg;base64,REVNTw==", ...DEMO };
  const send = async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  await showUpload(send, "could not send", { doc, loadImage: async () => ({}), fetch: async () => { throw new Error("no fetch"); }, encode: async () => new Uint8Array() });
  assert.equal(els["upload-status"].textContent, "Found 12 places", "the demo payload was drawn");
  return { badges, texts, canvas };
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const fmt = (r) => `[${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.w.toFixed(1)}x${r.h.toFixed(1)}]`;

describe("MEM-044 F15 canvas badges at 360 px", () => {
  test("one badge per locus", async () => {
    const { badges } = await drawDemo(WRAP_360);
    assert.equal(badges.length, 12);
  });

  test("no two badges overlap for the demo layout", async () => {
    const { badges } = await drawDemo(WRAP_360);
    const hits = [];
    for (let i = 0; i < badges.length; i++) {
      for (let j = i + 1; j < badges.length; j++) {
        if (overlaps(badges[i], badges[j])) hits.push(`${i + 1}${fmt(badges[i])} x ${j + 1}${fmt(badges[j])}`);
      }
    }
    assert.deepEqual(hits, [], `overlapping badges: ${hits.join("; ")}`);
  });

  test("each badge is >= 18x16 px, on the canvas, and touches its own locus box", async () => {
    const { badges, canvas } = await drawDemo(WRAP_360);
    const scale = canvas.width / DEMO.width;
    badges.forEach((b, i) => {
      const { x1, y1, x2, y2 } = DEMO.loci[i].box;
      const box = { x: x1 * scale, y: y1 * scale, w: (x2 - x1) * scale, h: (y2 - y1) * scale };
      assert.ok(b.w >= 18 && b.h >= 16, `badge ${i + 1} ${fmt(b)} is smaller than 18x16`);
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= canvas.width && b.y + b.h <= canvas.height,
        `badge ${i + 1} ${fmt(b)} leaves the ${canvas.width}x${canvas.height} canvas`);
      const touches = b.x <= box.x + box.w && box.x <= b.x + b.w && b.y <= box.y + box.h && box.y <= b.y + b.h;
      assert.ok(touches, `badge ${i + 1} ${fmt(b)} is detached from its box ${fmt(box)}`);
    });
  });

  test("each badge number is drawn inside its own badge", async () => {
    const { badges, texts } = await drawDemo(WRAP_360);
    assert.deepEqual(texts.map((t) => t.t), DEMO.loci.map((l) => String(l.n)));
    texts.forEach((t, i) => {
      const b = badges[i];
      assert.ok(t.x >= b.x && t.x <= b.x + b.w && t.y >= b.y && t.y <= b.y + b.h,
        `number ${t.t} at (${t.x.toFixed(1)},${t.y.toFixed(1)}) is outside its badge ${fmt(b)}`);
    });
  });
});
