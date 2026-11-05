// Covers: MEM-055
// Requirement: the Pal chat bubble shows Pal's face (a decorative IMG of /static/assets/pal-still.svg, no "Pal"
// text; the button's aria-label "Open Pal chats" names it), and while the first-run tour is open (body
// data-tour-target present) it ignores click, Enter, arrow keys and drags unless the current step targets
// ".pal-bubble"; it carries aria-disabled="true" while blocked; after the tour ends it works again; the
// stylesheet also sets pointer-events: none for the blocked state.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakePage, find, settle } from "./fake_dom_test.mjs";

const mod = await import("./pal_bubble.js").catch((err) => ({ __missing: String(err) }));
const SIZE = 56;

function memStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k) };
}
function fakeChats() {
  const row = { id: "00000000-0000-4000-8000-000000000001", title: "Only" };
  return {
    async listChats() { return [{ ...row }]; },
    async getChat() { return { ...row }; },
    async createChat() { return { ...row }; },
    async renameChat() { return { ...row }; },
    async deleteChat() {},
    async reviveChat() { return { ...row }; },
    async listMessages() { return []; },
    async appendMessage(cid, m) { return { id: "m", chat_id: cid, ...m }; },
  };
}
class FakeObserver {
  static last = null;
  constructor(cb) { this.cb = cb; this.observed = []; FakeObserver.last = this; }
  observe(node, opts) { this.observed.push([node, opts]); }
  disconnect() {}
}

async function setup({ withObserver = false, tourTarget } = {}) {
  const page = fakePage(["head", "body"]);
  page.doc.head = page.els.head;
  page.doc.body = page.els.body;
  if (tourTarget !== undefined) page.els.body.dataset.tourTarget = tourTarget;
  const px = (v) => Number.parseFloat(v) || 0;
  page.layout.rectOf = (el) => {
    if (el.dataset?.pal !== "bubble") return {};
    const left = px(el.style.left);
    const top = px(el.style.top);
    return { left, top, x: left, y: top, width: SIZE, height: SIZE, right: left + SIZE, bottom: top + SIZE };
  };
  FakeObserver.last = null;
  const win = { innerWidth: 400, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  if (withObserver) win.MutationObserver = FakeObserver;
  assert.equal(typeof mod.mountPalBubble, "function", `static/pal_bubble.js must export mountPalBubble (${mod.__missing ?? "not exported"})`);
  await mod.mountPalBubble({ doc: page.doc, win, storage: memStorage(), chats: fakeChats() });
  await settle();
  const by = (pal) => find(page.els.body, (n) => n.dataset?.pal === pal);
  const bubble = by("bubble");
  assert.ok(bubble, "a data-pal=bubble element is mounted into doc.body");
  const isOpen = () => by("panel") !== null && !by("panel").hidden;
  const click = async () => { page.fire(bubble, "click"); await settle(); };
  const key = async (k) => { page.fire(bubble, "keydown", { key: k }); await settle(); };
  const drag = async (dx) => {
    const base = { pointerId: 1, button: 0, isPrimary: true, pointerType: "mouse" };
    page.fire(bubble, "pointerdown", { ...base, clientX: 200, clientY: 400 });
    page.fire(bubble, "pointermove", { ...base, clientX: 200 + dx / 2, clientY: 400 });
    page.fire(bubble, "pointermove", { ...base, clientX: 200 + dx, clientY: 400 });
    page.fire(bubble, "pointerup", { ...base, clientX: 200 + dx, clientY: 400 });
    await settle();
  };
  return { page, body: page.els.body, bubble, isOpen, click, key, drag };
}

const attrOrProp = (n, k) => n.getAttribute?.(k) ?? n[k] ?? null;

describe("Pal bubble shows Pal's face (MEM-055)", () => {
  test("no text content; one decorative IMG data-pal=face of pal-still.svg", async () => {
    const t = await setup();
    assert.equal(t.bubble.textContent, "");
    const imgs = t.bubble.children.filter((c) => typeof c === "object" && c.tagName === "IMG");
    assert.equal(imgs.length, 1, "exactly one IMG child");
    assert.equal(imgs[0].dataset.pal, "face");
    assert.equal(imgs[0].src, "/static/assets/pal-still.svg");
    assert.equal(attrOrProp(imgs[0], "alt"), "");
  });

  test('aria-label stays "Open Pal chats"', async () => {
    const t = await setup();
    assert.equal(attrOrProp(t.bubble, "aria-label"), "Open Pal chats");
  });
});

describe("Pal bubble is inert during the tour (MEM-055)", () => {
  for (const tourTarget of ["", '.tab[href="#routes"]']) {
    test(`blocked at data-tour-target=${JSON.stringify(tourTarget)}: click, Enter, arrows and drag do nothing`, async () => {
      const t = await setup({ tourTarget });
      const start = { left: t.bubble.style.left, top: t.bubble.style.top };
      await t.click();
      assert.equal(t.isOpen(), false, "click does not open");
      assert.equal(t.bubble.getAttribute("aria-expanded"), "false");
      await t.key("Enter");
      assert.equal(t.isOpen(), false, "Enter does not open");
      for (const k of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) await t.key(k);
      await t.drag(60);
      assert.deepEqual({ left: t.bubble.style.left, top: t.bubble.style.top }, start, "bubble did not move");
      assert.equal(t.isOpen(), false);
    });
  }

  test('target ".pal-bubble": click opens the panel', async () => {
    const t = await setup({ tourTarget: ".pal-bubble" });
    await t.click();
    assert.equal(t.isOpen(), true);
  });

  test("tour ends (attribute removed): click opens again", async () => {
    const t = await setup({ tourTarget: "" });
    await t.click();
    assert.equal(t.isOpen(), false);
    delete t.body.dataset.tourTarget;
    await t.click();
    assert.equal(t.isOpen(), true);
  });

  test("no tour at all: click opens (guard is inactive)", async () => {
    const t = await setup();
    await t.click();
    assert.equal(t.isOpen(), true);
  });
});

describe("Pal bubble aria-disabled follows the tour signal (MEM-055)", () => {
  test("synced at mount, observes body data-tour-target, updates on mutation", async () => {
    const t = await setup({ withObserver: true, tourTarget: "" });
    const obs = FakeObserver.last;
    assert.ok(obs, "a MutationObserver is created");
    const [node, opts] = obs.observed[0] ?? [];
    assert.equal(node, t.body);
    assert.equal(opts.attributes, true);
    assert.deepEqual(opts.attributeFilter, ["data-tour-target"]);
    assert.equal(t.bubble.getAttribute("aria-disabled"), "true", "blocked at mount");
    t.body.dataset.tourTarget = ".pal-bubble";
    obs.cb([]);
    assert.equal(t.bubble.getAttribute("aria-disabled"), null, "removed when the step targets the bubble");
    t.body.dataset.tourTarget = ".drawer-handle";
    obs.cb([]);
    assert.equal(t.bubble.getAttribute("aria-disabled"), "true");
    delete t.body.dataset.tourTarget;
    obs.cb([]);
    assert.equal(t.bubble.getAttribute("aria-disabled"), null, "removed after the tour");
  });

  test("no tour at mount: no aria-disabled", async () => {
    const t = await setup({ withObserver: true });
    assert.equal(t.bubble.getAttribute("aria-disabled"), null);
  });
});

describe("Pal bubble stylesheet is inert during the tour (MEM-055)", () => {
  test("pointer-events: none under body[data-tour-target]:not([data-tour-target=\".pal-bubble\"])", () => {
    const css = readFileSync(new URL("./pal_bubble.css", import.meta.url), "utf8");
    const m = css.match(/body\[data-tour-target\]:not\(\[data-tour-target="\.pal-bubble"\]\)\s+\.pal-bubble[^{]*\{([^}]*)\}/);
    assert.ok(m, "rule for the blocked bubble exists");
    assert.match(m[1], /pointer-events\s*:\s*none/);
  });
});

// Covers: MEM-138
// Requirement: the bubble face rule opts out of the global `img { max-width: 100% }` clamp so the 84px head crop
// keeps its full size and stays centred in the disc.
describe("Pal bubble face is not clamped by the global img max-width (MEM-138)", () => {
  test(".pal-bubble-face declares max-width: none", () => {
    const css = readFileSync(new URL("./pal_bubble.css", import.meta.url), "utf8");
    const m = css.match(/^\.pal-bubble-face\s*\{([^}]*)\}/m);
    assert.ok(m, ".pal-bubble-face rule exists");
    assert.match(m[1], /max-width\s*:\s*none/);
  });
});
