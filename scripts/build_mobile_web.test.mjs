// Covers: MEM-063
// Requirement: the Android Capacitor shell bundles the existing web UI unchanged. Running
// `node scripts/build_mobile_web.mjs` (no deps) cleans www/, copies static/index.html to
// www/index.html and static/** to www/static/** (minus *.test.mjs), writes
// www/static/runtime_config.js pointing the client at MEMRIPAL_API_BASE (an https origin only: no
// path, query, fragment or credentials; unset or invalid exits non-zero), and injects a CSP meta into
// www/index.html whose connect-src is exactly 'self' plus that API origin.
// Run: node --test "scripts/*.test.mjs"
import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, "scripts", "build_mobile_web.mjs");
const WWW = join(REPO, "www");
const STATIC = join(REPO, "static");
const API = "https://memripal-abc123-uc.a.run.app";

let importSeq = 0;
const freshImport = (path) => import(`${pathToFileURL(path).href}?n=${++importSeq}`);

function build(apiBase) {
  assert.ok(existsSync(SCRIPT), `missing ${relative(REPO, SCRIPT)}`);
  const env = { ...process.env };
  delete env.MEMRIPAL_API_BASE;
  if (apiBase !== undefined) env.MEMRIPAL_API_BASE = apiBase;
  return spawnSync(process.execPath, [SCRIPT], { cwd: REPO, env, encoding: "utf8" });
}

function buildOk(apiBase = API) {
  const r = build(apiBase);
  assert.equal(r.status, 0, `build failed (${r.status}): ${r.stderr}`);
  return r;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function cspMeta(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = Object.fromEntries(
      [...tag.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)].map(([, k, v]) => [k.toLowerCase(), v]),
    );
    if ((attrs["http-equiv"] ?? "").toLowerCase() === "content-security-policy") return { tag, csp: attrs.content };
  }
  return null;
}

function directives(csp) {
  return Object.fromEntries(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...values]) => [name.toLowerCase(), values]),
  );
}

// Covers: MEM-063
// Requirement: a valid https API origin yields a complete www/ bundle of the web UI.
describe("build_mobile_web.mjs: bundle contents", () => {
  before(() => buildOk());

  test("www/index.html is the web shell and still loads /static/app.js", () => {
    const html = readFileSync(join(WWW, "index.html"), "utf8");
    assert.match(html, /<script[^>]*type="module"[^>]*src="\/static\/app\.js"/);
  });

  test("every /static/ asset referenced by www/index.html exists under www/", () => {
    const html = readFileSync(join(WWW, "index.html"), "utf8");
    const refs = [...html.matchAll(/(?:href|src)="(\/static\/[^"?#]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 3, `expected several /static/ refs, got ${refs.length}`);
    for (const ref of refs) assert.ok(existsSync(join(WWW, ref)), `www${ref} missing`);
  });

  test("static/** is copied recursively (nested assets included)", () => {
    for (const rel of ["app.js", "flow.js", "style.css", "manifest.webmanifest", "assets/icon-192.png"]) {
      assert.ok(existsSync(join(WWW, "static", rel)), `www/static/${rel} missing`);
    }
    const src = readFileSync(join(STATIC, "app.js"), "utf8");
    assert.equal(readFileSync(join(WWW, "static", "app.js"), "utf8"), src, "app.js must be copied verbatim");
  });

  test("no *.test.mjs file is shipped", () => {
    const shipped = walk(join(WWW, "static")).filter((f) => f.endsWith(".test.mjs"));
    assert.deepEqual(shipped.map((f) => relative(WWW, f)), []);
  });

  test("www/static/runtime_config.js carries the API origin", () => {
    const cfg = join(WWW, "static", "runtime_config.js");
    assert.ok(existsSync(cfg), "www/static/runtime_config.js missing");
    assert.ok(readFileSync(cfg, "utf8").includes(API), "runtime_config.js does not mention the API origin");
  });

  test("bundled api_base.js resolves API paths against the configured origin", async () => {
    const { apiUrl } = await freshImport(join(WWW, "static", "api_base.js"));
    assert.equal(apiUrl("/healthz"), `${API}/healthz`);
    assert.equal(apiUrl("/demo/photo.jpg?room=r1"), `${API}/demo/photo.jpg?room=r1`);
  });

  test("bundled withApiBase sends requests to the API origin and keeps init", async () => {
    const { withApiBase } = await freshImport(join(WWW, "static", "api_base.js"));
    const calls = [];
    const wrapped = withApiBase(async (url, init) => {
      calls.push([url, init]);
      return { ok: true };
    });
    const init = { method: "POST", body: "x" };
    await wrapped("/split", init);
    assert.equal(String(calls[0][0]), `${API}/split`);
    assert.equal(calls[0][1], init);
  });

  test("passcode still rides on model routes when the API base is applied (native)", async () => {
    const { withApiBase } = await freshImport(join(WWW, "static", "api_base.js"));
    const { withPasscode } = await freshImport(join(WWW, "static", "flow.js"));
    const calls = [];
    const inner = async (url, init) => {
      calls.push([String(url), new Headers(init?.headers)]);
      return { ok: true };
    };
    const doc = { getElementById: (id) => (id === "passcode" ? { value: "s3cret" } : null) };
    await withPasscode(withApiBase(inner), doc)("/loci", { method: "POST" });
    assert.equal(calls[0][0], `${API}/loci`);
    assert.equal(calls[0][1].get("X-Memripal-Passcode"), "s3cret");
  });
});

// Covers: MEM-063
// Requirement: www/index.html carries a CSP meta whose connect-src is exactly 'self' plus the API
// origin, so the native WebView can reach Cloud Run and nothing else; no wildcard, no eval.
describe("build_mobile_web.mjs: native CSP meta", () => {
  before(() => buildOk());

  test("CSP meta is present in <head> before any script", () => {
    const html = readFileSync(join(WWW, "index.html"), "utf8");
    const meta = cspMeta(html);
    assert.ok(meta, "www/index.html has no Content-Security-Policy meta");
    const at = html.indexOf(meta.tag);
    assert.ok(at < html.indexOf("</head>"), "CSP meta must sit in <head>");
    assert.ok(at < html.indexOf("<script"), "CSP meta must precede scripts");
  });

  test("connect-src is exactly 'self' and the API origin", () => {
    const meta = cspMeta(readFileSync(join(WWW, "index.html"), "utf8"));
    assert.ok(meta, "www/index.html has no Content-Security-Policy meta");
    const d = directives(meta.csp);
    assert.deepEqual([...(d["connect-src"] ?? [])].sort(), ["'self'", API].sort());
  });

  test("no wildcard source and no unsafe-eval / unsafe-inline scripts", () => {
    const meta = cspMeta(readFileSync(join(WWW, "index.html"), "utf8"));
    assert.ok(meta, "www/index.html has no Content-Security-Policy meta");
    const d = directives(meta.csp);
    for (const [name, values] of Object.entries(d)) {
      assert.ok(!values.includes("*"), `${name} must not contain *`);
    }
    assert.deepEqual(d["default-src"], ["'self'"]);
    const scripts = d["script-src"] ?? d["default-src"];
    assert.ok(!scripts.includes("'unsafe-eval'") && !scripts.includes("'unsafe-inline'"));
  });

  test("a different API origin is injected verbatim (port kept)", () => {
    const other = "https://api.example.com:8443";
    buildOk(other);
    const meta = cspMeta(readFileSync(join(WWW, "index.html"), "utf8"));
    assert.ok(meta, "www/index.html has no Content-Security-Policy meta");
    assert.deepEqual([...directives(meta.csp)["connect-src"]].sort(), ["'self'", other].sort());
  });
});

// Covers: MEM-063
// Requirement: the web shell served by Cloud Run is unchanged: static/index.html carries no CSP
// meta (the web CSP comes from the server header).
describe("web shell untouched by the native CSP", () => {
  test("static/index.html stays CSP-meta free", () => {
    assert.equal(cspMeta(readFileSync(join(STATIC, "index.html"), "utf8")), null);
  });
});

// Covers: MEM-063
// Requirement: each build starts from an empty www/, so stale files never ship.
describe("build_mobile_web.mjs: cleans www/ first", () => {
  test("a stale file in www/ is gone after a build", () => {
    assert.ok(existsSync(SCRIPT), `missing ${relative(REPO, SCRIPT)}`);
    mkdirSync(join(WWW, "static"), { recursive: true });
    writeFileSync(join(WWW, "stale.txt"), "old");
    writeFileSync(join(WWW, "static", "old.test.mjs"), "old");
    buildOk();
    assert.ok(!existsSync(join(WWW, "stale.txt")), "www/stale.txt survived the build");
    assert.ok(!existsSync(join(WWW, "static", "old.test.mjs")), "www/static/old.test.mjs survived");
  });
});

// Covers: MEM-063
// Requirement: MEMRIPAL_API_BASE must be an https origin; anything else fails the build loudly and
// never ends up in runtime_config.js.
describe("build_mobile_web.mjs: rejects a missing or invalid API base", () => {
  test("unset MEMRIPAL_API_BASE exits non-zero naming the variable", () => {
    const r = build(undefined);
    assert.notEqual(r.status, 0, "build must fail without MEMRIPAL_API_BASE");
    assert.match(r.stderr, /MEMRIPAL_API_BASE/);
  });

  test("blank MEMRIPAL_API_BASE exits non-zero", () => {
    assert.notEqual(build("   ").status, 0);
  });

  for (const bad of [
    "http://memripal.example.com",
    "https://memripal.example.com/api",
    "https://memripal.example.com/?x=1",
    "https://memripal.example.com/#frag",
    "https://user:pw@memripal.example.com",
    "javascript:alert(1)",
    "not a url",
  ]) {
    test(`invalid ${JSON.stringify(bad)} exits non-zero and is not written`, () => {
      const r = build(bad);
      assert.notEqual(r.status, 0, `build accepted ${bad}`);
      const cfg = join(WWW, "static", "runtime_config.js");
      if (existsSync(cfg)) assert.ok(!readFileSync(cfg, "utf8").includes(bad), `${bad} was written`);
    });
  }
});
