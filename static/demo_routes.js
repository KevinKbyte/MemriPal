// @ts-check
// Curated demo routes (MEM-133, ADR 0079): Load demo seeds the planner-made routes committed in
// static/data/demo_routes.json (scripts/gen_demo_routes.mjs). Seeding is idempotent by id (seedRoute);
// an unreachable or malformed file seeds nothing and never rejects, so the room demo is never blocked.

const DEMO_ROUTES_URL = "/static/data/demo_routes.json";

/**
 * @param {typeof fetch} fetchFn
 * @param {ReturnType<typeof import("./route_store.js").createRouteStore>} routes
 * @returns {Promise<void>} never rejects
 */
export async function seedDemoRoutes(fetchFn, routes) {
  let list;
  try {
    const r = await fetchFn(DEMO_ROUTES_URL);
    list = r.ok ? await r.json() : null;
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  for (const route of list) {
    if (typeof route?.id !== "string" || !Array.isArray(route.stations)) continue;
    await routes.seedRoute(route).catch(() => {});
  }
}
