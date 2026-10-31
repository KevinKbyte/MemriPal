// Covers: MEM-063
// Requirement: one client helper (static/api_base.js) owns the API base: on the web it is '' so
// every request stays same-origin exactly as before (judges' Cloud Run URL unchanged); in the native
// shell the build's runtime_config.js supplies the Cloud Run origin. No other static/*.js calls a
// global fetch with a root-relative path or grabs the global fetch without wrapping it in the helper.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const STATIC = new URL("./", import.meta.url);
const HELPER = "api_base.js";
const helperUrl = new URL(`./${HELPER}`, import.meta.url);

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const sources = () =>
  readdirSync(STATIC)
    .filter((f) => f.endsWith(".js") && f !== HELPER)
    .map((f) => [f, stripComments(readFileSync(new URL(f, STATIC), "utf8"))]);

async function helper() {
  assert.ok(existsSync(helperUrl), "static/api_base.js missing");
  return import(helperUrl.href);
}

// Covers: MEM-063
// Requirement: on the web the API base is '' and requests pass through untouched.
describe("api_base.js on the web", () => {
  test("apiUrl leaves root-relative paths unchanged", async () => {
    const { apiUrl } = await helper();
    assert.equal(apiUrl("/healthz"), "/healthz");
    assert.equal(apiUrl("/demo/photo.jpg?room=r1"), "/demo/photo.jpg?room=r1");
  });

  test("withApiBase forwards url and the same init object unchanged", async () => {
    const { withApiBase } = await helper();
    const calls = [];
    const wrapped = withApiBase(async (url, init) => {
      calls.push([url, init]);
      return { ok: true, status: 200 };
    });
    const init = { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: "b" };
    const resp = await wrapped("/loci", init);
    assert.equal(String(calls[0][0]), "/loci");
    assert.equal(calls[0][1], init);
    assert.deepEqual(resp, { ok: true, status: 200 });
  });

  test("withApiBase with no init still calls through with the bare path", async () => {
    const { withApiBase } = await helper();
    const calls = [];
    await withApiBase(async (url, init) => calls.push([String(url), init]))("/demo/notes.txt");
    assert.equal(calls[0][0], "/demo/notes.txt");
  });
});

// Covers: MEM-063
// Requirement: the helper is the single place the real network fetch is bound to the API base.
describe("single API-base helper (grep)", () => {
  test("no bare fetch('/...') with a root-relative literal outside api_base.js", () => {
    const bare = /(?<![\w.$])fetch\(\s*["'`]\//g;
    const hits = sources().flatMap(([f, src]) => (src.match(bare) ?? []).map((m) => `${f}: ${m}`));
    assert.deepEqual(hits, []);
  });

  test("every global fetch acquisition is wrapped in withApiBase", () => {
    const raw = /fetch\.bind\(\s*globalThis\s*\)|globalThis\.fetch\b|window\.fetch\b/g;
    const wrapped = /withApiBase\(\s*(?:fetch\.bind\(\s*globalThis\s*\)|globalThis\.fetch|window\.fetch)/g;
    let total = 0;
    for (const [f, src] of sources()) {
      const r = (src.match(raw) ?? []).length;
      const w = (src.match(wrapped) ?? []).length;
      assert.equal(w, r, `${f}: ${r - w} global fetch use(s) not wrapped in withApiBase`);
      total += w;
    }
    assert.ok(total >= 1, "no static/*.js wires withApiBase around the global fetch");
  });

  test("app.js imports withApiBase from ./api_base.js", () => {
    const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
    assert.match(app, /import\s*\{[^}]*\bwithApiBase\b[^}]*\}\s*from\s*["']\.\/api_base\.js["']/);
  });
});
