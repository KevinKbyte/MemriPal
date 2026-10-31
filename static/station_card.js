// @ts-check
// S3 Station card (MEM-050, plan B5): a named station's name, its Visual / Spatial / Conceptual
// profile, five quick-tap groups stored on the station, a validated name edit and a drop with
// arm -> confirm -> Undo. Model-derived text is only ever set via textContent.

/** Part A S3 tap groups; the stored value is the tapped label. Smell is the user's own note. */
export const TAP_GROUPS = {
  sound: ["Traffic", "Birds", "Water", "Voices", "Quiet", "Music"],
  smell: ["Food", "Coffee", "Flowers", "Fumes", "Rain", "None"],
  feel: ["Warm", "Cold", "Windy", "Uphill", "Stairs", "Shade"],
  mood: ["Calm", "Busy", "Bright", "Cosy", "Grand", "Odd"],
  turn: ["Straight", "Left", "Right", "Arrive"],
};

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

  function renderTaps() {
    for (const [group, labels] of Object.entries(TAP_GROUPS)) {
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
    await store.setStationTaps(routeId, stationId, taps);
  }

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
    /** @param {string} id */
    async show(id) {
      const station = (await store.getRoute(routeId))?.stations.find((s) => s.id === id);
      if (!station) return;
      stationId = id;
      taps = { ...(station.taps ?? {}) };
      nameInput.value = station.name;
      renderProfile(station);
      renderTaps();
      setArmed(false);
      undoBtn.hidden = true;
      // A Spark name that clashes on arrival is shown with the error; the user renames.
      await checkName();
    },
  };
}
