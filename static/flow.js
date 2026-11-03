// @ts-check
// Page flow (MEM-029..033): Load demo -> encode -> walk view, then the recall panel (spoken via
// /recall/audio, typed answers, or the recorded demo replay), the rehearsal history with per-point
// hit rates, and the live passcode header. The one home of the page wiring app.js calls; model text
// only via textContent.

import { formatHealth, lookupDemoPlace } from "./app.js";
import { errorCode, runDemoPalace } from "./encode.js";
import { createHistory } from "./history.js";
import { createIdbAdapter } from "./idb_adapter.js";
import { chunkSamples, encodeWav, postRecallAudio, recordClip, TARGET_SAMPLE_RATE } from "./mic_wav.js";
import { wireBackup } from "./backup_ui.js";
import { localStorageAdapter } from "./palace_store.js";
import { pointOf } from "./rehearsals.js";
import { showPublicBanner } from "./public_banner.js";
import { REPLAY_LABEL, replayRecording, startRecall } from "./recall.js";
import { createMatcher } from "./recall_match.js";
import { markPointGot, pointCounted, renderEndScreen } from "./recall_end.js";
import { createLiveRelay, renderLiveBoard } from "./recall_live.js";
import { routePracticePoints } from "./route_map.js";
import { createRouteView, routeRun } from "./route_view.js";

// The model routes the live server gates on the passcode (MEM-034); /demo/* fixtures stay open.
const PASSCODE_ROUTES = new Set(["/loci", "/split", "/associate", "/scenes", "/recall/audio"]);

// The demo is the only palace this page builds, so its history keys on a name that survives reloads.
const DEMO_PALACE_ID = "demo";

// Cap on one spoken run: room for a full recall without unbounded PCM in memory (6 relay chunks).
const MAX_RECALL_MS = 3 * 60 * 1000;

/**
 * @typedef {{
 *   doc: Document,
 *   fetch: typeof fetch,
 *   store: ReturnType<typeof import("./palace_store.js").createPalaceStore>,
 *   rehearsals: ReturnType<typeof import("./rehearsals.js").createRehearsalStore>,
 *   getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>,
 *   AudioContext?: typeof AudioContext,
 *   location: {hostname: string},
 *   loadImage: (src: string) => Promise<CanvasImageSource>,
 *   confirm: () => boolean | Promise<boolean>,
 *   wait?: (ms: number) => Promise<unknown>,
 *   place?: ReturnType<typeof import("./place.js").createPlaceState>,
 *   setInterval?: (fn: () => void, ms: number) => unknown,
 *   clearInterval?: (handle: any) => void,
 *   routes?: ReturnType<typeof import("./route_store.js").createRouteStore>,
 *   thumbnail?: import("./backup_routes.js").Thumbnail,
 *   realMap?: import("./route_view.js").RealMap,
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
 * Key-value adapter for a page store (MEM-033): IndexedDB when the browser has it, else localStorage
 * under `prefix`. localStorage is read lazily: merely touching it throws where storage is disabled.
 * @param {{indexedDB?: IDBFactory | null, localStorage?: Storage}} env
 * @param {{dbName: string, storeName: string, prefix: string}} opts
 */
export function selectStore(env, { dbName, storeName, prefix }) {
  if (env.indexedDB) return createIdbAdapter(env.indexedDB, { dbName, storeName });
  return localStorageAdapter(prefix, () => /** @type {Storage} */ (env.localStorage));
}

/**
 * Re-split a recorded 16 kHz WAV so each POST stays under the relay's MAX_CHUNK_BYTES; at least one
 * chunk. The int16 -> float mapping inverts encodeWav exactly, so the relayed PCM is the recorded PCM.
 * @param {Uint8Array} wav canonical 44-byte header + int16 mono samples
 */
function wavChunks(wav) {
  const pcm = new DataView(wav.buffer, wav.byteOffset + 44, wav.byteLength - 44);
  const samples = new Float32Array(pcm.byteLength / 2);
  for (let i = 0; i < samples.length; i++) {
    const s = pcm.getInt16(i * 2, true);
    samples[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }
  const chunks = chunkSamples(samples);
  return (chunks.length ? chunks : [samples]).map((c) => encodeWav(c, TARGET_SAMPLE_RATE));
}

/**
 * The recorded demo session (MEM-039 failure codes, mirroring Load demo's "Demo failed: <code>").
 * @param {typeof fetch} fetchFn
 * @returns {Promise<{timeline: any} | {code: string}>}
 */
async function fetchReplay(fetchFn) {
  let resp;
  try {
    resp = await fetchFn("/demo/recall.json");
  } catch (err) {
    // fetch rejects with a TypeError only when the request never got an answer.
    return { code: err instanceof TypeError ? "network" : "unexpected error" };
  }
  if (!resp.ok) return { code: await errorCode(resp) };
  const timeline = await resp.json().catch(() => null);
  return timeline && Array.isArray(timeline.chunks) ? { timeline } : { code: "bad_response" };
}

/**
 * @param {Document} doc
 * @param {typeof fetch} fetchFn
 * @returns {Promise<string | null>} the server's mode ("fixture", "meta"), or null when unknown
 */
async function showHealth(doc, fetchFn) {
  const el = doc.getElementById("status");
  if (!el) return null;
  try {
    const resp = await fetchFn("/healthz");
    const health = resp.ok ? await resp.json() : null;
    el.textContent = formatHealth(health);
    // The privacy notice only applies when the photo actually leaves for Meta's APIs.
    const notice = doc.getElementById("meta-notice");
    if (notice && health && health.mode === "meta") notice.hidden = false;
    return health && typeof health.mode === "string" ? health.mode : null;
  } catch {
    el.textContent = formatHealth(null);
    return null;
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
  // A fixture-mode server answers every speech relay call "live_only", so its runs never ask for the mic;
  // Start awaits this, so a click racing a slow /healthz cannot take the mic path first.
  const healthMode = showHealth(doc, deps.fetch);

  /** @type {import("./recall.js").RecallPoint[]} */
  let points = [];
  /** @type {Awaited<ReturnType<typeof startRecall>> | null} */
  let session = null;
  /** @type {Awaited<ReturnType<typeof recordClip>> | null} */
  let clip = null;
  // The spoken run's live relay and board (MEM-037); `failure` keeps a relay failure that lands during Done.
  /**
   * @typedef {{
   *   relay: ReturnType<typeof createLiveRelay>,
   *   board: ReturnType<typeof renderLiveBoard>,
   *   failure: { err: unknown } | null,
   * }} LiveRun
   */
  /** @type {LiveRun | null} */
  let live = null;
  const timers = {
    /** @type {(fn: () => void, ms: number) => unknown} */
    setInterval: deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms)),
    /** @type {(handle: any) => void} */
    clearInterval: deps.clearInterval ?? ((handle) => globalThis.clearInterval(handle)),
  };

  /** @param {MediaStream} stream */
  const releaseMic = (stream) => {
    for (const track of stream.getTracks()) track.stop();
  };
  const showTyped = () => {
    const box = byId("recall-typed");
    if (box) box.hidden = false;
  };
  // Done only acts on an open run, so it is disabled whenever none is open.
  /** @param {boolean} open */
  const setRunOpen = (open) => {
    const done = /** @type {HTMLButtonElement | null} */ (byId("recall-submit"));
    if (done) done.disabled = !open;
  };
  setRunOpen(false);
  // Route practice (MEM-051): the route being practiced and its #recall-map; null on the demo palace.
  /** @type {{ route: import("./route_store.js").Route, map: import("./route_view.js").RouteMap } | null} */
  let practice = null;
  // The recorded replay is the demo palace's session: hidden in route practice so it never saves a route run.
  const showReplay = (/** @type {boolean} */ shown) => { const r = byId("recall-replay"); if (r) r.hidden = !shown; };
  /** @param {string} label @param {{ starts: () => (number | null)[] }} matcher */
  const showBoard = (label, matcher) => {
    const board = renderLiveBoard(points, doc, { label, inOrder: practice ? matcher : undefined });
    byId("recall-live")?.replaceChildren(board.el);
    const map = practice?.map;
    if (!map || !practice) return board;
    const { route } = practice;
    /** @param {number[]} got */
    const light = (got) => {
      board.light(got);
      map.light(routeRun(route, matcher.starts()).counted);
    };
    return { el: board.el, light };
  };
  // Ends any recording in progress, its live relay and the mic; resolves to the untaken WAV, or null if none.
  const stopSpeaking = () => {
    if (live) void live.relay.stop();
    live = null;
    const wav = clip ? clip.stop() : null;
    clip = null;
    if (session && session.stream) releaseMic(session.stream);
    return wav;
  };
  // stopSpeaking for a run being abandoned: the WAV is unwanted and the mic is already released, so a
  // failing AudioContext.close() has nothing left to lose and must not escape as an unhandled rejection.
  const discardSpeaking = () => {
    void stopSpeaking()?.catch(() => {});
  };
  // The open run's relay failure message, kept beside the empty-Done prompt so it is never wiped.
  /** @type {{ session: NonNullable<typeof session>, el: HTMLElement } | null} */
  let relayNote = null;
  /**
   * Budget spent, fixture-only server or network down: the run continues typed; lit points stay lit.
   * @param {NonNullable<typeof session>} current
   * @param {unknown} err
   */
  const fallBackTyped = (current, err) => {
    session = current;
    discardSpeaking();
    showTyped();
    const code = /** @type {{ code?: unknown } | null | undefined} */ (err)?.code;
    const why = typeof code === "string" ? code : "unexpected";
    const note = textEl(doc, "p", `Speech relay failed (${why}): type what you remember instead.`);
    relayNote = { session: current, el: note };
    byId("recall-results")?.replaceChildren(note);
  };

  const renderHistory = createHistory({ doc, rehearsals, confirm: deps.confirm, palaceId: DEMO_PALACE_ID });
  // Stored runs are listed on open, before (and without) Load demo.
  void renderHistory();
  wireBackup(deps, renderHistory);
  const routeView = deps.routes
    ? createRouteView({ doc, routes: deps.routes, rehearsals, realMap: deps.realMap, onPractice: (route, map) => {
      discardSpeaking();
      session = null;
      setRunOpen(false);
      points = routePracticePoints(route);
      practice = { route, map };
      showReplay(false);
      byId("recall-live")?.replaceChildren();
      byId("recall-results")?.replaceChildren();
    } })
    : null;
  void routeView?.renderHome();

  /**
   * @param {string} transcript
   * @param {import("./recall_match.js").RecallResult[]} results
   * @param {boolean} replay
   * @param {(number | null)[]} starts
   */
  const endRun = async (transcript, results, replay, starts) => {
    session = null;
    setRunOpen(false);
    const route = practice?.route;
    const done = route ? routeRun(route, starts) : null;
    if (practice && done) practice.map.finish(done.counted);
    const palaceId = route ? route.id : DEMO_PALACE_ID;
    /** @type {import("./rehearsals.js").Rehearsal} */
    let record;
    let saved = true;
    try {
      record = await rehearsals.save(palaceId, done ? { transcript, results, mode: "route", hits: done.hits } : { transcript, results });
    } catch {
      // The store is unavailable (the history says so); the end screen still shows this run, unsaved.
      saved = false;
      record = { id: "", palace_id: palaceId, timestamp: new Date().toISOString(), transcript, points: results.map(pointOf) };
    }
    // A route run's history is its route's Learned and hit rates, not the demo palace's list.
    const refresh = route && routeView ? () => routeView.refresh(route) : renderHistory;
    const label = replay ? [textEl(doc, "p", `Results: ${REPLAY_LABEL}`)] : [];
    /** @param {string} [note] */
    const show = (note) =>
      byId("recall-results")?.replaceChildren(
        ...label,
        renderEndScreen(record, doc, (i) => void mark(i)),
        ...(note ? [textEl(doc, "p", note)] : []),
      );
    // Overlapping writes land in completion order, so `stored` is the last one the store confirmed; once
    // none is in flight the screen shows exactly that: a failed point stays only if a later write kept it.
    let stored = record;
    let inFlight = 0;
    /** @type {number[]} */
    let failed = [];
    // Re-rendered before the write, so a second click builds on this override, never a stale copy.
    /** @param {number} i */
    const mark = async (i) => {
      record = markPointGot(record, i);
      show();
      // An unsaved run has no stored copy to rewrite.
      if (saved) {
        const written = record;
        inFlight += 1;
        try {
          await rehearsals.restore(written);
          stored = written;
        } catch {
          failed.push(i);
        }
        inFlight -= 1;
        if (inFlight === 0) {
          const lost = failed.filter((j) => !pointCounted(stored, j)).map((j) => stored.points[j].label);
          failed = [];
          if (stored !== record || lost.length) {
            record = stored;
            const tail = `${lost.length > 1 ? "they are" : "it is"} still counted as missed.`;
            show(lost.length ? `Could not save "Mark got it" for ${lost.join(", ")}; ${tail}` : "");
          }
        }
      }
      await refresh();
    };
    show();
    await refresh();
  };

  onClick("load-demo", async () => {
    discardSpeaking();
    session = null;
    setRunOpen(false);
    lookupDemoPlace({ doc, fetch: fetchFn, place: deps.place });
    const auto = Boolean(/** @type {HTMLInputElement | null} */ (byId("auto"))?.checked);
    // Disabled while a load runs, so a second click cannot build the palace twice; runDemoPalace never
    // throws, so it is re-enabled on every outcome.
    const button = /** @type {HTMLButtonElement | null} */ (byId("load-demo"));
    if (button) button.disabled = true;
    const split = await runDemoPalace({ auto }, { ...deps, fetch: fetchFn });
    if (button) button.disabled = false;
    if (!split) return;
    points = split;
    practice = null;
    showReplay(true);
    const mode = byId("recall-mode");
    if (mode) mode.textContent = "";
    byId("recall-map")?.replaceChildren();
    const panel = byId("recall");
    if (panel) panel.hidden = false;
    await renderHistory();
  });

  // A Start still waiting on the mic or the recorder owns the run; a second click must not open another.
  let starting = false;
  // The mic is only ever asked for here, on the user's click (MEM-032).
  onClick("recall-start", async () => {
    if (starting) return;
    starting = true;
    try {
      await beginRecall();
    } finally {
      starting = false;
    }
  });
  const beginRecall = async () => {
    const fixtureMode = (await healthMode) === "fixture";
    discardSpeaking();
    byId("recall-live")?.replaceChildren();
    session = await startRecall({ points, getUserMedia: fixtureMode ? undefined : deps.getUserMedia, doc });
    setRunOpen(true);
    if (!session.stream) return;
    if (deps.AudioContext) {
      const current = session;
      const recording = await recordClip({ stream: session.stream, AudioContext: deps.AudioContext, maxMs: MAX_RECALL_MS });
      clip = recording;
      const board = showBoard("LIVE", current.matcher);
      const keywords = points.map((p) => p.label);
      /** @type {LiveRun} */
      const run = {
        board,
        failure: null,
        relay: createLiveRelay({
          clip: recording,
          post: (wav) => postRecallAudio({ fetch: fetchFn, wav, keywords }),
          matcher: current.matcher,
          onMatch: board.light,
          onFail: (err) => {
            run.failure = { err };
            // Once Done has detached the run, Done owns the fallback.
            if (live === run) fallBackTyped(current, err);
          },
          ...timers,
        }),
      };
      live = run;
      return;
    }
    // No Web Audio to record with: release the mic and take typed answers.
    releaseMic(session.stream);
    showTyped();
  };

  onClick("recall-submit", async () => {
    const box = /** @type {HTMLInputElement | null} */ (byId("recall-typed"));
    if (!session || !box) return;
    const current = session;
    const run = live;
    if (run) {
      // Detached while relaying, so a second Done cannot end the same run twice; a slice still in the air
      // finishes first, and its failure is this Done's failure.
      live = null;
      session = null;
      await run.relay.stop();
      if (run.failure) {
        fallBackTyped(current, run.failure.err);
        return;
      }
      // Re-attached only so stopSpeaking releases this run's mic; detached again just below.
      session = current;
    }
    const wav = stopSpeaking();
    if (wav) {
      session = null;
      try {
        const remainder = await wav;
        for (const chunk of remainder ? wavChunks(remainder) : []) {
          const { text } = await postRecallAudio({ fetch: fetchFn, wav: chunk, keywords: points.map((p) => p.label) });
          const got = current.matcher.append(text);
          if (run) run.board.light(got);
        }
      } catch (err) {
        // A relay error or a failing AudioContext.close(): either way the spoken run goes on typed.
        fallBackTyped(current, err);
        return;
      }
    } else {
      const typed = String(box.value ?? "");
      // An empty Done with nothing got would save a 0/N run; keep the run open and ask for an answer
      // instead. A spoken run that fell back typed may already hold got points: those still save (Q24).
      if (!typed.trim()) {
        if (!current.results().some((r) => r.got)) {
          const kept = relayNote && relayNote.session === current ? [relayNote.el] : [];
          const prompt = textEl(doc, "p", "Type what you remember first, then press Done.");
          byId("recall-results")?.replaceChildren(...kept, prompt);
          return;
        }
      } else {
        current.submitTyped(typed);
      }
      box.value = "";
    }
    await endRun(current.matcher.transcript(), current.results(), false, current.matcher.starts());
  });

  // One replay at a time: a second click while one runs would save the same session twice.
  let replaying = false;
  // Offline demo: the recorded session from the server, matched locally; never the speech relay.
  onClick("recall-replay", async () => {
    if (replaying || practice) return;
    replaying = true;
    try {
      await replayDemo();
    } finally {
      replaying = false;
    }
  });
  const replayDemo = async () => {
    discardSpeaking();
    const replay = await fetchReplay(fetchFn);
    if ("code" in replay) {
      byId("recall-live")?.replaceChildren();
      byId("recall-results")?.replaceChildren(textEl(doc, "p", `Replay failed: ${replay.code}`));
      return;
    }
    const { timeline } = replay;
    const matcher = createMatcher(points);
    const board = showBoard("recorded replay", matcher);
    const results = await replayRecording(timeline, matcher, { wait: deps.wait, onMatch: board.light });
    await endRun(matcher.transcript(), results, true, matcher.starts());
  };
}
