// @ts-check
// Random v4 UUIDs for the local stores. crypto.randomUUID exists only in a secure context (https or
// localhost); a plain-http host such as a LAN IP or the e2e public host has crypto.getRandomValues only.

/**
 * A random RFC 4122 v4 UUID: crypto.randomUUID when present, else built from crypto.getRandomValues.
 * @param {{ randomUUID?: () => string, getRandomValues: (a: Uint8Array) => Uint8Array }} [c]
 * @returns {string}
 */
export function newId(c = globalThis.crypto) {
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
