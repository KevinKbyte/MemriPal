// @ts-check
// MemriPal frontend shell: shows backend health. Served as a raw ES module (no build step).

/**
 * @param {{status?: string, mode?: string} | null} health
 * @returns {string}
 */
export function formatHealth(health) {
  if (!health || health.status !== "ok") return "Backend unavailable";
  return `Backend ok (${health.mode} mode)`;
}

async function showHealth() {
  const el = document.getElementById("status");
  if (!el) return;
  try {
    const resp = await fetch("/healthz");
    el.textContent = formatHealth(resp.ok ? await resp.json() : null);
  } catch {
    el.textContent = formatHealth(null);
  }
}

// Guard keeps the module importable under node --test.
if (typeof document !== "undefined") showHealth();
