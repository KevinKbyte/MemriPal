// Covers: MEM-001
// Requirement: the frontend shell renders a human-readable backend health line from /healthz.
import { test } from "node:test";
import assert from "node:assert/strict";

import { formatHealth } from "./app.js";

test("formatHealth reports the active backend mode", () => {
  assert.equal(formatHealth({ status: "ok", mode: "fixture" }), "Backend ok (fixture mode)");
});

test("formatHealth reports unavailable for missing or non-ok health", () => {
  assert.equal(formatHealth(null), "Backend unavailable");
  assert.equal(formatHealth({ status: "down" }), "Backend unavailable");
});
