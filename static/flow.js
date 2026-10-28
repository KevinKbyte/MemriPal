// @ts-check
// Page flow (MEM-029..033): Load demo -> encode -> walk view, then the recall panel (typed answers,
// or the recorded demo replay), the rehearsal history with per-point hit rates, and the live
// passcode header. The one home of the page wiring app.js calls; model text only via textContent.

import { formatHealth, lookupDemoPlace } from "./app.js";
import { runDemoPalace } from "./encode.js";
import { showPublicBanner } from "./public_banner.js";
import { REPLAY_LABEL, replayRecording, startRecall } from "./recall.js";
import { createMatcher } from "./recall_match.js";
import { deleteRehearsalWithUndo, hitRates, renderSaidVsPalace } from "./rehearsals.js";

// The model routes the live server gates on the passcode (MEM-034); /demo/* fixtures stay open.
const PASSCODE_ROUTES = new Set(["/loci", "/split", "/associate", "/scenes", "/recall/audio"]);

// The demo is the only palace this page builds, so its history keys on a name that survives reloads.
const DEMO_PALACE_ID = "demo";

/**
 * @typedef {import("./rehearsals.js").Rehearsal} Rehearsal
 * @typedef {{
 *   doc: Document,
 *   fetch: typeof fetch,
 *   store: ReturnType<typeof import("./palace_store.js").createPalaceStore>,
 *   rehearsals: ReturnType<typeof import("./rehearsals.js").createRehearsalStore>,
 *   getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>,
 *   location: {hostname: string},
 *   loadImage: (src: string) => Promise<CanvasImageSource>,
 *   confirm: () => boolean | Promise<boolean>,
 *   wait?: (ms: number) => Promise<unknown>,
 *   place?: ReturnType<typeof import("./place.js").createPlaceState>,
 * }} AppDeps
 */

/**
 * Wrap fetch so a non-empty #passcode rides as X-Memripal-Passcode on the model routes only; the
 * box is read per request, so a passcode typed after load still applies.
 * @param {typeof fetch} fetchFn
 * @param {Pick<Document, "getElementById">} doc
 * @returns {typeof fetch}
 */
export function withPasscode(fetchFn, doc) {
  return (url, init = {}) => {
    const box = /** @type {HTMLInputElement | null} */ (doc.getElementById("passcode"));
    const code = box && box.value ? String(box.value) : "";
    if (!code || !PASSCODE_ROUTES.has(String(url))) return fetchFn(url, init);
    const headers = new Headers(init.headers);
    headers.set("X-Memripal-Passcode", code);
    return fetchFn(url, { ...init, headers });
  };
}

/**
 * @param {Document} doc
 * @param {typeof fetch} fetchFn
 */
async function showHealth(doc, fetchFn) {
  const el = doc.getElementById("status");
  if (!el) return;
  try {
    const resp = await fetchFn("/healthz");
    const health = resp.ok ? await resp.json() : null;
    el.textContent = formatHealth(health);
    // The privacy notice only applies when the photo actually leaves for Meta's APIs.
    const notice = doc.getElementById("meta-notice");
    if (notice && health && health.mode === "meta") notice.hidden = false;
  } catch {
    el.textContent = formatHealth(null);
  }
}

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {string} text
 */
function textEl(doc, tag, text) {
  const e = doc.createElement(tag);
  e.textContent = text;
  return e;
}

/** @param {AppDeps} deps */
export function wireApp(deps) {
  const { doc, rehearsals } = deps;
  const fetchFn = withPasscode(deps.fetch, doc);
  /** @param {string} id */
  const byId = (id) => doc.getElementById(id);
  /** @param {string} id @param {() => unknown} fn */
  const onClick = (id, fn) => {
    const e = byId(id);
    if (e) e.addEventListener("click", () => void fn());
  };
  showPublicBanner(doc, deps.location.hostname);
  void showHealth(doc, deps.fetch);

  /** @type {import("./recall.js").RecallPoint[]} */
  let points = [];
  /** @type {Awaited<ReturnType<typeof startRecall>> | null} */
  let session = null;

  const renderHistory = async () => {
    const runs = await rehearsals.list(DEMO_PALACE_ID);
    byId("rehearsals")?.replaceChildren(...runs.map(runItem));
    byId("hit-rates")?.replaceChildren(
      ...hitRates(runs).map((h) => textEl(doc, "li", `${h.label}: ${h.hits}/${h.runs}${h.chronic ? " (chronic miss)" : ""}`)),
    );
  };

  /** @param {Rehearsal} run */
  const runItem = (run) => {
    const li = doc.createElement("li");
    const got = run.points.filter((p) => p.got || p.override).length;
    const del = /** @type {HTMLButtonElement} */ (doc.createElement("button"));
    del.type = "button";
    del.dataset.action = "delete-rehearsal";
    del.textContent = "Delete";
    del.setAttribute("aria-label", `Delete the rehearsal of ${run.timestamp}`);
    del.addEventListener("click", () => void removeRun(run.id));
    li.append(textEl(doc, "span", `${run.timestamp}: ${got}/${run.points.length} recalled `), del);
    return li;
  };

  /** @param {string} id */
  const removeRun = async (id) => {
    const undo = byId("rehearsal-undo");
    /** @param {() => Promise<void>} restore */
    const showUndo = (restore) => {
      if (!undo) return;
      undo.hidden = false;
      undo.onclick = async () => {
        undo.onclick = null;
        undo.hidden = true;
        await restore();
        await renderHistory();
      };
    };
    if (await deleteRehearsalWithUndo(id, { store: rehearsals, confirm: deps.confirm, showUndo })) await renderHistory();
  };

  /**
   * @param {string} transcript
   * @param {import("./recall_match.js").RecallResult[]} results
   * @param {boolean} replay
   */
  const endRun = async (transcript, results, replay) => {
    session = null;
    const record = await rehearsals.save(DEMO_PALACE_ID, { transcript, results });
    const label = replay ? [textEl(doc, "p", `Results: ${REPLAY_LABEL}`)] : [];
    byId("recall-results")?.replaceChildren(...label, renderSaidVsPalace(record, doc));
    await renderHistory();
  };

  onClick("load-demo", async () => {
    session = null;
    lookupDemoPlace({ doc, fetch: fetchFn, place: deps.place });
    const auto = Boolean(/** @type {HTMLInputElement | null} */ (byId("auto"))?.checked);
    const split = await runDemoPalace({ auto }, { ...deps, fetch: fetchFn });
    if (!split) return;
    points = split;
    const panel = byId("recall");
    if (panel) panel.hidden = false;
    await renderHistory();
  });

  // The mic is only ever asked for here, on the user's click (MEM-032).
  onClick("recall-start", async () => {
    session = await startRecall({ points, getUserMedia: deps.getUserMedia, doc });
    if (session.stream) {
      // Spoken capture (/recall/audio) is not wired yet: release the mic and take typed answers.
      for (const track of session.stream.getTracks()) track.stop();
      const box = byId("recall-typed");
      if (box) box.hidden = false;
    }
  });

  onClick("recall-submit", async () => {
    const box = /** @type {HTMLInputElement | null} */ (byId("recall-typed"));
    if (!session || !box) return;
    session.submitTyped(String(box.value ?? ""));
    box.value = "";
    await endRun(session.matcher.transcript(), session.results(), false);
  });

  // Offline demo: the recorded session from the server, matched locally; never the speech relay.
  onClick("recall-replay", async () => {
    const resp = await fetchFn("/demo/recall.json");
    const timeline = await resp.json();
    const matcher = createMatcher(points);
    const results = await replayRecording(timeline, matcher, { wait: deps.wait });
    await endRun(matcher.transcript(), results, true);
  });
}
