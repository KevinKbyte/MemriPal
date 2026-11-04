// Covers: MEM-121
// Requirement: when the server's Meta spend cap is reached it says so in header X-Memripal-Spend-Cap
// ("saved", "backup" or "capped"); the page shows a dismissible top toast whose text names the cap and
// what the app is doing instead ("showing saved results", the backup chat provider, or live steps paused).
// Unknown header values are never rendered; fetch results pass through unchanged; the page wires the
// notice onto the same fetch wrapper that sends the passcode header on the model routes (flow.js).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as byok from "./byok.js";
import { fakePage, textOf } from "./fake_dom_test.mjs";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

function response(value, status = 200) {
  return { ok: status < 400, status, headers: { get: (n) => (n.toLowerCase() === "x-memripal-spend-cap" ? value : null) } };
}

function page() {
  const p = fakePage([]);
  p.doc.body = p.doc.createElement("body");
  return p;
}

describe("spend cap notice", () => {
  test("header name and the three messages each name the cap", () => {
    assert.equal(byok.SPEND_CAP_HEADER, "X-Memripal-Spend-Cap");
    for (const state of ["saved", "backup", "capped"]) {
      const msg = byok.spendCapMessage(state);
      assert.match(msg, /free demo credit is used up/i);
      assert.match(msg, /spend cap/i);
    }
    assert.match(byok.spendCapMessage("saved"), /showing saved results/);
    assert.match(byok.spendCapMessage("backup"), /backup/);
    assert.match(byok.spendCapMessage("capped"), /paused/);
    for (const v of ["<img src=x>", "", null, undefined, "toString", "SAVED"]) assert.equal(byok.spendCapMessage(v), null);
  });

  test("withSpendCapNotice passes the Response through and reports allowlisted values only", async () => {
    const seen = [];
    for (const [value, status] of [["saved", 200], ["capped", 503], ["evil<script>", 200], [null, 200]]) {
      const res = response(value, status);
      assert.equal(await byok.withSpendCapNotice(async () => res, (s) => seen.push(s))("/loci", { method: "POST" }), res);
    }
    assert.deepEqual(seen, ["saved", "capped"]);
  });

  test("withSpendCapNotice tolerates a missing headers object and propagates rejections", async () => {
    const seen = [];
    const bare = { ok: true };
    assert.equal(await byok.withSpendCapNotice(async () => bare, (s) => seen.push(s))("/x"), bare);
    const boom = new Error("net down");
    await assert.rejects(byok.withSpendCapNotice(async () => { throw boom; }, (s) => seen.push(s))("/x"), boom);
    assert.deepEqual(seen, []);
  });

  test("showSpendCap mounts one status toast with the message; Dismiss hides it for the page session", () => {
    const { doc, fire } = page();
    byok.showSpendCap(doc, "nope");
    assert.equal(doc.body.children.length, 0);

    byok.showSpendCap(doc, "saved");
    byok.showSpendCap(doc, "capped");
    assert.equal(doc.body.children.length, 1);
    const toast = doc.body.children[0];
    assert.equal(toast.getAttribute("role"), "status");
    assert.equal(toast.hidden, false);
    assert.ok(toast.classList.contains("toast"));
    assert.match(textOf(toast), /paused/);
    // Never blocks the controls under it (screenshot run: it intercepted a click); Dismiss stays clickable.
    assert.equal(toast.style.pointerEvents, "none");

    const dismiss = toast.children.find((c) => c.tagName === "BUTTON");
    fire(dismiss, "click");
    assert.equal(toast.hidden, true);
    byok.showSpendCap(doc, "saved");
    assert.equal(toast.hidden, true);
  });

  test("flow.js wraps its passcode fetch with the notice", () => {
    const src = read("flow.js");
    assert.match(src, /from "\.\/byok\.js"/);
    assert.match(src, /withSpendCapNotice\(\s*withPasscode\(deps\.fetch, doc\)/);
  });
});

// Covers: MEM-122
// Requirement: bring your own key, shown only once the spend cap toast says "capped". The key lives in a JS
// variable only (never localStorage/sessionStorage/IndexedDB/cookies), rides only in header
// X-Memripal-Meta-Key on the 5 model routes, and is forgotten on reload, on "Forget key", at its $5 limit
// (X-Memripal-Byok: limit) and when Meta refuses it (X-Memripal-Byok: rejected:<model>).
const KEY = "fake-user-" + "u".repeat(20);
const ROUTES = ["/loci", "/split", "/associate", "/scenes", "/recall/audio"];

function outcome(value, status = 200) {
  return { ok: status < 400, status, headers: { get: (n) => (n.toLowerCase() === "x-memripal-byok" ? value : null) } };
}

function recorder(res = outcome(null)) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, headers: new Headers(init.headers) });
    return res;
  };
  return { fn, calls };
}

const findIn = (root, pred) => {
  if (!root || typeof root === "string") return null;
  if (pred(root)) return root;
  for (const c of root.children) {
    const hit = findIn(c, pred);
    if (hit) return hit;
  }
  return null;
};
const button = (root, text) => findIn(root, (n) => n.tagName === "BUTTON" && textOf(n) === text);
const promptEl = (doc) => findIn(doc.body, (n) => n.id === "byok");
const chipEl = (doc) => findIn(doc.body, (n) => n.id === "byok-chip");

function submitKey(p, key) {
  const form = promptEl(p.doc);
  findIn(form, (n) => n.tagName === "INPUT").value = key;
  return p.fire(form, "submit");
}

describe("bring your own key", () => {
  test("copy is Kev's, short, and names the tab-only, never-saved, $5 promise", () => {
    assert.equal(
      byok.BYOK_COPY.prompt,
      "Free demo credit is used up. To keep going, paste your own Meta API key. It stays in this tab only, is never saved, and stops at $5.",
    );
    assert.equal(byok.BYOK_COPY.chip, "Using your key ($5 limit)");
    assert.equal(byok.BYOK_COPY.forget, "Forget key");
    assert.equal(byok.BYOK_COPY.limit, "Your $5 limit is reached. Key forgotten.");
    assert.equal(byok.rejectedMessage("muse-spark-1.3"), "Your key can't use muse-spark-1.3");
    assert.deepEqual([...byok.KEY_ROUTES].sort(), [...ROUTES].sort());
    assert.equal(byok.KEY_HEADER, "X-Memripal-Meta-Key");
  });

  test("metaKeyOk mirrors the server's 400 rules", () => {
    for (const bad of ["", " ", "a b", " k", "k\t", "x".repeat(513), "kéy", "k\u0000y", null, 42]) {
      assert.equal(byok.metaKeyOk(bad), false, JSON.stringify(bad));
    }
    for (const good of ["k", "x".repeat(512), KEY]) assert.equal(byok.metaKeyOk(good), true);
  });

  test("the prompt appears only for the capped state, never for saved/backup", () => {
    for (const state of ["saved", "backup"]) {
      const { doc } = page();
      byok.showSpendCap(doc, state);
      assert.equal(promptEl(doc), null);
    }
    const { doc } = page();
    byok.showSpendCap(doc, "capped");
    const form = promptEl(doc);
    assert.ok(form);
    assert.equal(form.hidden, false);
    assert.match(textOf(form), /Free demo credit is used up\. To keep going, paste your own Meta API key\./);
    const input = findIn(form, (n) => n.tagName === "INPUT");
    assert.equal(input.type, "password");
    assert.equal(input.getAttribute("autocomplete"), "off");
    assert.ok(button(form, "Continue"));
    const label = findIn(form, (n) => n.tagName === "LABEL");
    assert.equal(label.getAttribute("for"), input.id);
  });

  test("Continue holds the key in memory, clears the field, shows the chip; nothing touches storage", () => {
    const touched = [];
    const trap = new Proxy({}, { get: (_t, k) => { touched.push(k); return () => null; } });
    const names = ["localStorage", "sessionStorage", "indexedDB"];
    const saved = names.map((n) => Object.getOwnPropertyDescriptor(globalThis, n));
    for (const n of names) Object.defineProperty(globalThis, n, { value: trap, configurable: true, writable: true });
    try {
      const p = page();
      byok.showSpendCap(p.doc, "capped");
      const ev = submitKey(p, KEY);
      assert.equal(ev.defaultPrevented, true);
      assert.equal(byok.heldKey(p.doc), KEY);
      assert.equal(findIn(promptEl(p.doc), (n) => n.tagName === "INPUT").value, "");
      assert.equal(promptEl(p.doc).hidden, true);
      const chip = chipEl(p.doc);
      assert.equal(chip.hidden, false);
      assert.match(textOf(chip), /Using your key \(\$5 limit\)/);
      assert.ok(button(chip, "Forget key"));
      assert.ok(!textOf(p.doc.body).includes(KEY), "the key is never rendered");
    } finally {
      names.forEach((n, i) => (saved[i] ? Object.defineProperty(globalThis, n, saved[i]) : delete globalThis[n]));
    }
    assert.deepEqual(touched, []);
    assert.doesNotMatch(read("byok.js"), /localStorage|sessionStorage|indexedDB|document\.cookie/);
  });

  test("a malformed key is refused inline and never held", () => {
    const p = page();
    byok.showSpendCap(p.doc, "capped");
    submitKey(p, "has space");
    assert.equal(byok.heldKey(p.doc), null);
    assert.equal(promptEl(p.doc).hidden, false);
    assert.match(textOf(promptEl(p.doc)), /doesn't look like a Meta API key/);
  });

  test("withMetaKey sends the header only on the 5 model routes and only while a key is held", async () => {
    const p = page();
    const net = recorder();
    const fetchKeyed = byok.withMetaKey(net.fn, p.doc);
    await fetchKeyed("/split", { method: "POST" });
    assert.equal(net.calls[0].headers.get("X-Memripal-Meta-Key"), null);

    byok.showSpendCap(p.doc, "capped");
    submitKey(p, KEY);
    const others = ["/place", "/station", "/demo/photo.jpg", "/healthz"];
    for (const url of [...ROUTES, ...others]) {
      await fetchKeyed(url, { method: "POST", headers: { "Content-Type": "application/json" } });
    }
    const sent = net.calls.slice(1).map((c) => [c.url, c.headers.get("X-Memripal-Meta-Key")]);
    assert.deepEqual(sent, [...ROUTES.map((u) => [u, KEY]), ...others.map((u) => [u, null])]);
    assert.equal(net.calls[1].headers.get("Content-Type"), "application/json");
  });

  test("Forget key drops the key at once", async () => {
    const p = page();
    const net = recorder();
    byok.showSpendCap(p.doc, "capped");
    submitKey(p, KEY);
    p.fire(button(chipEl(p.doc), "Forget key"), "click");
    assert.equal(byok.heldKey(p.doc), null);
    assert.equal(chipEl(p.doc).hidden, true);
    await byok.withMetaKey(net.fn, p.doc)("/loci", {});
    assert.equal(net.calls[0].headers.get("X-Memripal-Meta-Key"), null);
  });

  test("at the key's limit the key is forgotten and the chip says so", async () => {
    const p = page();
    byok.showSpendCap(p.doc, "capped");
    submitKey(p, KEY);
    const res = outcome("limit", 503);
    assert.equal(await byok.withMetaKey(async () => res, p.doc)("/split", {}), res);
    assert.equal(byok.heldKey(p.doc), null);
    assert.equal(textOf(chipEl(p.doc)), "Your $5 limit is reached. Key forgotten.");
    assert.equal(button(chipEl(p.doc), "Forget key"), null);
  });

  test("a key Meta refuses is forgotten and the prompt names the model", async () => {
    const p = page();
    byok.showSpendCap(p.doc, "capped");
    submitKey(p, KEY);
    await byok.withMetaKey(async () => outcome("rejected:sam-3.1", 502), p.doc)("/loci", {});
    assert.equal(byok.heldKey(p.doc), null);
    assert.equal(promptEl(p.doc).hidden, false);
    assert.match(textOf(promptEl(p.doc)), /Your key can't use sam-3\.1/);
    assert.equal(chipEl(p.doc).hidden, true);
  });

  test("unknown outcome values are never rendered and keep the key", async () => {
    const p = page();
    byok.showSpendCap(p.doc, "capped");
    submitKey(p, KEY);
    for (const v of ["rejected:<img src=x>", "rejected:", "LIMIT", "nope"]) {
      await byok.withMetaKey(async () => outcome(v), p.doc)("/split", {});
    }
    assert.equal(byok.heldKey(p.doc), KEY);
    assert.ok(!textOf(p.doc.body).includes("<img"));
  });

  test("Not now hides the prompt for this page session", () => {
    const p = page();
    byok.showSpendCap(p.doc, "capped");
    p.fire(button(promptEl(p.doc), "Not now"), "click");
    assert.equal(promptEl(p.doc).hidden, true);
    byok.showSpendCap(p.doc, "capped");
    assert.equal(promptEl(p.doc).hidden, true);
  });

  test("flow.js puts withMetaKey between the passcode and the spend cap notice", () => {
    const src = read("flow.js");
    assert.match(src, /withSpendCapNotice\(\s*withMetaKey\(withPasscode\(deps\.fetch, doc\), doc\)/);
  });
});
