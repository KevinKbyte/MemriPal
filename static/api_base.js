// @ts-check
// Single owner of the API base (MEM-063): root-relative API paths are resolved against API_BASE,
// which is '' on the web (same-origin) and the Cloud Run origin inside the Capacitor shell.
import { API_BASE } from "./runtime_config.js";

/**
 * @param {string} path
 * @returns {string}
 */
export function apiUrl(path) {
  // "//host" is protocol-relative, not an API path: never prefix it.
  if (!API_BASE || !path.startsWith("/") || path.startsWith("//")) return path;
  return API_BASE + path;
}

/**
 * @param {typeof fetch} fetchFn
 * @returns {typeof fetch}
 */
export function withApiBase(fetchFn) {
  return (url, init) => fetchFn(typeof url === "string" ? apiUrl(url) : url, init);
}
