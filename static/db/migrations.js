// Schema migrations keyed on PRAGMA user_version: migrations[i] moves version i -> i+1.

export class DbNewerError extends Error {
  constructor(message) {
    super(message);
    this.name = "DbNewerError";
  }
}

export async function runMigrations(db, migrations) {
  const rows = await db.query("PRAGMA user_version");
  const current = rows[0].user_version;
  if (current > migrations.length) {
    throw new DbNewerError(`database version ${current} is newer than this app (${migrations.length})`);
  }
  for (let i = current; i < migrations.length; i++) {
    const step = migrations[i];
    // The version bump shares the migration's transaction so a failure can never leave it lying.
    await db.transaction(() => {
      if (typeof step === "function") step(db);
      else db.exec(step);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}
