// @ts-check
// Page flow (MEM-029..033): Load demo -> encode -> walk view, then the recall panel (spoken via
// /recall/audio, typed answers, or the recorded demo replay), the rehearsal history with per-point
// hit rates, and the live passcode header. The one home of the page wiring app.js calls; model text
// only via textContent.

import { formatHealth, lookupDemoPlace } from "./app.js";
import { runDemoPalace } from "./encode.js";
import { createIdbAdapter } from "./idb_adapter.js";
import { chunkSamples, encodeWav, postRecallAudio, RecallAudioError, recordClip, TARGET_SAMPLE_RATE } from "./mic_wav.js";
import { localStorageAdapter } from "./palace_store.js";
import { showPublicBanner } from "./public_banner.js";
import { REPLAY_LABEL, replayRecording, startRecall } from "./recall.js";
import { createMatcher } from "./recall_match.js";
import { deleteRehearsalWithUndo, hitRates, renderSaidVsPalace } from "./rehearsals.js";

// The model routes the live server gates on the passcode (MEM-034); /demo/* fixtures stay open.
const PASSCODE_ROUTES = new Set(["/loci", "/split", "/associate", "/scenes", "/recall/audio"]);

// The demo is the only palace this page builds, so its history keys on a name that survives reloads.
const DEMO_PALACE_ID = "demo";

// Cap on one spoken run: room for a full recall without unbounded PCM in memory (6 relay chunks).
const MAX_RECALL_MS = 3 * 60 * 1000;

/**
 * @typedef {import("./rehearsals.js").Rehearsal} Rehearsal
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
  /** @type {Awaited<ReturnType<typeof recordClip>> | null} */
  let clip = null;

  /** @param {MediaStream} stream */
  const releaseMic = (stream) => {
    for (const track of stream.getTracks()) track.stop();
  };
  const showTyped = () => {
    const box = byId("recall-typed");
    if (box) box.hidden = false;
  };
  // Ends any recording in progress and releases the mic; resolves to its WAV, or null if none.
  const stopSpeaking = () => {
    const wav = clip ? clip.stop() : null;
    clip = null;
    if (session && session.stream) releaseMic(session.stream);
    return wav;
  };

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
    void stopSpeaking();
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
    void stopSpeaking();
    session = await startRecall({ points, getUserMedia: deps.getUserMedia, doc });
    if (!session.stream) return;
    if (deps.AudioContext) {
      clip = await recordClip({ stream: session.stream, AudioContext: deps.AudioContext, maxMs: MAX_RECALL_MS });
      return;
    }
    // No Web Audio to record with: release the mic and take typed answers.
    releaseMic(session.stream);
    showTyped();
  });

  onClick("recall-submit", async () => {
    const box = /** @type {HTMLInputElement | null} */ (byId("recall-typed"));
    if (!session || !box) return;
    const current = session;
    const wav = stopSpeaking();
    if (wav) {
      // Detached while relaying, so a second Done cannot end the same run twice.
      session = null;
      try {
        for (const chunk of wavChunks(await wav)) {
          const { text } = await postRecallAudio({ fetch: fetchFn, wav: chunk, keywords: points.map((p) => p.label) });
          current.matcher.append(text);
        }
      } catch (err) {
        if (!(err instanceof RecallAudioError)) throw err;
        // Budget spent, fixture-only server or network down: the run continues typed.
        session = current;
        showTyped();
        byId("recall-results")?.replaceChildren(
          textEl(doc, "p", `Speech relay failed (${err.code}): type what you remember instead.`),
        );
        return;
      }
    } else {
      current.submitTyped(String(box.value ?? ""));
      box.value = "";
    }
    await endRun(current.matcher.transcript(), current.results(), false);
  });

  // Offline demo: the recorded session from the server, matched locally; never the speech relay.
  onClick("recall-replay", async () => {
    void stopSpeaking();
    const resp = await fetchFn("/demo/recall.json");
    const timeline = await resp.json();
    const matcher = createMatcher(points);
    const results = await replayRecording(timeline, matcher, { wait: deps.wait });
    await endRun(matcher.transcript(), results, true);
  });
}
