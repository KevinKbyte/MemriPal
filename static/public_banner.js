// @ts-check
// Public-URL banner (MEM-035, D13): on the deployed host, tell visitors live mode needs a passcode.

// location.hostname brackets IPv6 literals; "" covers file: and other host-less pages.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

/**
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPublicHost(hostname) {
  return !LOOPBACK_HOSTS.has(String(hostname).toLowerCase());
}

/**
 * Unhide #public-banner when served from a public host; a page without it is left alone.
 * @param {{getElementById: (id: string) => {hidden: boolean} | null}} doc
 * @param {string} hostname
 */
export function showPublicBanner(doc, hostname) {
  const banner = doc.getElementById("public-banner");
  if (banner && isPublicHost(hostname)) banner.hidden = false;
}
