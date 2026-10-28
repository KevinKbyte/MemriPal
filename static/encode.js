// @ts-check
// Encode UI (MEM-030): route review (arrow reorder; drop = confirm, then Undo) -> generate
// (associations, resumable, then scenes) -> walk view. Lives outside app.js (near its line cap).
// Model text only ever reaches the page via textContent; image srcs pass isSafeImageSrc.

import { KAVE_CHANNELS, demoUpload, runAssociations, showUpload } from "./app.js";
import { associationKey } from "./palace_store.js";
import { runScenes, sceneView } from "./scenes.js";

/**
 * @typedef {{x1: number, y1: number, x2: number, y2: number}} Box
 * @typedef {{n: number, label: string, box?: Box}} Locus
 * @typedef {{label: string, source_quote?: string}} Point
 * @typedef {{item: string, locus: Locus, entry: {record: Record<string, string>, status: string} | null}} Step
 * @typedef {ReturnType<typeof import("./palace_store.js").createPalaceStore>} Store
 * @typedef {{doc: Document, fetch: typeof fetch, store: Store}} EncodeDeps
 */

/**
 * Route review state: one-step moves, a drop is only pending until confirmed, Undo is a stack.
 * @param {Locus[]} loci never mutated
 */
export function createRouteReview(loci) {
  let order = [...loci];
  /** @type {number | null} */
  let pending = null;
  /** @type {Array<{index: number, locus: Locus}>} */
  const dropped = [];
  /** @param {number} i */
  const inRange = (i) => Number.isInteger(i) && i >= 0 && i < order.length;
  return {
    order: () => [...order],
    /**
     * @param {number} i
     * @param {number} delta -1 (up) or 1 (down)
     */
    move(i, delta) {
      const j = i + delta;
      if ((delta !== 1 && delta !== -1) || !inRange(i) || !inRange(j)) return false;
      [order[i], order[j]] = [order[j], order[i]];
      // The pending index would now point at a different locus.
      pending = null;
      return true;
    },
    /** @param {number} i */
    requestDrop(i) {
      pending = inRange(i) ? i : null;
    },
    pendingDrop: () => pending,
    cancelDrop() {
      pending = null;
    },
    confirmDrop() {
      if (pending === null) return false;
      const index = pending;
      dropped.push({ index, locus: order[index] });
      order = order.filter((_, k) => k !== index);
      pending = null;
      return true;
    },
    undo() {
      const last = dropped.pop();
      if (!last) return false;
      order = [...order.slice(0, last.index), last.locus, ...order.slice(last.index)];
      pending = null;
      return true;
    },
    canUndo: () => dropped.length > 0,
  };
}

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {unknown} text
 */
function textEl(doc, tag, text) {
  const e = doc.createElement(tag);
  e.textContent = text == null ? "" : String(text);
  return e;
}

/**
 * @param {Document} doc
 * @param {string} action data-action, the stable hook tests and styles use
 * @param {string} text
 * @param {string} label accessible name naming the locus
 * @param {() => void} onClick
 */
function actionButton(doc, action, text, label, onClick) {
  const b = /** @type {HTMLButtonElement} */ (doc.createElement("button"));
  b.type = "button";
  b.dataset.action = action;
  b.textContent = text;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Show the review list; resolves with the reviewed order once Generate is clicked. Page-root
 * handlers are assigned (not added), so a newer run replaces an older one's.
 * @param {Locus[]} loci
 * @param {Document} doc
 * @returns {Promise<Locus[]>}
 */
function reviewRoute(loci, doc) {
  const panel = doc.getElementById("route-review");
  const list = doc.getElementById("route");
  const undo = doc.getElementById("route-undo");
  const generate = doc.getElementById("generate");
  const review = createRouteReview(loci);
  if (!panel || !list || !generate) return Promise.resolve(review.order());
  const render = () => {
    const all = review.order();
    list.replaceChildren(
      ...all.map((locus, i) => {
        const li = doc.createElement("li");
        li.append(textEl(doc, "span", locus.label));
        /** @param {() => unknown} change */
        const act = (change) => () => {
          change();
          render();
        };
        if (review.pendingDrop() === i) {
          li.append(
            textEl(doc, "span", " Drop this place?"),
            actionButton(doc, "confirm-drop", "Confirm drop", `Confirm drop of ${locus.label}`, act(() => review.confirmDrop())),
            actionButton(doc, "cancel-drop", "Cancel", `Keep ${locus.label}`, act(() => review.cancelDrop())),
          );
        } else {
          const up = actionButton(doc, "up", "Up", `Move ${locus.label} up`, act(() => review.move(i, -1)));
          const down = actionButton(doc, "down", "Down", `Move ${locus.label} down`, act(() => review.move(i, 1)));
          up.disabled = i === 0;
          down.disabled = i === all.length - 1;
          li.append(up, down, actionButton(doc, "drop", "Drop", `Drop ${locus.label}`, act(() => review.requestDrop(i))));
        }
        return li;
      }),
    );
    if (undo) undo.hidden = !review.canUndo();
  };
  if (undo) {
    undo.onclick = () => {
      review.undo();
      render();
    };
  }
  render();
  panel.hidden = false;
  return new Promise((resolve) => {
    generate.onclick = () => {
      generate.onclick = null;
      panel.hidden = true;
      if (undo) undo.hidden = true;
      resolve(review.order());
    };
  });
}

/**
 * Walk view: one step at a time with prev/next, each showing item, locus, scene and channels.
 * @param {Step[]} steps
 * @param {Array<import("./scenes.js").SceneResult | null>} scenes
 * @param {Document} doc
 */
function showWalk(steps, scenes, doc) {
  const walk = doc.getElementById("walk");
  const stepEl = doc.getElementById("walk-step");
  const prev = /** @type {HTMLButtonElement | null} */ (doc.getElementById("walk-prev"));
  const next = /** @type {HTMLButtonElement | null} */ (doc.getElementById("walk-next"));
  const overlay = doc.getElementById("scene-overlay");
  if (!walk || !stepEl) return;
  let at = 0;
  const show = () => {
    if (prev) prev.disabled = at === 0;
    if (next) next.disabled = at >= steps.length - 1;
    if (steps.length === 0) {
      stepEl.replaceChildren(textEl(doc, "p", "Nothing to walk: no notes were paired with places."));
      return;
    }
    const s = steps[at];
    const parts = [
      textEl(doc, "p", `Step ${at + 1} of ${steps.length}.`),
      textEl(doc, "h3", `${s.item} at ${s.locus.label}`),
      sceneView(doc, scenes[at] ?? null, s.locus.box, overlay),
    ];
    if (s.entry) {
      if (s.entry.status !== "valid") parts.push(textEl(doc, "p", "Needs regeneration"));
      const channels = doc.createElement("dl");
      for (const c of KAVE_CHANNELS) channels.append(textEl(doc, "dt", c), textEl(doc, "dd", s.entry.record[c]));
      parts.push(channels, textEl(doc, "p", s.entry.record.question), textEl(doc, "p", s.entry.record.answer));
    } else {
      parts.push(textEl(doc, "p", "Could not generate this association."));
    }
    stepEl.replaceChildren(...parts);
  };
  if (prev) {
    prev.onclick = () => {
      if (at > 0) at -= 1;
      show();
    };
  }
  if (next) {
    next.onclick = () => {
      if (at < steps.length - 1) at += 1;
      show();
    };
  }
  show();
  walk.hidden = false;
}

/**
 * Review (unless auto) -> save route -> associations -> scenes -> walk view at step 1.
 * @param {{image?: string, loci: Locus[], points: Point[], auto?: boolean}} input
 * @param {EncodeDeps} deps
 */
export async function runEncode(input, deps) {
  const { doc, store } = deps;
  const loci = Array.isArray(input.loci) ? input.loci : [];
  const points = (Array.isArray(input.points) ? input.points : []).filter((p) => p && typeof p.label === "string");
  // D19: auto skips the review entirely, so the flow needs zero clicks.
  const order = input.auto ? [...loci] : await reviewRoute(loci, doc);
  await store.saveRoute(order);
  const pairs = order.slice(0, points.length).map((locus, i) => ({ item: points[i].label, locus }));
  await runAssociations(pairs, { doc, fetch: deps.fetch, store, image: input.image });
  const entries = await Promise.all(pairs.map((p) => store.get(associationKey(p.item, p.locus.label))));
  /** @type {Step[]} */
  const steps = pairs.map((p, i) => ({ ...p, entry: entries[i] ?? null }));
  const scenes = await runScenes(steps, { doc, fetch: deps.fetch, image: input.image });
  showWalk(steps, scenes, doc);
}

/** @param {Response} resp */
export async function errorCode(resp) {
  const payload = await resp.json().catch(() => null);
  return payload && typeof payload.error === "string" ? payload.error : `http_${resp.status}`;
}

/**
 * "Load demo" end to end: demo photo -> /loci -> demo notes -> /split -> runEncode. A failed step
 * writes #upload-status and stops; never throws.
 * @param {{auto?: boolean}} opts
 * @param {EncodeDeps & {loadImage: (src: string) => Promise<CanvasImageSource>}} deps
 * @returns {Promise<Point[] | undefined>} the /split points once the walk view shows, for recall
 */
export async function runDemoPalace(opts, deps) {
  const status = deps.doc.getElementById("upload-status");
  /** @param {string} text */
  const say = (text) => {
    if (status) status.textContent = text;
  };
  try {
    /** @type {Response | null} */
    let lociResp = null;
    // showUpload owns the /loci status text and drawing; a clone keeps the payload for the rest.
    const send = async () => {
      const resp = await demoUpload(deps.fetch);
      lociResp = resp.clone();
      return resp;
    };
    await showUpload(send, "could not load the demo photo", /** @type {any} */ (deps));
    const found = lociResp && /** @type {Response} */ (lociResp).ok ? await /** @type {Response} */ (lociResp).json().catch(() => null) : null;
    if (!found || typeof found.image !== "string" || !Array.isArray(found.loci)) return;
    say("Reading the demo notes...");
    const notes = await deps.fetch("/demo/notes.txt");
    if (!notes.ok) return say(`Demo failed: ${await errorCode(notes)}`);
    const text = await notes.text();
    say("Splitting the demo notes...");
    const split = await deps.fetch("/split", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // /split takes plain base64, not the data URL /loci returns (ADR 0019).
      body: JSON.stringify({
        photo: found.image.slice(found.image.indexOf(",") + 1),
        mode: "notes",
        text,
        loci_count: found.loci.length,
      }),
    });
    if (!split.ok) return say(`Demo failed: ${await errorCode(split)}`);
    const payload = await split.json().catch(() => null);
    if (!payload || !Array.isArray(payload.points)) return say("Demo failed: bad_response");
    say(`Found ${found.loci.length} places and ${payload.points.length} notes`);
    await runEncode({ image: found.image, loci: found.loci, points: payload.points, auto: Boolean(opts && opts.auto) }, deps);
    return payload.points;
  } catch (err) {
    say(`Demo failed: ${err instanceof TypeError ? "network" : "unexpected error"}`);
  }
}
