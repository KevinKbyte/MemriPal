// @ts-check
// Copilot tool policy (MEM-097): each tool is allow | ask | off. Anything not explicitly set reads as
// off, so a tool added without a policy can never run or reach the model's tool list (fail closed).

export const POLICIES = Object.freeze(["allow", "ask", "off"]);

/** @typedef {"allow" | "ask" | "off"} Policy */
/** @typedef {"run" | "confirm" | "reject"} Decision */

/** @type {Record<Policy, Decision>} */
const DECISIONS = { allow: "run", ask: "confirm", off: "reject" };

/**
 * @param {unknown} value
 * @returns {Policy}
 */
function checkPolicy(value) {
  if (typeof value !== "string" || !POLICIES.includes(value)) {
    throw new Error(`invalid tool policy: ${String(value)}`);
  }
  return /** @type {Policy} */ (value);
}

/**
 * @param {Record<string, string>} [defaults]
 */
export function createToolPolicy(defaults = {}) {
  /** @type {Map<string, Policy>} */
  const policies = new Map();
  for (const [name, value] of Object.entries(defaults)) policies.set(name, checkPolicy(value));

  /**
   * @param {string} name
   * @returns {Policy}
   */
  function get(name) {
    return policies.get(name) ?? "off";
  }

  /**
   * @param {string} name
   * @param {unknown} value
   */
  function set(name, value) {
    policies.set(name, checkPolicy(value));
  }

  /**
   * @template {{ name: string }} T
   * @param {T[]} tools
   * @returns {T[]} the tools the model may see (allow and ask), in input order
   */
  function visibleTools(tools) {
    return tools.filter((t) => get(t.name) !== "off");
  }

  /**
   * @param {string} name
   * @returns {Decision}
   */
  function decide(name) {
    return DECISIONS[get(name)];
  }

  return { get, set, visibleTools, decide };
}
