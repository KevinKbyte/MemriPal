// @ts-check
// Typeahead filtering and ordering for long item lists (MEM-124, ADR 0073): "Your routes" now, the
// Landmarks gallery (item 73) next, hence the generic key / groupKey / time accessors. Pure, no DOM.

/** @typedef {string | string[] | null | undefined} Fields */

/**
 * Case- and diacritic-insensitive form of text: NFD, combining marks dropped, lowercase, whitespace collapsed.
 * @param {unknown} text
 */
export function normalize(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {unknown} query */
export function queryTokens(query) {
  const n = normalize(query);
  return n ? n.split(" ") : [];
}

/** @param {Fields} value */
const asList = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

/**
 * Items whose key fields contain every query token (AND; tokens may hit different fields), and, when anyOf
 * is non-empty, whose groupKey shares a value with anyOf (OR). Input order kept; a new array.
 * @template T
 * @param {T[]} items
 * @param {string} query
 * @param {{ key?: (item: T) => Fields, anyOf?: Iterable<string>, groupKey?: (item: T) => Fields }} [opts]
 * @returns {T[]}
 */
export function filterItems(items, query, { key = (item) => /** @type {any} */ (item).name, anyOf, groupKey } = {}) {
  const tokens = queryTokens(query);
  const groups = new Set(anyOf ?? []);
  if (groups.size && typeof groupKey !== "function") {
    throw new TypeError("filterItems: anyOf needs a groupKey function");
  }
  return items.filter((item) => {
    if (groups.size && !asList(/** @type {Function} */ (groupKey)(item)).some((g) => groups.has(g))) return false;
    if (!tokens.length) return true;
    const fields = asList(key(item)).map(normalize);
    return tokens.every((t) => fields.some((f) => f.includes(t)));
  });
}

/** @param {unknown} value epoch ms, Date, or a Date.parse-able string; NaN when absent or invalid */
function toMillis(value) {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

/**
 * Newest first; ties and items without a valid time keep input order (the latter last). A new array.
 * @template T
 * @param {T[]} items
 * @param {{ time?: (item: T) => unknown }} [opts]
 * @returns {T[]}
 */
export function sortRecentFirst(items, { time = (item) => /** @type {any} */ (item).created_at } = {}) {
  return items
    .map((item, i) => ({ item, i, t: toMillis(time(item)) }))
    .sort((a, b) => {
      const aBad = Number.isNaN(a.t);
      const bBad = Number.isNaN(b.t);
      if (aBad || bBad) return aBad === bBad ? a.i - b.i : aBad ? 1 : -1;
      return b.t - a.t || a.i - b.i;
    })
    .map(({ item }) => item);
}

/**
 * Calls fn once, with the last call's args, after ms of quiet. Timers resolve from globalThis per call so
 * test fake timers apply.
 * @template {any[]} A
 * @param {(...args: A) => void} fn
 * @param {number} ms
 */
export function debounce(fn, ms) {
  if (typeof fn !== "function") throw new TypeError("debounce: fn must be a function");
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    throw new RangeError("debounce: ms must be a finite number >= 0");
  }
  /** @type {any} */
  let timer = null;
  const cancel = () => {
    if (timer !== null) globalThis.clearTimeout(timer);
    timer = null;
  };
  /** @param {A} args */
  const debounced = (...args) => {
    cancel();
    timer = globalThis.setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  return Object.assign(debounced, { cancel });
}
