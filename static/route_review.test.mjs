// Covers: MEM-081
// Requirement: the Load-demo route review reorders by dragging a row's grip (or its keyboard
// equivalent) and removes a place only through Edit -> trash -> Remove, with an Undo snackbar;
// no Up/Down/Drop buttons remain. The reviewed order is what Generate saves.
// Contract (RED; GREEN implements):
//   static/route_review.js exports createRouteReview(loci) (encode.js re-exports it) and
//   dropSlot(midpoints, clientY) -> count of midpoints < clientY. createRouteReview gains
//   moveTo(from, to) -> true on a real move; false when either index is out of range or from === to.
//   Rows: li.route-row in #route = grip button.route-grip (data-action "drag", aria-label
//   "Reorder <label>"), span.route-label, and only while #route-edit is pressed a
//   button.route-trash (data-action "drop", aria-label "Remove <label>").
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { fakePage, find, findAll, jsonResponse, memoryAdapter, record, settle, until } from "./fake_dom_test.mjs";
import { createPalaceStore } from "./palace_store.js";

const rr = await import("./route_review.js").catch((err) => ({ __missing: String(err) }));
const encode = await import("./encode.js").catch((err) => ({ __missing: String(err) }));

function api(mod, name, file) {
  assert.equal(typeof mod[name], "function", `static/${file} must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const LABELS = ["lamp", "door", "clock"];
const LOCI = LABELS.map((label, i) => ({ n: i + 1, label, box: { x1: 10 + i * 200, y1: 10, x2: 150 + i * 200, y2: 200 } }));
const POINTS = ["milk", "eggs", "bread"].map((label) => ({ label, source_quote: `Buy ${label}` }));
const IDS = [
  "route-review", "route", "route-edit", "route-live", "route-toast", "route-toast-text", "route-undo", "generate",
  "auto", "walk", "walk-prev", "walk-next", "walk-step", "scenes", "scene-overlay", "assoc-status", "associations",
  "upload-status", "scene", "loci", "status",
];
const ROW_H = 50;

const hasClass = (n, c) =>
  Boolean(n && typeof n === "object") &&
  (n.classList.contains(c) || String(n.className ?? "").split(/\s+/).includes(c) || String(n.getAttribute("class") ?? "").split(/\s+/).includes(c));
const rows = (p) => p.els.route.children.filter((c) => typeof c === "object" && c.tagName === "LI" && !c.hidden);
const labelOf = (li) => find(li, (n) => hasClass(n, "route-label"))?.textContent ?? "";
const order = (p) => rows(p).map(labelOf);
const rowOf = (p, label) => rows(p).find((li) => labelOf(li) === label);
const button = (root, action) => find(root, (n) => n.tagName === "BUTTON" && n.dataset.action === action, { visibleOnly: true });
const grip = (li) => button(li, "drag");

/** Live layout: each #route row is ROW_H tall at its current DOM index (re-read on every call). */
function layOut(p) {
  p.layout.rectOf = (el) => {
    const i = el.parent ? el.parent.children.indexOf(el) : -1;
    if (el.tagName !== "LI" || el.parent !== p.els.route || i < 0) return {};
    return { top: i * ROW_H, bottom: (i + 1) * ROW_H, height: ROW_H, left: 0, right: 300, width: 300, x: 0, y: i * ROW_H };
  };
}

function flowFetch() {
  return async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url === "/associate") return jsonResponse({ record: record(body.item, body.locus), status: "valid", sig: `sig_${body.item}` });
    if (url === "/scenes") return jsonResponse({ tier: 3, reason: "timeout" });
    return jsonResponse({ error: "not_found" }, 404);
  };
}

/** Starts a reviewed runEncode; resolves once the 3 rows show. */
async function openReview() {
  const p = fakePage(IDS, { hidden: ["route-review", "route-toast", "walk", "scene-overlay"] });
  const adapter = memoryAdapter();
  const store = createPalaceStore(adapter);
  const input = { image: IMAGE, loci: structuredClone(LOCI), points: structuredClone(POINTS), auto: false };
  const run = api(encode, "runEncode", "encode.js")(input, { doc: p.doc, fetch: flowFetch(), store });
  await until(() => rows(p).length === 3, "3 route rows listed");
  layOut(p);
  const generate = async () => {
    p.fire(p.els.generate, "click");
    await run;
    return (await createPalaceStore(adapter).loadRoute()).map((l) => l.label);
  };
  return { p, generate };
}

const press = (p, el, key) => p.fire(el, "keydown", { key, code: key, preventDefault() {} });
const ptr = (clientY) => ({ clientY, clientX: 20, pageY: clientY, pointerId: 1, button: 0, isPrimary: true, pointerType: "mouse" });
const editOn = (p) => p.fire(p.els["route-edit"], "click");

// Covers: MEM-081
// Requirement: the route review model moves a place straight to any slot (moveTo), refusing an
// out-of-range index or a no-op move; encode.js keeps exporting the same createRouteReview.
describe("createRouteReview.moveTo (MEM-081)", () => {
  const labels = (r) => r.order().map((l) => l.label);
  const make = () => api(rr, "createRouteReview", "route_review.js")(structuredClone(LOCI));

  test("moveTo carries a place to any slot, both directions", () => {
    const r = make();
    assert.equal(r.moveTo(0, 2), true);
    assert.deepEqual(labels(r), ["door", "clock", "lamp"]);
    assert.equal(r.moveTo(2, 0), true);
    assert.deepEqual(labels(r), LABELS);
    assert.equal(r.moveTo(2, 1), true);
    assert.deepEqual(labels(r), ["lamp", "clock", "door"]);
  });

  test("moveTo refuses from === to and any out-of-range or non-integer index, changing nothing", () => {
    const r = make();
    for (const [from, to] of [[1, 1], [-1, 0], [0, -1], [3, 0], [0, 3], [0.5, 1], [Number.NaN, 0]]) {
      assert.equal(r.moveTo(from, to), false, `moveTo(${from}, ${to})`);
    }
    assert.deepEqual(labels(r), LABELS);
    const empty = api(rr, "createRouteReview", "route_review.js")([]);
    assert.equal(empty.moveTo(0, 0), false);
  });

  test("moveTo never mutates the input array; move/drop/undo still work after it", () => {
    const loci = structuredClone(LOCI);
    const r = api(rr, "createRouteReview", "route_review.js")(loci);
    r.moveTo(0, 2);
    assert.deepEqual(loci, LOCI);
    assert.equal(r.move(0, 1), true);
    assert.deepEqual(labels(r), ["clock", "door", "lamp"]);
    r.requestDrop(0);
    assert.equal(r.confirmDrop(), true);
    assert.equal(r.canUndo(), true);
    assert.equal(r.undo(), true);
    assert.deepEqual(labels(r), ["clock", "door", "lamp"]);
  });

  test("encode.js re-exports route_review.js's createRouteReview", () => {
    assert.equal(api(encode, "createRouteReview", "encode.js"), api(rr, "createRouteReview", "route_review.js"));
  });
});

// Covers: MEM-081
// Requirement: while dragging, the drop slot is the number of other rows whose vertical midpoint
// lies above the pointer (strictly less than clientY), so the row lands where the finger is.
describe("dropSlot (MEM-081)", () => {
  const slot = (m, y) => api(rr, "dropSlot", "route_review.js")(m, y);

  test("counts midpoints strictly above clientY", () => {
    const mids = [25, 75, 125];
    assert.equal(slot(mids, 0), 0);
    assert.equal(slot(mids, 25), 0, "a midpoint equal to clientY does not count");
    assert.equal(slot(mids, 26), 1);
    assert.equal(slot(mids, 75), 1);
    assert.equal(slot(mids, 100), 2);
    assert.equal(slot(mids, 500), 3);
    assert.equal(slot(mids, -500), 0);
  });

  test("no other rows -> slot 0", () => {
    assert.equal(slot([], 40), 0);
  });

  test("for any sorted midpoints, the slot is in [0, n] and never decreases as clientY grows", () => {
    for (let n = 0; n <= 6; n++) {
      const mids = Array.from({ length: n }, (_, i) => i * 40 + 20);
      let last = 0;
      for (let y = -30; y <= n * 40 + 30; y += 7) {
        const s = slot(mids, y);
        assert.ok(Number.isInteger(s) && s >= 0 && s <= n, `slot ${s} for n=${n} y=${y}`);
        assert.ok(s >= last, `slot fell from ${last} to ${s} at y=${y}`);
        last = s;
      }
    }
  });
});

// Covers: MEM-081
// Requirement: each review row is a grip, the place label and (only in Edit mode) a trash button;
// Edit toggles aria-pressed and its text Edit/Done; no Up/Down/Drop buttons exist anywhere.
describe("route review rows and the Edit toggle (MEM-081)", () => {
  test("rows: li.route-row with a labelled grip and a label; no trash and no up/down by default", async () => {
    const { p, generate } = await openReview();
    assert.deepEqual(order(p), LABELS);
    for (const li of rows(p)) {
      const label = labelOf(li);
      assert.ok(hasClass(li, "route-row"), `${label} row has class route-row`);
      const g = grip(li);
      assert.ok(g && hasClass(g, "route-grip"), `${label} row has a .route-grip button with data-action drag`);
      assert.equal(g.getAttribute("aria-label"), `Reorder ${label}`);
      assert.equal(button(li, "drop"), null, "no trash outside Edit mode");
    }
    const legacy = findAll(p.els.route, (n) => ["up", "down"].includes(n.dataset?.action));
    assert.equal(legacy.length, 0, "no data-action up/down button remains");
    await generate();
  });

  test("Edit flips aria-pressed and Edit/Done, and shows a labelled trash per row only while pressed", async () => {
    const { p, generate } = await openReview();
    const edit = p.els["route-edit"];
    editOn(p);
    await settle();
    assert.equal(edit.getAttribute("aria-pressed"), "true");
    assert.equal(edit.textContent.trim(), "Done");
    for (const li of rows(p)) {
      const trash = button(li, "drop");
      assert.ok(trash && hasClass(trash, "route-trash"), `${labelOf(li)} row shows a .route-trash`);
      assert.equal(trash.getAttribute("aria-label"), `Remove ${labelOf(li)}`);
    }
    p.fire(edit, "click");
    await settle();
    assert.equal(edit.getAttribute("aria-pressed"), "false");
    assert.equal(edit.textContent.trim(), "Edit");
    assert.deepEqual(rows(p).map((li) => button(li, "drop")), [null, null, null]);
    await generate();
  });
});

// Covers: MEM-081
// Requirement: removing a place never happens on one tap: the trash only arms a confirm in that
// row ("Remove this place?" with Remove / Keep); Remove deletes it and shows an Undo snackbar
// naming it; Undo puts it back; leaving Edit mode or Keep cancels a pending remove.
describe("route review remove: confirm, snackbar, Undo (MEM-081)", () => {
  test("first trash tap only arms the confirm; nothing is removed", async () => {
    const { p, generate } = await openReview();
    editOn(p);
    await settle();
    p.fire(button(rowOf(p, "door"), "drop"), "click");
    await settle();
    assert.deepEqual(order(p), LABELS, "one tap on the trash must not delete");
    const row = rowOf(p, "door");
    assert.ok(hasClass(row, "confirming"), "the armed row has class confirming");
    assert.ok(row.textContent.includes("Remove this place?"), row.textContent);
    const remove = button(row, "confirm-drop");
    const keep = button(row, "cancel-drop");
    assert.equal(remove?.textContent.trim(), "Remove");
    assert.equal(keep?.textContent.trim(), "Keep");
    assert.equal(p.els["route-toast"].hidden, true, "no snackbar before anything is removed");
    await generate();
  });

  test("Remove deletes the row and shows the snackbar; Undo restores it and hides the snackbar", async () => {
    const { p, generate } = await openReview();
    editOn(p);
    await settle();
    p.fire(button(rowOf(p, "door"), "drop"), "click");
    await until(() => button(rowOf(p, "door"), "confirm-drop"), "confirm armed");
    p.fire(button(rowOf(p, "door"), "confirm-drop"), "click");
    await until(() => rows(p).length === 2, "door removed");
    assert.deepEqual(order(p), ["lamp", "clock"]);
    assert.equal(p.els["route-toast"].hidden, false, "snackbar shown after a remove");
    assert.equal(p.els["route-toast-text"].textContent, "Removed door");
    p.fire(p.els["route-undo"], "click");
    await until(() => rows(p).length === 3, "door restored by Undo");
    assert.deepEqual(order(p), LABELS);
    assert.equal(p.els["route-toast"].hidden, true, "snackbar hidden once nothing is left to undo");
    await generate();
  });

  test("Undo is a stack: two removes undo newest first; the snackbar stays while one is left", async () => {
    const { p, generate } = await openReview();
    editOn(p);
    for (const label of ["door", "clock"]) {
      await settle();
      p.fire(button(rowOf(p, label), "drop"), "click");
      await until(() => button(rowOf(p, label), "confirm-drop"), `${label} armed`);
      p.fire(button(rowOf(p, label), "confirm-drop"), "click");
      await until(() => !rowOf(p, label), `${label} removed`);
    }
    assert.deepEqual(order(p), ["lamp"]);
    assert.equal(p.els["route-toast-text"].textContent, "Removed clock");
    p.fire(p.els["route-undo"], "click");
    await until(() => rows(p).length === 2, "clock back");
    assert.deepEqual(order(p), ["lamp", "clock"]);
    assert.equal(p.els["route-toast"].hidden, false, "one remove still undoable");
    p.fire(p.els["route-undo"], "click");
    await until(() => rows(p).length === 3, "door back");
    assert.deepEqual(order(p), LABELS);
    assert.equal(p.els["route-toast"].hidden, true);
    await generate();
  });

  test("Keep cancels the armed remove", async () => {
    const { p, generate } = await openReview();
    editOn(p);
    await settle();
    p.fire(button(rowOf(p, "lamp"), "drop"), "click");
    await until(() => button(rowOf(p, "lamp"), "cancel-drop"), "armed");
    p.fire(button(rowOf(p, "lamp"), "cancel-drop"), "click");
    await settle();
    assert.deepEqual(order(p), LABELS);
    assert.ok(!hasClass(rowOf(p, "lamp"), "confirming"));
    assert.equal(button(rowOf(p, "lamp"), "confirm-drop"), null);
    assert.ok(button(rowOf(p, "lamp"), "drop"), "the trash is back");
    await generate();
  });

  test("leaving Edit mode cancels a pending confirm", async () => {
    const { p, generate } = await openReview();
    editOn(p);
    await settle();
    p.fire(button(rowOf(p, "door"), "drop"), "click");
    await until(() => button(rowOf(p, "door"), "confirm-drop"), "armed");
    p.fire(p.els["route-edit"], "click");
    await settle();
    editOn(p);
    await settle();
    assert.deepEqual(order(p), LABELS);
    assert.ok(!rows(p).some((li) => hasClass(li, "confirming")), "no row still confirming");
    assert.equal(button(rowOf(p, "door"), "confirm-drop"), null);
    assert.deepEqual(await generate(), LABELS, "leaving Edit removed nothing");
  });

  test("a removed place is not saved; Generate hides the snackbar", async () => {
    const { p, generate } = await openReview();
    editOn(p);
    await settle();
    p.fire(button(rowOf(p, "lamp"), "drop"), "click");
    await until(() => button(rowOf(p, "lamp"), "confirm-drop"), "armed");
    p.fire(button(rowOf(p, "lamp"), "confirm-drop"), "click");
    await until(() => rows(p).length === 2, "lamp removed");
    assert.equal(p.els["route-toast"].hidden, false);
    assert.deepEqual(await generate(), ["door", "clock"]);
    assert.equal(p.els["route-toast"].hidden, true, "Generate hides the snackbar");
  });
});

// Covers: MEM-081
// Requirement: the grip is keyboard operable: ArrowUp/ArrowDown move the place one step,
// Home/End to the ends; focus stays on the moved place's grip and #route-live announces
// "<label> moved to position i of N".
describe("route review keyboard reorder on the grip (MEM-081)", () => {
  test("ArrowDown moves one step, keeps focus on the moved grip and announces the position", async () => {
    const { p, generate } = await openReview();
    grip(rowOf(p, "lamp")).focus();
    press(p, grip(rowOf(p, "lamp")), "ArrowDown");
    await until(() => order(p)[1] === "lamp", "lamp moved down");
    assert.deepEqual(order(p), ["door", "lamp", "clock"]);
    assert.equal(p.doc.activeElement, grip(rowOf(p, "lamp")), "focus on lamp's grip in #route");
    assert.equal(p.els["route-live"].textContent, "lamp moved to position 2 of 3");
    // The user can keep pressing on the focused grip.
    press(p, p.doc.activeElement, "ArrowDown");
    await until(() => order(p)[2] === "lamp", "lamp moved down again");
    assert.equal(p.els["route-live"].textContent, "lamp moved to position 3 of 3");
    assert.deepEqual(await generate(), ["door", "clock", "lamp"]);
  });

  test("ArrowUp moves one step; at an end it changes nothing", async () => {
    const { p, generate } = await openReview();
    press(p, grip(rowOf(p, "clock")), "ArrowUp");
    await until(() => order(p)[1] === "clock", "clock moved up");
    assert.deepEqual(order(p), ["lamp", "clock", "door"]);
    assert.equal(p.doc.activeElement, grip(rowOf(p, "clock")));
    assert.equal(p.els["route-live"].textContent, "clock moved to position 2 of 3");
    press(p, grip(rowOf(p, "lamp")), "ArrowUp");
    await settle();
    assert.deepEqual(order(p), ["lamp", "clock", "door"], "the first place cannot move up");
    assert.deepEqual(await generate(), ["lamp", "clock", "door"]);
  });

  test("Home and End jump to the ends", async () => {
    const { p, generate } = await openReview();
    press(p, grip(rowOf(p, "clock")), "Home");
    await until(() => order(p)[0] === "clock", "clock to the top");
    assert.deepEqual(order(p), ["clock", "lamp", "door"]);
    assert.equal(p.doc.activeElement, grip(rowOf(p, "clock")));
    assert.equal(p.els["route-live"].textContent, "clock moved to position 1 of 3");
    press(p, grip(rowOf(p, "clock")), "End");
    await until(() => order(p)[2] === "clock", "clock to the bottom");
    assert.deepEqual(order(p), ["lamp", "door", "clock"]);
    assert.equal(p.els["route-live"].textContent, "clock moved to position 3 of 3");
    assert.deepEqual(await generate(), ["lamp", "door", "clock"]);
  });
});

// Covers: MEM-081
// Requirement: dragging a row's grip lifts it (li.dragging, list.is-dragging), moves it live to the
// slot under the pointer, and on release commits the new order (classes cleared); a cancelled drag
// or Escape puts every row back where it was.
describe("route review pointer drag on the grip (MEM-081)", () => {
  const dragging = (p) => rows(p).filter((li) => hasClass(li, "dragging")).map(labelOf);

  test("pointerdown lifts the row and marks the list", async () => {
    const { p, generate } = await openReview();
    const g = grip(rowOf(p, "lamp"));
    p.fire(g, "pointerdown", ptr(25));
    await settle();
    assert.deepEqual(dragging(p), ["lamp"]);
    assert.ok(hasClass(p.els.route, "is-dragging"), "#route has class is-dragging");
    p.fire(g, "pointerup", ptr(25));
    await settle();
    await generate();
  });

  test("pointermove moves the row live to the slot under the pointer; pointerup commits it", async () => {
    const { p, generate } = await openReview();
    const g = grip(rowOf(p, "lamp"));
    p.fire(g, "pointerdown", ptr(25));
    p.fire(g, "pointermove", ptr(110));
    await settle();
    assert.deepEqual(order(p), ["door", "lamp", "clock"], "past door's midpoint (75), before clock's (125)");
    p.fire(g, "pointermove", ptr(140));
    await settle();
    assert.deepEqual(order(p), ["door", "clock", "lamp"], "past every other row's midpoint");
    p.fire(g, "pointerup", ptr(140));
    await settle();
    assert.deepEqual(order(p), ["door", "clock", "lamp"]);
    assert.deepEqual(dragging(p), [], "no row left lifted");
    assert.ok(!hasClass(p.els.route, "is-dragging"), "list no longer dragging");
    assert.ok(grip(rowOf(p, "lamp")), "rows re-rendered with their grips");
    assert.deepEqual(await generate(), ["door", "clock", "lamp"], "the dragged order is saved");
  });

  test("dragging upward lands the row at the top", async () => {
    const { p, generate } = await openReview();
    const g = grip(rowOf(p, "clock"));
    p.fire(g, "pointerdown", ptr(125));
    p.fire(g, "pointermove", ptr(5));
    await settle();
    assert.deepEqual(order(p), ["clock", "lamp", "door"]);
    p.fire(g, "pointerup", ptr(5));
    await settle();
    assert.deepEqual(await generate(), ["clock", "lamp", "door"]);
  });

  test("pointercancel reverts to the original order and clears the drag classes", async () => {
    const { p, generate } = await openReview();
    const g = grip(rowOf(p, "lamp"));
    p.fire(g, "pointerdown", ptr(25));
    p.fire(g, "pointermove", ptr(140));
    await settle();
    assert.deepEqual(order(p), ["door", "clock", "lamp"], "moved live before the cancel");
    p.fire(g, "pointercancel", ptr(140));
    await settle();
    assert.deepEqual(order(p), LABELS);
    assert.deepEqual(dragging(p), []);
    assert.ok(!hasClass(p.els.route, "is-dragging"));
    assert.deepEqual(await generate(), LABELS, "a cancelled drag saves the original order");
  });

  test("Escape during a drag reverts to the original order", async () => {
    const { p, generate } = await openReview();
    const g = grip(rowOf(p, "lamp"));
    p.fire(g, "pointerdown", ptr(25));
    p.fire(g, "pointermove", ptr(110));
    await settle();
    assert.deepEqual(order(p), ["door", "lamp", "clock"]);
    press(p, g, "Escape");
    await settle();
    assert.deepEqual(order(p), LABELS);
    assert.deepEqual(dragging(p), []);
    assert.ok(!hasClass(p.els.route, "is-dragging"));
    // A stray pointerup after the revert commits nothing.
    p.fire(g, "pointerup", ptr(110));
    await settle();
    assert.deepEqual(await generate(), LABELS);
  });
});
