// SQL KV adapter for route_store.js (MEM-039 S2): same get/put/delete/list seam as idb_adapter.js.
// "route:<id>" <-> { type: "route", route } lives in the routes + stations tables (schema.js);
// "photo:<ref>" keys pass through to photoKv (photo bytes stay in IndexedDB). Soft delete only: rows are
// stamped deleted_at, never removed (full purge is a later Settings feature with its own approval).
// A value that does not fit its column (wrong type, extra keys) is kept in raw_json, so every route
// reads back as written.

const ROUTE = "route:";
const PHOTO = "photo:";

const ROUTE_COLS = ["name", "kind", "status", "created_at"];
const STATION_TEXT = { name: "name", photo_ref: "photo_id", status: "status" };
const BOX = ["x1", "y1", "x2", "y2"];
const COORDS = ["lat", "lon"];
const STATION_COLS = ["route_id", "id", "pos", "n", "name", "photo_id", "status", "box_x1", "box_y1", "box_x2",
  "box_y2", "lat", "lon", "profile_json", "taps_json", "raw_json"];

const isPlain = (v) => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
// Only an object with exactly these keys, all finite numbers, maps to columns; anything else goes raw.
const numObj = (v, keys) =>
  isPlain(v) && Object.keys(v).length === keys.length && keys.every((k) => isNum(v[k]));
const strMap = (v) => isPlain(v) && Object.values(v).every((x) => typeof x === "string");

const ROUTE_UPSERT = `INSERT INTO routes (id, ${ROUTE_COLS.join(", ")}, lists_json, raw_json, ord, deleted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(ord), 0) + 1 FROM routes), NULL)
  ON CONFLICT(id) DO UPDATE SET ${ROUTE_COLS.map((c) => `${c} = excluded.${c}`).join(", ")},
    lists_json = excluded.lists_json, raw_json = excluded.raw_json,
    ord = CASE WHEN routes.deleted_at IS NULL THEN routes.ord ELSE excluded.ord END, deleted_at = NULL`;

const STATION_UPSERT = `INSERT INTO stations (${STATION_COLS.join(", ")}, deleted_at)
  VALUES (${STATION_COLS.map(() => "?").join(", ")}, NULL)
  ON CONFLICT(route_id, id) DO UPDATE SET
    ${STATION_COLS.slice(2).map((c) => `${c} = excluded.${c}`).join(", ")}, deleted_at = NULL`;

function routeParams(route) {
  const raw = {};
  const cols = {};
  for (const [k, v] of Object.entries(route)) {
    if (k === "id" || v === undefined) continue;
    if (ROUTE_COLS.includes(k) && typeof v === "string") cols[k] = v;
    else if (k === "lists" && Array.isArray(v)) cols.lists_json = JSON.stringify(v);
    else if (k !== "stations" || !Array.isArray(v)) raw[k] = v;
  }
  return [route.id, ...ROUTE_COLS.map((c) => cols[c] ?? null), cols.lists_json ?? null, JSON.stringify(raw)];
}

function stationParams(routeId, s, pos) {
  const raw = {};
  const c = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "id" || v === undefined) continue;
    if (k in STATION_TEXT && typeof v === "string") c[STATION_TEXT[k]] = v;
    else if (k === "n" && Number.isInteger(v)) c.n = v;
    else if (k === "box" && numObj(v, BOX)) BOX.forEach((b) => (c[`box_${b}`] = v[b]));
    else if (k === "coords" && numObj(v, COORDS)) COORDS.forEach((b) => (c[b] = v[b]));
    else if ((k === "profile" || k === "taps") && strMap(v)) c[`${k}_json`] = JSON.stringify(v);
    else raw[k] = v;
  }
  c.route_id = routeId;
  c.id = s.id;
  c.pos = pos;
  c.raw_json = JSON.stringify(raw);
  return STATION_COLS.map((col) => c[col] ?? null);
}

function readStation(row) {
  const s = { id: row.id };
  if (row.n !== null) s.n = row.n;
  for (const [k, col] of Object.entries(STATION_TEXT)) if (row[col] !== null) s[k] = row[col];
  if (row.box_x1 !== null) s.box = Object.fromEntries(BOX.map((b) => [b, row[`box_${b}`]]));
  if (row.lat !== null) s.coords = { lat: row.lat, lon: row.lon };
  if (row.profile_json !== null) s.profile = JSON.parse(row.profile_json);
  if (row.taps_json !== null) s.taps = JSON.parse(row.taps_json);
  return Object.assign(s, JSON.parse(row.raw_json));
}

function readRoute(row, stationRows) {
  const r = { id: row.id };
  for (const c of ROUTE_COLS) if (row[c] !== null) r[c] = row[c];
  r.stations = stationRows.map(readStation);
  if (row.lists_json !== null) r.lists = JSON.parse(row.lists_json);
  return { type: "route", route: Object.assign(r, JSON.parse(row.raw_json)) };
}

function routeIdOf(key) {
  if (typeof key === "string" && key.startsWith(ROUTE)) return key.slice(ROUTE.length);
  if (typeof key === "string" && key.startsWith(PHOTO)) return null;
  throw new TypeError(`unsupported key ${String(key)}`);
}

const LIVE_STATIONS = "SELECT * FROM stations WHERE deleted_at IS NULL";

/**
 * @param {{ exec: Function, query: Function, transaction: (stmts: {sql: string, params: any[]}[]) => Promise<any> }} db
 *   async client (client.js) over a database migrated with schema.js MIGRATIONS
 * @param {{ get: Function, put: Function, delete: Function }} photoKv
 */
export function createSqlRouteAdapter(db, photoKv) {
  return {
    async get(key) {
      const id = routeIdOf(key);
      if (id === null) return photoKv.get(key);
      const [row] = await db.query("SELECT * FROM routes WHERE id = ? AND deleted_at IS NULL", [id]);
      if (!row) return undefined;
      return readRoute(row, await db.query(`${LIVE_STATIONS} AND route_id = ? ORDER BY pos`, [id]));
    },

    async put(key, value) {
      const id = routeIdOf(key);
      if (id === null) return photoKv.put(key, value);
      const route = value?.route;
      if (value?.type !== "route" || !isPlain(route) || route.id !== id) {
        throw new TypeError(`${key} needs a { type: "route", route } value with route.id ${id}`);
      }
      const stations = Array.isArray(route.stations) ? route.stations : [];
      const ids = new Set();
      for (const s of stations) {
        if (!isPlain(s) || typeof s.id !== "string") throw new TypeError(`route ${id}: a station needs a string id`);
        if (ids.has(s.id)) throw new TypeError(`route ${id}: duplicate station id ${s.id}`);
        ids.add(s.id);
      }
      const now = new Date().toISOString();
      // Tombstone every live station first, then revive/insert the listed ones at their new positions:
      // a dropped station stays deleted, and a reorder never collides on the live (route_id, pos) index.
      await db.transaction([
        { sql: ROUTE_UPSERT, params: routeParams(route) },
        {
          sql: "UPDATE stations SET deleted_at = ?, pos = NULL WHERE route_id = ? AND deleted_at IS NULL",
          params: [now, id],
        },
        ...stations.map((s, pos) => ({ sql: STATION_UPSERT, params: stationParams(id, s, pos) })),
      ]);
    },

    async delete(key) {
      const id = routeIdOf(key);
      if (id === null) return photoKv.delete(key);
      const now = new Date().toISOString();
      await db.transaction([
        { sql: "UPDATE routes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", params: [now, id] },
        { sql: "UPDATE stations SET deleted_at = ? WHERE route_id = ? AND deleted_at IS NULL", params: [now, id] },
      ]);
    },

    async list() {
      const routes = await db.query("SELECT * FROM routes WHERE deleted_at IS NULL ORDER BY ord");
      const rows = await db.query(
        `${LIVE_STATIONS} AND route_id IN (SELECT id FROM routes WHERE deleted_at IS NULL) ORDER BY route_id, pos`);
      const byRoute = new Map();
      for (const s of rows) {
        if (!byRoute.has(s.route_id)) byRoute.set(s.route_id, []);
        byRoute.get(s.route_id).push(s);
      }
      return routes.map((r) => readRoute(r, byRoute.get(r.id) ?? []));
    },
  };
}
