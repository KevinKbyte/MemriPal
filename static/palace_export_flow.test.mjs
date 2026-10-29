// Covers: MEM-042
// Requirement: the page offers a "Download backup" button and a backup file input, both visible on a
// fresh page. Download writes memripal-backup.json through a Blob URL on a clicked <a download>, then
// revokes the URL; a store over a cap shows an error line and writes no file. Beside the button one
// line warns that the file contains recall transcripts and place names. Import checks the file size
// before reading it, shows "Imported <n>, skipped <m>" or "Import failed: <reason>" as text,
// re-renders the history, and imported strings (incl. an <img onerror> payload) render as literal
// text: no img element is created.
// Contract (RED; GREEN wires static/palace_export.js into wireApp via flow.js / encode.js):
//   index.html has <button id="backup-export">, <input id="backup-import" type="file">, #backup-status.
//   Click #backup-export -> URL.createObjectURL(Blob of the buildBackup JSON), doc.createElement("a")
//     with download "memripal-backup.json" and that href, a.click(), then URL.revokeObjectURL(href).
//   "change" on #backup-import reads files[0]: size > MAX_IMPORT_BYTES -> rejected before file.text().
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakePage, findAll, jsonResponse, settle, until, visibleText } from "./fake_dom_test.mjs";
import { POINT, associationKey, backup, entry, fullRecord, rehearsal, stores } from "./backup_fixtures_test.mjs";

const flow = await import("./flow.js").catch((err) => ({ __missing: String(err) }));
const mod = await import("./palace_export.js").catch((err) => ({ __missing: String(err) }));

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const TURNS = 5000;
const NAME = "memripal-backup.json";
const NOTE = "The backup file contains your recall transcripts and place names.";
const PAYLOAD = "<img src=x onerror=alert(1)>";
const MAX_BYTES = 1048576;

function wireApp() {
  assert.ok("wireApp" in flow, `static/flow.js must export wireApp (${flow.__missing ?? "not exported"})`);
  return flow.wireApp;
}

function api(name) {
  assert.ok(name in mod, `static/palace_export.js must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

const VOID = new Set(["meta", "link", "input", "br", "img", "hr", "source", "area", "base", "col", "embed", "wbr"]);

/** Ids of the index.html elements that enclose `id` (outermost first); null if absent. */
function htmlAncestors(id) {
  const stack = [];
  for (const m of HTML.matchAll(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    const [, close, tag, attrs] = m;
    const name = tag.toLowerCase();
    if (close) {
      const at = stack.map((s) => s.tag).lastIndexOf(name);
      if (at >= 0) stack.length = at;
      continue;
    }
    const own = /\bid="([^"]+)"/.exec(attrs);
    if (own && own[1] === id) return stack.map((s) => s.id).filter(Boolean);
    if (!VOID.has(name)) stack.push({ tag: name, id: own ? own[1] : null });
  }
  return null;
}

function pageFromHtml() {
  const ids = [];
  const hidden = [];
  for (const m of HTML.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
    const id = /\bid="([^"]+)"/.exec(m[0]);
    if (!id) continue;
    ids.push(id[1]);
    if (/\shidden(?=[\s>=/])/.test(m[0])) hidden.push(id[1]);
  }
  return fakePage(ids, { hidden });
}

/** The opening tag of index.html element `id`, or null. */
const tagOf = (id) => HTML.match(new RegExp(`<[a-z][a-z0-9]*\\b[^>]*\\bid="${id}"[^>]*>`, "i"))?.[0] ?? null;

/**
 * A freshly opened page over `s` (backup_fixtures stores). URL.createObjectURL / revokeObjectURL are
 * mocked on t; every <a> the code creates gets a click() spy recording its href/download at click time.
 */
function boot(t, s = stores()) {
  const p = pageFromHtml();
  const blobs = [];
  const revoked = [];
  const clicks = [];
  t.mock.method(URL, "createObjectURL", (blob) => {
    blobs.push(blob);
    return `blob:memripal-test/${blobs.length}`;
  });
  t.mock.method(URL, "revokeObjectURL", (url) => void revoked.push(url));
  const make = p.doc.createElement;
  p.doc.createElement = (tag) => {
    const e = make(tag);
    if (String(tag).toLowerCase() === "a") {
      e.click = () =>
        clicks.push({
          href: e.href ?? e.getAttribute("href"),
          download: e.download ?? e.getAttribute("download"),
          revokedBefore: revoked.length,
        });
    }
    return e;
  };
  wireApp()({
    doc: p.doc,
    fetch: async (url) => (String(url) === "/healthz" ? jsonResponse({ mode: "fixture" }) : jsonResponse({ error: "not_found" }, 404)),
    store: s.store,
    rehearsals: s.rehearsals,
    getUserMedia: undefined,
    location: { hostname: "localhost" },
    loadImage: async (src) => ({ src }),
    confirm: () => true,
    wait: async () => {},
  });
  return { p, s, blobs, revoked, clicks };
}

const el = (b, id) => {
  const e = b.p.els[id];
  assert.ok(e, `index.html must contain #${id}`);
  return e;
};

/** The user can see page element `id`: neither it nor any index.html element around it is hidden. */
function shown(b, id) {
  const chain = htmlAncestors(id);
  assert.ok(chain, `index.html must contain #${id}`);
  return [...chain, id].every((a) => !b.p.els[a]?.hidden);
}

const status = (b) => el(b, "backup-status").textContent.trim();
const written = (s) => s.palaceAdapter.map.size + s.rehAdapter.map.size;
const imgsMade = (b) => b.p.madeByCode().filter((e) => e.tagName === "IMG").length;
const historyRows = (b) =>
  shown(b, "rehearsals") ? el(b, "rehearsals").children.filter((c) => typeof c === "object" && c.tagName === "LI" && !c.hidden) : [];

/** A File-like upload whose text() calls are counted. */
function fileOf(text, size = Buffer.byteLength(text)) {
  const f = { name: NAME, type: "application/json", size, reads: 0 };
  f.text = async () => {
    f.reads += 1;
    return text;
  };
  return f;
}

function chooseFile(b, file) {
  const input = el(b, "backup-import");
  input.files = [file];
  b.p.fire(input, "change");
}

function watchRejections(t) {
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));
  return seen;
}

// Covers: MEM-042
// Requirement: E1 the backup controls are on the page: a visible "Download backup" button, a visible
// file input to import a backup, a status line, and the one-line privacy note beside the button.
describe("MEM-042 E1: backup controls on a fresh page", () => {
  test("#backup-export is a visible Download backup button; #backup-import a visible file input", (t) => {
    const b = boot(t);
    assert.match(tagOf("backup-export") ?? "", /^<button\b/i, "#backup-export is a <button> in index.html");
    assert.match(tagOf("backup-import") ?? "", /^<input\b/i, "#backup-import is an <input> in index.html");
    assert.match(tagOf("backup-import"), /\btype="file"/i, "#backup-import is a file input");
    assert.ok(tagOf("backup-status"), "index.html must contain #backup-status");
    assert.ok(shown(b, "backup-export"), "#backup-export visible on a fresh page");
    assert.ok(shown(b, "backup-import"), "#backup-import visible on a fresh page");
    const label = HTML.match(/<button\b[^>]*\bid="backup-export"[^>]*>([^<]*)</i)?.[1] ?? "";
    assert.ok(/Download backup/.test(label) || /Download backup/.test(el(b, "backup-export").textContent), "button reads Download backup");
  });

  test("the privacy note is on the page, as index.html text or set by the page", async (t) => {
    const b = boot(t);
    await settle(30);
    const byJs = Object.keys(b.p.els).some((id) => shown(b, id) && visibleText(b.p.els[id]).includes(NOTE));
    assert.ok(HTML.includes(NOTE) || byJs, `page shows: ${NOTE}`);
  });
});

// Covers: MEM-042
// Requirement: E1 Download backup writes memripal-backup.json from a Blob URL on a clicked <a download>
// and revokes the URL after the click; a store over an I1 cap shows an error line and writes no file.
describe("MEM-042 E1: Download backup", () => {
  test("click -> Blob of the backup JSON, <a download=memripal-backup.json> clicked, URL revoked after", async (t) => {
    const s = stores();
    await s.store.put(associationKey("milk", "lamp"), entry("milk", "lamp"));
    const r = rehearsal();
    await s.rehearsals.restore(r);
    const b = boot(t, s);
    b.p.fire(el(b, "backup-export"), "click");
    await until(() => b.revoked.length > 0, "object URL revoked", TURNS);
    assert.equal(b.blobs.length, 1, "one Blob URL created");
    assert.ok(b.blobs[0] instanceof Blob, "createObjectURL got a Blob");
    assert.deepEqual(JSON.parse(await b.blobs[0].text()), backup({ associations: [entry("milk", "lamp")], rehearsals: [r] }));
    assert.equal(b.clicks.length, 1, "one <a> clicked");
    assert.equal(b.clicks[0].href, "blob:memripal-test/1", "the anchor points at the Blob URL");
    assert.equal(b.clicks[0].download, NAME, "fixed download name");
    assert.equal(b.clicks[0].revokedBefore, 0, "revoked only after the click");
    assert.deepEqual(b.revoked, ["blob:memripal-test/1"]);
  });

  test("a store over an I1 cap: an error line, no Blob, no download", async (t) => {
    const s = stores();
    for (let i = 0; i < 501; i++) await s.store.put(associationKey(`item ${i}`, "lamp"), entry(`item ${i}`, "lamp"));
    const b = boot(t, s);
    b.p.fire(el(b, "backup-export"), "click");
    await until(() => status(b) !== "", "export error shown", TURNS);
    await settle(30);
    assert.doesNotMatch(status(b), /^Imported/);
    assert.ok(shown(b, "backup-status"), "the error line is visible");
    assert.equal(b.blobs.length, 0, "no file built");
    assert.equal(b.clicks.length, 0, "no download");
  });
});

// Covers: MEM-042
// Requirement: I1/I5 import checks file.size before reading, then reports "Imported <n>, skipped <m>"
// or "Import failed: <reason>" as one text line; a rejected file writes nothing.
describe("MEM-042 I1/I5: Import from the file input", () => {
  test("a file over MAX_IMPORT_BYTES is refused before file.text() is called", async (t) => {
    const rejections = watchRejections(t);
    const b = boot(t);
    const file = fileOf(JSON.stringify(backup({ rehearsals: [rehearsal()] })), MAX_BYTES + 1);
    chooseFile(b, file);
    await until(() => status(b) !== "", "import status shown", TURNS);
    await settle(30);
    assert.equal(file.reads, 0, "file.text() never called");
    assert.match(status(b), /^Import failed: \S/);
    assert.equal(written(b.s), 0, "nothing written");
    assert.deepEqual(rejections, []);
  });

  test("a file exactly MAX_IMPORT_BYTES is read", async (t) => {
    const b = boot(t);
    const file = fileOf(JSON.stringify(backup()), MAX_BYTES);
    chooseFile(b, file);
    await until(() => status(b) !== "", "import status shown", TURNS);
    assert.equal(file.reads, 1);
    assert.equal(status(b), "Imported 0, skipped 0");
  });

  test('status reads "Imported n, skipped m" and the entries are stored', async (t) => {
    const b = boot(t);
    const r = rehearsal();
    chooseFile(b, fileOf(JSON.stringify(backup({ associations: [entry("milk", "lamp"), { record: "bad", status: "valid" }], rehearsals: [r] }))));
    await until(() => status(b) !== "", "import status shown", TURNS);
    assert.equal(status(b), "Imported 2, skipped 1");
    assert.ok(shown(b, "backup-status"), "the status line is visible");
    assert.deepEqual(await b.s.store.get(associationKey("milk", "lamp")), entry("milk", "lamp"));
    assert.deepEqual(await b.s.rehearsals.get(r.id), r);
  });

  test('a rejected file shows "Import failed: <reason>" as text and writes nothing', async (t) => {
    const rejections = watchRejections(t);
    let reason = "";
    await api("importBackup")("[]", stores()).catch((err) => (reason = err.message));
    assert.ok(reason, "importBackup rejects [] with a reason");
    const b = boot(t);
    chooseFile(b, fileOf("[]"));
    await until(() => status(b) !== "", "import status shown", TURNS);
    await settle(30);
    assert.equal(status(b), `Import failed: ${reason}`);
    assert.equal(written(b.s), 0, "nothing written");
    assert.deepEqual(b.p.htmlWrites, [], "no HTML write");
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-042
// Requirement: I5 the rehearsal history and hit rates re-render after an import, without a reload.
describe("MEM-042 I5: history after import", () => {
  test("imported demo rehearsals are listed with their hit rates", async (t) => {
    const b = boot(t);
    await settle(30);
    assert.equal(historyRows(b).length, 0, "empty history before import");
    chooseFile(b, fileOf(JSON.stringify(backup({ rehearsals: [rehearsal(), rehearsal()] }))));
    await until(() => historyRows(b).length === 2, "imported runs listed", TURNS);
    assert.ok(shown(b, "hit-rates"), "hit rates visible");
    assert.ok(visibleText(el(b, "hit-rates")).includes(`${POINT.label}: 2/2`), "hit rates include the imported runs");
  });
});

// Covers: MEM-042
// Requirement: I6 imported strings reach the page only as text: an <img onerror> payload in a
// transcript, a point label and a record field renders literally and creates no img element.
describe("MEM-042 I6: imported strings render as text", () => {
  test("an <img onerror> payload renders as literal text; no img element, no HTML write", async (t) => {
    const b = boot(t);
    await settle(30);
    const imgsBefore = imgsMade(b);
    const r = rehearsal({ transcript: PAYLOAD, points: [{ ...POINT, label: PAYLOAD, source_quote: PAYLOAD, span: PAYLOAD }] });
    const assoc = { record: fullRecord("milk", "lamp", { question: PAYLOAD, visual: PAYLOAD }), status: "valid" };
    chooseFile(b, fileOf(JSON.stringify(backup({ associations: [assoc], rehearsals: [r] }))));
    await until(() => historyRows(b).length === 1, "imported run listed", TURNS);
    assert.equal(status(b), "Imported 2, skipped 0");
    assert.ok(visibleText(el(b, "hit-rates")).includes(`${PAYLOAD}: 1/1`), "point label shown literally in hit rates");
    const view = findAll(historyRows(b)[0], (n) => n.tagName === "BUTTON" && /^\s*View\b/.test(n.textContent))[0];
    assert.ok(view, "the imported run has a View button");
    b.p.fire(view, "click");
    await until(() => visibleText(el(b, "history-view")).includes(PAYLOAD), "viewed run shows the payload", TURNS);
    assert.deepEqual(b.p.htmlWrites, [], "no innerHTML / outerHTML / insertAdjacentHTML");
    assert.equal(imgsMade(b), imgsBefore, "no img element created");
    assert.equal((await b.s.rehearsals.get(r.id)).transcript, PAYLOAD, "transcript stored literally");
    assert.deepEqual(await b.s.store.get(associationKey("milk", "lamp")), { record: assoc.record, status: "invalid" }, "record stored literally; unsigned valid demoted (I3)");
  });
});
