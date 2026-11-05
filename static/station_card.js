// @ts-check
// S3 Station card (MEM-050, plan B5): a named station's name, its Visual / Spatial / Conceptual
// profile, its emoji tags (MEM-134, ADR 0080: they replace the sound/smell/feel/mood quick-taps; the Next
// turn group was removed, MEM-135), a validated name edit and a drop with arm -> confirm -> Undo.
// Model-derived text is only ever set via textContent.

import { EMOJI } from "./emoji_data.js";
import { MAX_EMOJIS, searchEmoji, startingEmojis } from "./emoji_tags.js";

/** Part A S3 tap groups; the stored value is the tapped label. Smell is the user's own note. */
export const TAP_GROUPS = {
  sound: ["Traffic", "Birds", "Water", "Voices", "Quiet", "Music"],
  smell: ["Food", "Coffee", "Flowers", "Fumes", "Rain", "None"],
  feel: ["Warm", "Cold", "Windy", "Uphill", "Stairs", "Shade"],
  mood: ["Calm", "Busy", "Bright", "Cosy", "Grand", "Odd"],
};

/** Display names for the tap groups, matching the card's group headings. */
export const TAP_GROUP_LABELS = { sound: "Sound", smell: "Smell", feel: "Feel", mood: "Mood" };

// MEM-134: these groups stay stored in station.taps (no data loss) but the card shows them as emoji tags.
const SENSE_GROUPS = ["sound", "smell", "feel", "mood"];
/** The tap groups the card still renders as buttons and summary lines. */
const CARD_TAP_GROUPS = Object.entries(TAP_GROUPS).filter(([group]) => !SENSE_GROUPS.includes(group));

const EMOJI_NAME = new Map(EMOJI.map((x) => [x.e, x.name]));

/**
 * MEM-110 / MEM-134: the station's set non-sense taps (turn) as "<Group>: <label>" lines; groups without a
 * value (or with a value outside TAP_GROUPS) produce no line, so an untapped station yields [].
 * @param {Record<string, unknown> | undefined | null} taps
 * @returns {string[]}
 */
export function tapSummary(taps) {
  return CARD_TAP_GROUPS
    .filter(([group, labels]) => typeof taps?.[group] === "string" && labels.includes(/** @type {string} */ (taps[group])))
    .map(([group]) => `${TAP_GROUP_LABELS[/** @type {keyof typeof TAP_GROUP_LABELS} */ (group)]}: ${taps?.[group]}`);
}

const PROFILE_LABELS = [["visual", "Visual"], ["spatial", "Spatial"], ["conceptual", "Conceptual"]];
const MAX_WORDS = 3;

/** @param {string} s */
const words = (s) => String(s).trim().toLowerCase().split(/\s+/).filter(Boolean);

/**
 * B4 shape rule (non-empty, <= 3 words, no digits) plus the client uniqueness rule: the normalized
 * name, or its last word, may not match another station of the route.
 * @param {string} name @param {string[]} others the route's other station names
 * @returns {string | null} why the name is refused, or null when it is fine
 */
export function stationNameError(name, others) {
  const w = words(name);
  if (w.length === 0) return "Give this station a name.";
  if (w.length > MAX_WORDS) return `Use at most ${MAX_WORDS} words.`;
  if (/\d/.test(name)) return "Leave out numbers.";
  const norm = w.join(" ");
  const last = w[w.length - 1];
  for (const other of others) {
    const o = words(other);
    if (o.length === 0) continue;
    if (o.join(" ") === norm) return `Another station is already called "${other}". Pick a new name.`;
    if (o[o.length - 1] === last) return `"${other}" also ends in "${last}". Pick a name that ends differently.`;
  }
  return null;
}

/**
 * @param {{
 *   doc: Document,
 *   store: ReturnType<typeof import("./route_store.js").createRouteStore>,
 *   routeId: string,
 *   fetch?: typeof fetch,
 * }} deps fetch is accepted for wiring symmetry; the card itself never calls the network.
 */
export function createStationCard({ doc, store, routeId }) {
  const el = (/** @type {string} */ id) => /** @type {any} */ (doc.getElementById(id));
  const nameInput = el("station-name");
  const nameError = el("station-name-error");
  const dropBtn = el("station-drop");
  const confirmBtn = el("station-drop-confirm");
  const cancelBtn = el("station-drop-cancel");
  const undoBtn = el("station-undo");

  /** @type {string | null} */
  let stationId = null;
  /** @type {Record<string, string>} */
  let taps = {};
  let shown = 0;

  const otherNames = async () => {
    const r = await store.getRoute(routeId);
    return (r?.stations ?? []).filter((s) => s.id !== stationId && s.status === "named").map((s) => s.name);
  };

  /** @returns {Promise<boolean>} true when the typed name is acceptable */
  const checkName = async () => {
    const err = stationNameError(nameInput.value ?? "", await otherNames());
    nameError.textContent = err ?? "";
    nameError.hidden = err === null;
    return err === null;
  };

  const setArmed = (/** @type {boolean} */ armed) => {
    confirmBtn.hidden = !armed;
    cancelBtn.hidden = !armed;
  };

  /** @param {any} station */
  function renderProfile(station) {
    const dl = el("station-profile");
    const frag = doc.createDocumentFragment();
    for (const [key, label] of PROFILE_LABELS) {
      const dt = doc.createElement("dt");
      dt.textContent = label;
      const dd = doc.createElement("dd");
      dd.textContent = station.profile?.[key] ?? "";
      frag.append(dt, dd);
    }
    dl.replaceChildren(frag);
  }

  /** MEM-110: one li per group that has a value, "<Group>: <label>"; no li (and hidden) for an untapped station. */
  function renderSummary() {
    const ul = el("station-tap-summary");
    if (!ul) return;
    const items = tapSummary(taps).map((line) => {
      const li = doc.createElement("li");
      li.className = "tap-chip";
      li.textContent = line;
      return li;
    });
    ul.replaceChildren(...items);
    ul.hidden = items.length === 0;
  }

  function renderTaps() {
    renderSummary();
    for (const [group, labels] of CARD_TAP_GROUPS) {
      const box = el(`tap-${group}`);
      const btns = labels.map((label) => {
        const b = doc.createElement("button");
        b.setAttribute("type", "button");
        b.className = "btn";
        b.textContent = label;
        b.setAttribute("aria-pressed", String(taps[group] === label));
        b.addEventListener("click", () => void toggleTap(group, label, btns));
        return b;
      });
      box.replaceChildren(...btns);
    }
  }

  /** One value per group; tapping the pressed button clears the group. */
  async function toggleTap(/** @type {string} */ group, /** @type {string} */ label, /** @type {any[]} */ btns) {
    if (stationId === null) return;
    const next = { ...taps };
    if (next[group] === label) delete next[group];
    else next[group] = label;
    taps = next;
    for (const b of btns) b.setAttribute("aria-pressed", String(taps[group] === b.textContent));
    renderSummary();
    await store.setStationTaps(routeId, stationId, taps);
  }

  // MEM-134 emoji tags: chip row, search picker, and remove as arm -> confirm -> Undo.
  const chipRow = el("station-emojis");
  const addBtn = el("emoji-add");
  const removeBtn = el("emoji-remove");
  const emojiUndoBtn = el("emoji-undo");
  const picker = el("emoji-picker");
  const search = el("emoji-search");
  const results = el("emoji-results");
  /** @type {string[]} */
  let emojis = [];
  /** @type {string | null} the chip clicked once, awaiting the Remove confirm */
  let armedEmoji = null;
  /** @type {string[] | null} the list before the last remove, for Undo */
  let beforeRemove = null;

  const saveEmojis = () =>
    stationId === null ? Promise.resolve() : store.setStationEmojis(routeId, stationId, emojis, { edited: true });

  function renderChips() {
    const items = emojis.map((e) => {
      const b = doc.createElement("button");
      b.setAttribute("type", "button");
      b.className = "emoji-chip";
      b.textContent = e;
      b.setAttribute("aria-label", EMOJI_NAME.get(e) ?? e);
      b.setAttribute("aria-pressed", String(armedEmoji === e));
      b.addEventListener("click", () => {
        armedEmoji = armedEmoji === e ? null : e;
        renderChips();
      });
      const li = doc.createElement("li");
      li.append(b);
      return li;
    });
    chipRow.replaceChildren(...items);
    removeBtn.hidden = armedEmoji === null;
    removeBtn.textContent = armedEmoji === null ? "Remove" : `Remove ${armedEmoji}`;
    addBtn.disabled = emojis.length >= MAX_EMOJIS;
  }

  function renderPicks() {
    const btns = searchEmoji(search.value ?? "").map((x) => {
      const b = doc.createElement("button");
      b.setAttribute("type", "button");
      b.className = "emoji-pick";
      b.textContent = x.e;
      b.setAttribute("aria-label", x.name);
      b.addEventListener("click", () => void pickEmoji(x.e));
      return b;
    });
    results.replaceChildren(...btns);
  }

  async function pickEmoji(/** @type {string} */ e) {
    if (emojis.includes(e) || emojis.length >= MAX_EMOJIS) return;
    emojis = [...emojis, e];
    beforeRemove = null;
    emojiUndoBtn.hidden = true;
    renderChips();
    await saveEmojis();
  }

  addBtn.addEventListener("click", () => {
    picker.hidden = !picker.hidden;
    if (!picker.hidden) renderPicks();
  });
  search.addEventListener("input", () => renderPicks());
  removeBtn.addEventListener("click", async () => {
    if (armedEmoji === null) return;
    beforeRemove = emojis;
    emojis = emojis.filter((e) => e !== armedEmoji);
    armedEmoji = null;
    renderChips();
    emojiUndoBtn.hidden = false;
    await saveEmojis();
  });
  emojiUndoBtn.addEventListener("click", async () => {
    emojiUndoBtn.hidden = true;
    if (beforeRemove === null) return;
    emojis = beforeRemove;
    beforeRemove = null;
    renderChips();
    await saveEmojis();
  });

  nameInput.addEventListener("input", () => void checkName());
  el("station-save").addEventListener("click", async () => {
    if (stationId === null || !(await checkName())) return;
    await store.renameStation(routeId, stationId, nameInput.value.trim());
  });
  dropBtn.addEventListener("click", () => setArmed(true));
  cancelBtn.addEventListener("click", () => setArmed(false));
  confirmBtn.addEventListener("click", async () => {
    setArmed(false);
    if (stationId === null) return;
    await store.dropStation(routeId, stationId);
    undoBtn.hidden = false;
  });
  undoBtn.addEventListener("click", async () => {
    undoBtn.hidden = true;
    await store.undoDrop(routeId);
  });

  return {
    /**
     * @param {string} id
     * @param {string} [onRoute] switch the card to another route first (one card serves the route view, MEM-110)
     */
    async show(id, onRoute) {
      if (onRoute !== undefined) routeId = onRoute;
      const ticket = ++shown;
      const station = (await store.getRoute(routeId))?.stations.find((s) => s.id === id);
      // A newer show() started while this one awaited the store: it owns the card.
      if (!station || ticket !== shown) return;
      stationId = id;
      taps = { ...(station.taps ?? {}) };
      nameInput.value = station.name;
      renderProfile(station);
      renderTaps();
      emojis = startingEmojis(station);
      armedEmoji = null;
      beforeRemove = null;
      emojiUndoBtn.hidden = true;
      picker.hidden = true;
      renderChips();
      // Tap migration + Muse auto-fill are saved once (edited false); a user-edited list is never rewritten.
      const storedEmojis = Array.isArray(station.emojis) ? station.emojis : [];
      if (station.emojisEdited !== true && storedEmojis.join("\n") !== emojis.join("\n")) {
        await store.setStationEmojis(routeId, id, emojis, { edited: false });
      }
      setArmed(false);
      undoBtn.hidden = true;
      // A Spark name that clashes on arrival is shown with the error; the user renames. A stored name that
      // only breaks the shape rule (the long seeded demo titles, MEM-110) is not flagged until it is edited.
      if (stationNameError(station.name, []) === null) await checkName();
      else {
        nameError.textContent = "";
        nameError.hidden = true;
      }
    },
  };
}
