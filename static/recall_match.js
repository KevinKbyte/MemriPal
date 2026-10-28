// @ts-check
// Spoken recall matcher (MEM-031, plan D4): deterministic local code with no model in the match step, so
// a paraphrase cannot be argued into a match and an utterance like "mark all points done" is just words.

const LEVENSHTEIN_MIN_RATIO = 0.8;
const COVERAGE_MIN = 0.6;
// Windows slightly shorter or longer than the target absorb a dropped word or filler ("um", "so").
const LEVENSHTEIN_SLACK = 2;
const COVERAGE_SLACK = 4;

// Function words carry no recall signal; key-term coverage counts content words only.
const STOPWORDS = new Set(
  (
    "a an the and or but nor so of to in on at by for with from as into onto about is are was were be been " +
    "being am it its this that these those there here i me my we us our you your he him his she her they " +
    "them their what which who whom how when where why can could will would shall should may might must do " +
    "does did have has had not no yes just than then also too very really um uh oh okay ok like well all " +
    "every each any some"
  ).split(" "),
);

/** @typedef {{ w: string, s: number, e: number }} Token */
/** @typedef {{ text: string, n: number, terms: Set<string> }} Target */
/**
 * @typedef {{
 *   label: string, source_quote: string, got: boolean, override: boolean, span: string | null,
 * }} RecallResult
 */
/** @typedef {{ lev: boolean, score: number, i: number, j: number }} Candidate */

/**
 * Normalized word tokens (lowercase, anything but a-z0-9 is a separator) with their char offsets.
 * @param {string} text
 * @param {number} offset
 * @returns {Token[]}
 */
function tokenize(text, offset) {
  const tokens = [];
  for (const m of text.matchAll(/[A-Za-z0-9]+/g)) {
    const s = offset + /** @type {number} */ (m.index);
    tokens.push({ w: m[0].toLowerCase(), s, e: s + m[0].length });
  }
  return tokens;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 1 - distance / longer length; 0 when the length gap alone rules out the threshold (skips the DP).
 * @param {string} a
 * @param {string} b
 */
function ratio(a, b) {
  const longest = Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > longest * (1 - LEVENSHTEIN_MIN_RATIO)) return 0;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * @param {string} text
 * @returns {Target | null}
 */
function target(text) {
  const words = tokenize(text, 0).map((t) => t.w);
  if (words.length === 0) return null;
  return { text: words.join(" "), n: words.length, terms: new Set(words.filter((w) => !STOPWORDS.has(w))) };
}

/**
 * Levenshtein beats coverage, then higher score, then shorter, then earlier: a total order, so the
 * chosen span is deterministic.
 * @param {Candidate | null} best
 * @param {Candidate} c
 */
function better(best, c) {
  if (best === null) return c;
  if (c.lev !== best.lev) return c.lev ? c : best;
  if (c.score !== best.score) return c.score > best.score ? c : best;
  const len = c.j - c.i;
  const bestLen = best.j - best.i;
  if (len !== bestLen) return len < bestLen ? c : best;
  return c.i < best.i ? c : best;
}

/**
 * Best matching window that ends at or after token `minEnd`: earlier windows were already judged.
 * @param {Token[]} tokens
 * @param {number} minEnd
 * @param {Target[]} targets
 * @returns {Candidate | null}
 */
function bestWindow(tokens, minEnd, targets) {
  /** @type {Candidate | null} */
  let best = null;
  for (const t of targets) {
    for (let len = Math.max(1, t.n - LEVENSHTEIN_SLACK); len <= t.n + LEVENSHTEIN_SLACK; len++) {
      for (let j = Math.max(minEnd, len - 1); j < tokens.length; j++) {
        const i = j - len + 1;
        const text = tokens
          .slice(i, j + 1)
          .map((tk) => tk.w)
          .join(" ");
        const score = ratio(text, t.text);
        if (score >= LEVENSHTEIN_MIN_RATIO) best = better(best, { lev: true, score, i, j });
      }
    }
    if (t.terms.size === 0) continue;
    const maxLen = t.n + COVERAGE_SLACK;
    for (let j = minEnd; j < tokens.length; j++) {
      const found = new Set();
      for (let i = j; i >= 0 && j - i < maxLen; i--) {
        if (t.terms.has(tokens[i].w)) found.add(tokens[i].w);
        const score = found.size / t.terms.size;
        if (score >= COVERAGE_MIN) best = better(best, { lev: false, score, i, j });
      }
    }
  }
  return best;
}

/**
 * @param {{ label?: unknown, source_quote?: unknown }[]} points  palace order
 */
export function createMatcher(points) {
  const state = points.map((p) => {
    const label = String(p?.label ?? "");
    const quote = String(p?.source_quote ?? "");
    const targets = /** @type {Target[]} */ ([target(quote), target(label)].filter((t) => t !== null));
    /** @type {string | null} */
    const span = null;
    return { label, source_quote: quote, targets, got: false, override: false, span };
  });
  let text = "";
  let chunks = 0;
  /** @type {Token[]} */
  const tokens = [];

  return {
    /**
     * @param {string} chunk
     * @returns {number[]} indices newly matched by this chunk, ascending
     */
    append(chunk) {
      const piece = String(chunk ?? "");
      const offset = chunks === 0 ? 0 : text.length + 1;
      text = chunks === 0 ? piece : `${text} ${piece}`;
      chunks += 1;
      const minEnd = tokens.length;
      tokens.push(...tokenize(piece, offset));
      if (tokens.length === minEnd) return [];
      const matched = [];
      state.forEach((p, index) => {
        if (p.got) return;
        const w = bestWindow(tokens, minEnd, p.targets);
        if (w === null) return;
        p.got = true;
        p.span = text.slice(tokens[w.i].s, tokens[w.j].e);
        matched.push(index);
      });
      return matched;
    },
    /**
     * Manual "mark got it": recorded as an override; the span keeps whatever speech produced.
     * @param {number} index
     */
    markGot(index) {
      const p = Number.isInteger(index) ? state[index] : undefined;
      if (p === undefined) return;
      p.got = true;
      p.override = true;
    },
    /** @returns {RecallResult[]} */
    results() {
      return state.map((p) => ({
        label: p.label,
        source_quote: p.source_quote,
        got: p.got,
        override: p.override,
        span: p.span,
      }));
    },
    transcript() {
      return text;
    },
  };
}

/**
 * @param {string} text
 * @param {{ label?: unknown, source_quote?: unknown }[]} points
 * @returns {RecallResult[]}
 */
export function matchTranscript(text, points) {
  const m = createMatcher(points);
  m.append(text);
  return m.results();
}
