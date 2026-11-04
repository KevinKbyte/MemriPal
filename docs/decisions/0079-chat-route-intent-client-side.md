# 0079: Chat route intent is parsed client-side and run through the copilot dispatcher (MEM-132, MEM-133)

Status: Accepted
Date: 2026-11-04

## Context

- Kev asked whether the Pal chat can create walking routes. It cannot: the chat is local-only (no `reply` dep at
  selfMount) and `static/copilot_dispatch.js` is a library wired nowhere, so "route from X to Y" does nothing.
- The MEM-088 route planner (geocode, route, candidates, pickStations) already produces good routes, but only inside
  `route_new.js` find().
- Load demo seeds one route, so the Routes tab looks empty; the planner's good routes are thrown away (MEM-133).

## Options considered

- (A) LLM tool-calling via `src/memripal/chat_provider.py`.
  Pros: free-form phrasing.
  Cons: nondeterministic; needs a server-side tool list; network and spend per message; not testable offline;
  deadline risk.
- (B) Client-side deterministic parse (`parseRouteIntent` in `static/chat_route.js`) plus a `create_route` copilot
  tool (chosen).
  Pros: deterministic, offline, unit-testable; reuses the dispatcher and its undo; no server change.
  Cons: fixed phrasings only. Mitigated: several verbs ("route", "walk", "directions", "take me", "walking route"),
  and any unmatched text falls through to the normal chat reply.
- (C) A dedicated "create route" button only.
  Pros: simplest; no parsing.
  Cons: no chat path, so it fails Kev's ask.

For the curated demo routes (MEM-133):

- (A) Generate offline with `scripts/gen_demo_routes.mjs` from the same `planRoute` into committed
  `static/data/demo_routes.json` (chosen).
  Pros: deterministic (byte-identical on regenerate), fixed ids, no network, matches what the planner makes.
  Cons: must be regenerated when the graph or POIs change.
- (B) Hand-authored JSON.
  Pros: no generator.
  Cons: drifts from the planner.
- (C) Generate at runtime on Load demo.
  Pros: always current.
  Cons: slower; needs the graph fetch before seeding.

## Decision

Route intent: option (B). `parseRouteIntent(text)` returns `{from, to}` or null; a match dispatches `create_route`
through `copilot_dispatch.js` with policy `{create_route: "allow"}`. The tool calls the MEM-088 planner, extracted
into pure `static/route_plan.js::planRoute` (which `route_new.js` find() now also calls), then seeds the route; its
inverse is `routes.deleteRoute(id)`, so undo removes it. `src/memripal/chat_provider.py` is untouched.

Demo routes: option (A), seeded on Load demo alongside DEMO_ROUTE, idempotent by id.

## Why this over the others

(B) is the only option that answers Kev's ask deterministically before the deadline: it runs offline, is covered by
unit and E2E tests, and reuses the dispatcher's allow policy and undo instead of adding a server tool surface. (A)
buys phrasing freedom at the cost of nondeterminism, spend and untestable behavior; (C) drops the chat path entirely.
For demo routes, generating offline from `planRoute` keeps the seeded routes identical to what the planner produces
without (B)'s drift or (C)'s runtime fetch.

## Consequences

- Only the listed phrasings create a route; other text gets the normal chat reply.
- `planRoute` is the single planner for the Routes tab, the chat tool and the demo-route generator.
- `static/data/demo_routes.json` must be regenerated when the graph or POIs change.
