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
      if (typeof step === "function") {
        // Steps must be sync: an awaited write would land after the transaction commits.
        const result = step(db);
        if (typeof result?.then === "function") {
          // The refused step may still reject later; nobody else holds its promise to handle that.
          // Promise.resolve, not result.then: a bare thenable may call whichever callback it is given.
          Promise.resolve(result).catch(() => {});
          throw new Error(`migration ${i} returned a thenable; migration steps must be sync`);
        }
      } else db.exec(step);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}
