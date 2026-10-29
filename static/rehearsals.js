// @ts-check
// Rehearsal history (MEM-033, plan D18): each recall run kept as a human-readable JSON record (never
// audio), per-point hit rates across runs, a said-vs-palace view, and a confirm + Undo delete.

/**
 * @typedef {{
 *   get: (key: string) => Promise<any>,
 *   put: (key: string, value: string) => Promise<void>,
 *   delete: (key: string) => Promise<void>,
 *   list: () => Promise<any[]>,
 * }} RehearsalAdapter
 * @typedef {{ label: string, source_quote: string, got: boolean, override: boolean, span: string | null }} RehearsalPoint
 * @typedef {{
 *   id: string, palace_id: string, timestamp: string, transcript: string, points: RehearsalPoint[],
 * }} Rehearsal
 */

const CHRONIC_MIN_RUNS = 2;
const CHRONIC_MAX_RATE = 0.5;

/**
 * Whitelists the D18 point fields, so audio or any other extra field on a result never reaches storage.
 * @param {any} r
 * @returns {RehearsalPoint}
 */
export function pointOf(r) {
  return {
    label: String(r?.label ?? ""),
    source_quote: String(r?.source_quote ?? ""),
    got: r?.got === true,
    override: r?.override === true,
    span: typeof r?.span === "string" ? r.span : null,
  };
}

/**
 * @param {RehearsalAdapter} adapter
 * @param {{ now?: () => number, newId?: () => string }} [opts]
 */
export function createRehearsalStore(adapter, { now = Date.now, newId = () => crypto.randomUUID() } = {}) {
  /** @param {Rehearsal} record */
  const put = (record) => adapter.put(record.id, JSON.stringify(record));

  return {
    /**
     * @param {string} palaceId
     * @param {{ transcript?: unknown, results?: unknown[] }} run
     * @returns {Promise<Rehearsal>}
     */
    async save(palaceId, run) {
      /** @type {Rehearsal} */
      const record = {
        id: newId(),
        palace_id: String(palaceId),
        timestamp: new Date(now()).toISOString(),
        transcript: String(run?.transcript ?? ""),
        points: (Array.isArray(run?.results) ? run.results : []).map(pointOf),
      };
      await put(record);
      return record;
    },
    /**
     * @param {string} id
     * @returns {Promise<Rehearsal | null>}
     */
    async get(id) {
      const raw = await adapter.get(id);
      return typeof raw === "string" ? JSON.parse(raw) : null;
    },
    /**
     * @param {string} palaceId
     * @returns {Promise<Rehearsal[]>} oldest first
     */
    async list(palaceId) {
      const values = await adapter.list();
      return values
        .filter((v) => typeof v === "string")
        .map((v) => /** @type {Rehearsal} */ (JSON.parse(v)))
        .filter((r) => r.palace_id === palaceId)
        .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    },
    /** @param {string} id */
    delete: (id) => adapter.delete(id),
    /** @param {Rehearsal} record  puts a deleted record back unchanged (Undo) */
    restore: (record) => put(record),
  };
}

/**
 * @param {Rehearsal[]} records
 * @returns {{ label: string, hits: number, runs: number, rate: number, chronic: boolean }[]} first-seen order
 */
export function hitRates(records) {
  /** @type {Map<string, { hits: number, runs: number }>} */
  const tally = new Map();
  for (const record of records) {
    for (const p of record.points) {
      const t = tally.get(p.label) ?? { hits: 0, runs: 0 };
      t.runs += 1;
      // A manual "mark got it" override is a hit.
      if (p.got || p.override) t.hits += 1;
      tally.set(p.label, t);
    }
  }
  return [...tally].map(([label, { hits, runs }]) => {
    const rate = hits / runs;
    return { label, hits, runs, rate, chronic: runs >= CHRONIC_MIN_RUNS && rate < CHRONIC_MAX_RATE };
  });
}

/**
 * @param {any} doc
 * @param {string} tag
 * @param {string} className
 * @param {string} text
 */
function textEl(doc, tag, className, text) {
  const el = doc.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

/**
 * One row per point in palace order: label, what was said (or "not said"), what is in the palace.
 * Stored text is user/model text, so it is set via textContent only.
 * @param {Rehearsal} record
 * @param {any} doc
 */
export function renderSaidVsPalace(record, doc) {
  const list = doc.createElement("ol");
  list.className = "said-vs-palace";
  for (const p of record.points) {
    const said = p.got ? (p.span ?? "marked got it") : "not said";
    const row = doc.createElement("li");
    row.className = p.got ? "said-got" : "said-missed";
    row.append(
      textEl(doc, "span", "said-label", p.label),
      textEl(doc, "span", "said-text", said),
      textEl(doc, "span", "said-quote", p.source_quote),
    );
    list.appendChild(row);
  }
  return list;
}

/**
 * @param {string} id
 * @param {{
 *   store: ReturnType<typeof createRehearsalStore>,
 *   confirm: () => boolean | Promise<boolean>,
 *   showUndo: (undo: () => Promise<void>) => void,
 * }} deps
 * @returns {Promise<boolean>} true once deleted
 */
export async function deleteRehearsalWithUndo(id, { store, confirm, showUndo }) {
  const record = await store.get(id);
  if (record == null) return false;
  if (!(await confirm())) return false;
  await store.delete(id);
  showUndo(() => store.restore(record));
  return true;
}
