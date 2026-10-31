// SQLite schema migrations for runMigrations (migrations.js): MIGRATIONS[i] moves user_version i -> i+1.

// V1 (MEM-039): routes + stations. Mapped columns are nullable (NULL = key absent); anything unmapped or
// not type-valid for its column lives in raw_json. Stations are keyed (route_id, id) because imported
// routes keep their station ids; pos is array order. Photo bytes stay in IndexedDB: no BLOB column.
// Soft delete: deleted_at NULL = live. Rows are never hard-deleted (purge is a later Settings feature),
// so pos is unique among live stations only; a station dropped from its route stays as a tombstone with
// pos NULL. routes.ord is list order (insert and revive take max + 1).
const V1 = `
CREATE TABLE routes (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  name TEXT,
  kind TEXT,
  status TEXT,
  created_at TEXT,
  lists_json TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  ord INTEGER,
  deleted_at TEXT
);
CREATE TABLE stations (
  route_id TEXT NOT NULL REFERENCES routes(id),
  id TEXT NOT NULL,
  pos INTEGER,
  n INTEGER,
  name TEXT,
  photo_id TEXT,
  status TEXT,
  box_x1 REAL,
  box_y1 REAL,
  box_x2 REAL,
  box_y2 REAL,
  lat REAL,
  lon REAL,
  profile_json TEXT,
  taps_json TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  deleted_at TEXT,
  PRIMARY KEY (route_id, id)
);
CREATE UNIQUE INDEX stations_live_pos ON stations(route_id, pos) WHERE deleted_at IS NULL;
CREATE INDEX stations_photo ON stations(photo_id);
`;

export const MIGRATIONS = [V1];
