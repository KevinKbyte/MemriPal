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
