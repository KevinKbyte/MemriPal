// @ts-check
// MEM-042 Download backup / import a backup; every outcome is one textContent line in #backup-status.
// Split out of flow.js (MEM-051) to keep the page wiring under the file-size cap.

import { buildBackup, importBackup, MAX_BACKUP_BYTES, OLD_FORMAT } from "./palace_export.js";

/**
 * @param {import("./flow.js").AppDeps} deps
 * @param {() => Promise<void>} renderHistory
 */
export function wireBackup(deps, renderHistory) {
  const { doc } = deps;
  const status = doc.getElementById("backup-status");
  /** @param {string} text */
  const say = (text) => {
    if (status) status.textContent = text;
  };
  /** @param {unknown} err */
  const why = (err) => (err instanceof Error ? err.message : "unexpected error");
  doc.getElementById("backup-export")?.addEventListener("click", async () => {
    try {
      const backup = await buildBackup(deps);
      const href = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
      const a = /** @type {HTMLAnchorElement} */ (doc.createElement("a"));
      a.href = href;
      a.download = "memripal-backup.json";
      a.click();
      URL.revokeObjectURL(href);
      say("");
    } catch (err) {
      say(`Export failed: ${why(err)}`);
    }
  });
  const input = /** @type {HTMLInputElement | null} */ (doc.getElementById("backup-import"));
  input?.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      // Checked before reading, so an oversized file is never loaded into memory.
      if (file.size > MAX_BACKUP_BYTES) throw new Error(`over ${MAX_BACKUP_BYTES} bytes`);
      const { added, present, skipped } = await importBackup(await file.text(), deps);
      say(`${added} added, ${present} already present${skipped ? `, ${skipped} skipped` : ""}`);
      await renderHistory();
    } catch (err) {
      // The v1 refusal is a full sentence of its own (ADR 0032), not an import failure reason.
      say(why(err) === OLD_FORMAT ? OLD_FORMAT : `Import failed: ${why(err)}`);
    }
  });
}
