// @ts-check
// Pal chat route creation (MEM-132, ADR 0079): "route from X to Y" is parsed here, client-side, planned by
// route_plan.js over the committed Kendall graph + POIs, and run as the copilot tool create_route through
// copilot_dispatch.js, so the undo stack can remove it. The only server call is the optional Spark emoji pick
// (MEM-140), which falls back offline; never throws into the chat.

import { createDispatcher } from "./copilot_dispatch.js";
import { pickLandmarkEmoji, sparkEmojiClient } from "./landmark_emoji_spark.js";
import { planRoute } from "./route_plan.js";
import { createToolPolicy } from "./tool_policy.js";
import { createUndoStack } from "./undo_stack.js";
import { newId as uuid } from "./uuid.js";

const FAIL = "I couldn't make that route. Try again.";
const INTENT = /^(?:please\s+)?(?:walking route|route|walk|directions|take me)\s+from\s+(.+)$/i;
const GRAPH_URL = "/static/data/kendall_walk_graph.json";
const POIS_URL = "/static/data/kendall_pois.json";

/**
 * @param {unknown} text
 * @returns {{ from: string, to: string } | null}
 */
export function parseRouteIntent(text) {
  if (typeof text !== "string") return null;
  const m = INTENT.exec(text.trim().replace(/[.!?]+$/, ""));
  // Greedy head: the last " to " splits X from Y.
  const parts = m && /^(.*)\s+to\s+(.*)$/is.exec(m[1]);
  if (!parts) return null;
  const from = parts[1].trim();
  const to = parts[2].trim();
  return from && to ? { from, to } : null;
}

/**
 * @param {{
 *   routes: ReturnType<typeof import("./route_store.js").createRouteStore>,
 *   load: () => Promise<{ graph: any, pois: any[] }>,
 *   newId?: () => string,
 *   spark?: import("./landmark_emoji_spark.js").Spark | null,
 * }} deps
 */
export function createRouteTool({ routes, load, newId = uuid, spark }) {
  return {
    name: "create_route",
    /** @param {any} args */
    async run({ from, to }) {
      const plan = planRoute(from, to, await load());
      if (!plan.ok) return { result: { ok: false, text: plan.text } };
      const id = newId();
      const { name } = plan;
      // MEM-140: the emoji is picked before the save, so the stored stations carry it (ADR 0057).
      const stations = await Promise.all(plan.stations.map(async (st) =>
        ({ ...st, emoji: await pickLandmarkEmoji({ name: st.name }, { spark }) })));
      await routes.seedRoute({ id, name, kind: "daily", stations });
      const text = `Made your route ${name} with ${stations.length} stops. It's on the Routes tab.`;
      return { result: { ok: true, id, name, text }, inverse: () => routes.deleteRoute(id) };
    },
  };
}

/**
 * @param {{
 *   dispatcher: { dispatch: (name: string, args: unknown) => Promise<{ status: string, result?: any }> },
 *   onCreated: (id: string) => unknown,
 * }} deps
 */
export function createChatRouteActor({ dispatcher, onCreated }) {
  return {
    /** @param {string} text @returns {Promise<string | null>} null when the text is not a route ask */
    async act(text) {
      const intent = parseRouteIntent(text);
      if (!intent) return null;
      let out;
      try {
        out = await dispatcher.dispatch("create_route", intent);
      } catch {
        return FAIL;
      }
      const result = out?.result;
      if (out?.status === "ok" && result?.ok === true) {
        try {
          await onCreated(result.id);
        } catch {
          // The route is saved; a failed refresh only delays its card.
        }
        return result.text;
      }
      if (result?.ok === false && typeof result.text === "string") return result.text;
      return FAIL;
    },
  };
}

/**
 * The page's chat route actor: create_route allowed, graph + POIs fetched once (a failed fetch is retried).
 * @param {{
 *   routes: ReturnType<typeof import("./route_store.js").createRouteStore>,
 *   fetch: typeof fetch,
 *   onCreated: (id: string) => unknown,
 *   sparkFetch?: typeof fetch,
 * }} deps sparkFetch carries the passcode for the Spark emoji route (MEM-140)
 */
export function createPageRouteActor({ routes, fetch, onCreated, sparkFetch = fetch }) {
  /** @type {Promise<{ graph: any, pois: any[] }> | null} */
  let data = null;
  /** @param {string} url */
  const json = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  };
  const load = () => {
    data ??= Promise.all([json(GRAPH_URL), json(POIS_URL)]).then(([graph, pois]) => ({ graph, pois }));
    return data.catch((err) => {
      data = null;
      throw err;
    });
  };
  const dispatcher = createDispatcher({
    policy: createToolPolicy({ create_route: "allow" }),
    undo: createUndoStack(),
    tools: { create_route: createRouteTool({ routes, load, spark: sparkEmojiClient(sparkFetch) }) },
    confirm: () => false,
  });
  return createChatRouteActor({ dispatcher, onCreated });
}
