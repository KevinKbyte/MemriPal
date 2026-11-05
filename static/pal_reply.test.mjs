// Covers: MEM-142
// Requirement: the Pal chat gets its reply from the live POST /chat route (MEM-142): createPalReply(fetchFn)
// returns async (text, history) => string that POSTs JSON {message, history} to "/chat" and resolves the
// reply text; a non-2xx answer or a blank/missing text rejects so the chat can show an error.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const mod = await import("./pal_reply.js").catch((err) => ({ __missing: String(err) }));

function make(fetchFn) {
  assert.equal(typeof mod.createPalReply, "function", `static/pal_reply.js must export createPalReply (${mod.__missing ?? "not exported"})`);
  return mod.createPalReply(fetchFn);
}

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { fn, calls };
}

const HISTORY = [
  { role: "user", content: "hi Pal" },
  { role: "assistant", content: "Hi! Ready?" },
];

// Covers: MEM-142
// Requirement: a Pal chat message is answered by the server's live reply text.
describe("MEM-142 createPalReply", () => {
  test("POSTs JSON {message, history} to /chat and resolves body.text", async () => {
    const { fn, calls } = fakeFetch(200, { text: "Start at the front door." });
    const reply = await make(fn)("where do I start?", HISTORY);
    assert.equal(reply, "Start at the front door.");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/chat");
    assert.equal(calls[0].init.method, "POST");
    const headers = new Headers(calls[0].init.headers);
    assert.match(headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(JSON.parse(calls[0].init.body), { message: "where do I start?", history: HISTORY });
  });

  test("rejects on a non-2xx response", async () => {
    const { fn } = fakeFetch(502, { error: "chat_unavailable" });
    await assert.rejects(make(fn)("hello", []));
  });

  test("rejects on blank or missing text", async () => {
    for (const body of [{ text: "" }, { text: "   " }, {}, { text: 5 }]) {
      const { fn } = fakeFetch(200, body);
      await assert.rejects(make(fn)("hello", []), `body ${JSON.stringify(body)} must reject`);
    }
  });
});
