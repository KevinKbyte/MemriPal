// Covers: MEM-108
// Requirement: when a Spark response carries X-Memripal-Chat-Fallback with a known provider
// (baseten, fireworks, local), the page shows a dismissible top toast "Open-weights Spark on
// <label> is unavailable; continuing on Meta's hosted model"; unknown header values are never
// rendered; once dismissed it stays hidden for the page session; fetch results pass through.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as cf from "./chat_fallback.js";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const msg = (label) => `Open-weights Spark on ${label} is unavailable; continuing on Meta's hosted model`;

function fakeDoc() {
  const els = {
    "chat-fallback": { hidden: true },
    "chat-fallback-text": { textContent: "" },
    "chat-fallback-dismiss": { listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } },
  };
  return { els, getElementById: (id) => els[id] ?? null };
}

function response(value) {
  return { ok: true, headers: { get: (n) => (n.toLowerCase() === "x-memripal-chat-fallback" ? value : null) } };
}

describe("chat fallback notice", () => {
  test("labels and message for allowlisted providers only", () => {
    assert.deepEqual({ ...cf.CHAT_FALLBACK_LABELS }, { baseten: "Baseten", fireworks: "Fireworks", local: "the local server" });
    assert.equal(cf.chatFallbackMessage("baseten"), msg("Baseten"));
    assert.equal(cf.chatFallbackMessage("local"), msg("the local server"));
    for (const p of ["<img src=x>", "meta", "", null, undefined, "toString"]) assert.equal(cf.chatFallbackMessage(p), null);
  });

  test("withChatFallbackNotice passes the Response through and reports allowlisted values", async () => {
    const seen = [];
    for (const value of ["fireworks", "evil<script>", null]) {
      const res = response(value);
      const wrapped = cf.withChatFallbackNotice(async () => res, (p) => seen.push(p));
      assert.equal(await wrapped("/station", { method: "POST" }), res);
    }
    assert.deepEqual(seen, ["fireworks"]);
  });

  test("withChatFallbackNotice tolerates a missing headers object and propagates rejections", async () => {
    const seen = [];
    const bare = { ok: true };
    assert.equal(await cf.withChatFallbackNotice(async () => bare, (p) => seen.push(p))("/x"), bare);
    const boom = new Error("net down");
    await assert.rejects(cf.withChatFallbackNotice(async () => { throw boom; }, (p) => seen.push(p))("/x"), boom);
    assert.deepEqual(seen, []);
  });

  test("showChatFallback fills the text and unhides; unknown or missing element is a no-op", () => {
    const doc = fakeDoc();
    cf.showChatFallback(doc, "evil");
    assert.equal(doc.els["chat-fallback"].hidden, true);
    cf.showChatFallback(doc, "baseten");
    assert.equal(doc.els["chat-fallback-text"].textContent, msg("Baseten"));
    assert.equal(doc.els["chat-fallback"].hidden, false);
    assert.doesNotThrow(() => cf.showChatFallback({ getElementById: () => null }, "baseten"));
  });

  test("dismiss hides the toast and it stays hidden for the page session", () => {
    const doc = fakeDoc();
    cf.wireChatFallback(doc);
    cf.showChatFallback(doc, "fireworks");
    assert.equal(doc.els["chat-fallback"].hidden, false);
    doc.els["chat-fallback-dismiss"].listeners.click();
    assert.equal(doc.els["chat-fallback"].hidden, true);
    cf.showChatFallback(doc, "fireworks");
    assert.equal(doc.els["chat-fallback"].hidden, true);
  });

  test("index.html has the toast markup outside details#drawer, no inline style", () => {
    const html = read("index.html");
    const at = html.search(/<div id="chat-fallback"[^>]*>/);
    assert.ok(at >= 0, "toast div missing");
    const tag = html.slice(at, html.indexOf(">", at) + 1);
    for (const part of ['class="notice toast"', 'role="status"', "hidden"]) assert.ok(tag.includes(part), `toast tag lacks ${part}`);
    assert.ok(!tag.includes("style="));
    const start = html.indexOf('<details id="drawer"');
    let depth = 0, i = start, end = -1;
    const re = /<\/?details\b/g;
    re.lastIndex = start;
    for (let m; (m = re.exec(html)); ) { depth += m[0] === "<details" ? 1 : -1; if (depth === 0) { end = m.index; break; } i = m.index; }
    assert.ok(start >= 0 && end > start, "drawer not found");
    assert.ok(at < start || at > end, "toast must be outside details#drawer");
    const inner = html.slice(at, html.indexOf("</div>", at));
    assert.match(inner, /<span id="chat-fallback-text"><\/span>/);
    assert.match(inner, /<button id="chat-fallback-dismiss" class="btn" type="button">Dismiss<\/button>/);
  });

  test("style.css has a fixed top-centered .toast above everything, still hideable", () => {
    const css = read("style.css");
    const rule = css.match(/(^|\n)\.toast\s*\{([^}]*)\}/);
    assert.ok(rule, ".toast rule missing");
    const body = rule[2].replace(/\s+/g, " ");
    assert.match(body, /position: fixed/);
    assert.match(body, /top: 16px/);
    assert.ok(/left: 16px/.test(body) && /right: 16px/.test(body) || /left: 50%/.test(body) && /translateX\(-50%\)/.test(body), "not top-centered with 16px gutters");
    const z = Number((body.match(/z-index: (\d+)/) || [])[1]);
    const others = [...css.replace(rule[0], "").matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(z > Math.max(0, ...others), "toast z-index must exceed every other z-index");
    assert.match(css, /\[hidden\]\s*\{\s*display: none !important;/);
  });

  test("app.js imports and wires the notice", () => {
    const js = read("app.js");
    assert.match(js, /import\s*\{[^}]*withChatFallbackNotice[^}]*\}\s*from\s*"\.\/chat_fallback\.js"/);
    assert.match(js, /import\s*\{[^}]*wireChatFallback[^}]*\}\s*from\s*"\.\/chat_fallback\.js"/);
    assert.ok(js.includes("fetch: withChatFallbackNotice(withApiBase(fetch.bind(globalThis)), (p) => showChatFallback(document, p))"));
    assert.match(js, /wireChatFallback\(document\)/);
  });
});
