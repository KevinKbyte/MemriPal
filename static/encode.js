// @ts-check
// Encode UI (MEM-030): route review (route_review.js, MEM-081) -> generate (associations,
// resumable, then scenes) -> walk view. Lives outside app.js (near its line cap).
// Model text only ever reaches the page via textContent; image srcs pass isSafeImageSrc.

import { demoUpload, runAssociations, showUpload, shownChannels } from "./app.js";
import { associationKey } from "./palace_store.js";
import { reviewRoute, textEl } from "./route_review.js";
import { runScenes, sceneView } from "./scenes.js";

export { createRouteReview } from "./route_review.js";

/**
 * @typedef {{x1: number, y1: number, x2: number, y2: number}} Box
 * @typedef {{n: number, label: string, box?: Box}} Locus
 * @typedef {{label: string, source_quote?: string}} Point
 * @typedef {{item: string, locus: Locus, entry: {record: Record<string, string>, status: string} | null}} Step
 * @typedef {ReturnType<typeof import("./palace_store.js").createPalaceStore>} Store
 * @typedef {{doc: Document, fetch: typeof fetch, store: Store}} EncodeDeps
 */

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
      sceneView(doc, scenes[at] ?? null, s.locus.box, overlay, [s.item, s.locus.label].filter(Boolean).join(" at ") || "Scene"),
    ];
    if (s.entry) {
      if (s.entry.status !== "valid") parts.push(textEl(doc, "p", "Needs regeneration"));
      const channels = doc.createElement("dl");
      for (const c of shownChannels(s.entry.record)) channels.append(textEl(doc, "dt", c), textEl(doc, "dd", s.entry.record[c]));
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
  // Optional call: only a real browser lays the page out.
  walk.scrollIntoView?.({ block: "start" });
}

/**
 * Collapse the cards in panel `id` behind a Show/Hide toggle, so the walk is not buried under them;
 * the cards are kept, only hidden. The next run's replaceChildren drops the toggle with them.
 * @param {Document} doc
 * @param {string} id
 * @param {string} name what the cards are, for the toggle text
 */
function collapseCards(doc, id, name) {
  const panel = doc.getElementById(id);
  if (!panel) return;
  const cards = /** @type {HTMLElement[]} */ (Array.from(panel.children));
  if (!cards.length) return;
  const toggle = /** @type {HTMLButtonElement} */ (doc.createElement("button"));
  toggle.type = "button";
  /** @param {boolean} open */
  const set = (open) => {
    for (const card of cards) card.hidden = !open;
    toggle.textContent = `${open ? "Hide" : "Show"} ${name} (${cards.length})`;
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => set(toggle.getAttribute("aria-expanded") !== "true"));
  set(false);
  panel.prepend(toggle);
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
  // I7: a sig only verifies under the issuing instance's key; demoting makes the next run regenerate it.
  await Promise.all(
    steps.map((s, i) => {
      const r = scenes[i];
      if (!s.entry || !r || r.tier !== 3 || r.reason !== "bad_signature") return null;
      return store.put(associationKey(s.item, s.locus.label), { ...s.entry, status: "invalid" });
    }),
  );
  collapseCards(doc, "associations", "associations");
  collapseCards(doc, "scenes", "scenes");
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
      const resp = await demoUpload(deps.fetch, globalThis.location?.search);
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
