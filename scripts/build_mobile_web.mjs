// Build the Capacitor shell's www/ bundle from the web UI (MEM-063). Node built-ins only.
// Usage: MEMRIPAL_API_BASE=https://<cloud-run-host> node scripts/build_mobile_web.mjs
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const STATIC = join(REPO, "static");
const WWW = join(REPO, "www");

/** The env value as a bare https origin, or null for anything else (path, query, credentials...). */
function parseApiBase(raw) {
  const value = (raw ?? "").trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // Exact-origin match rejects paths, queries, fragments and even a trailing "/" or "?".
  if (url.protocol !== "https:" || url.username || url.password || value !== url.origin) return null;
  return url.origin;
}

function nativeCsp(api) {
  return [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    `connect-src 'self' ${api}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

const isTest = (path) => path.endsWith(".test.mjs") || path.endsWith("_test.mjs");

function main() {
  const api = parseApiBase(process.env.MEMRIPAL_API_BASE);
  if (!api) {
    console.error("MEMRIPAL_API_BASE must be an https origin like https://host[:port] (no path, query or credentials)");
    process.exit(1);
  }
  rmSync(WWW, { recursive: true, force: true });
  cpSync(STATIC, join(WWW, "static"), { recursive: true, filter: (src) => !isTest(src) });
  writeFileSync(join(WWW, "static", "runtime_config.js"), `export const API_BASE = ${JSON.stringify(api)};\n`);

  const html = readFileSync(join(STATIC, "index.html"), "utf8");
  if (!/<head>/i.test(html)) throw new Error("static/index.html has no <head>");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${nativeCsp(api)}">`;
  writeFileSync(join(WWW, "index.html"), html.replace(/<head>/i, (m) => `${m}\n    ${meta}`));
  console.log(`www/ built for ${api}`);
}

main();
