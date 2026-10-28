// Covers: MEM-035
// Requirement: on a public (non-loopback) host the page reveals the #public-banner telling
// visitors that live mode needs a passcode and to try Load demo; on localhost it stays hidden.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as app from "./app.js";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]", "", "LOCALHOST"];
const PUBLIC_HOSTS = ["memripal-abc.a.run.app", "example.com", "10.0.0.5"];

/** Fake document exposing only #public-banner (or nothing when banner is null). */
function fakeDoc(banner) {
  return { getElementById: (id) => (id === "public-banner" ? banner : null) };
}

describe("isPublicHost", () => {
  // Requirement: loopback names (any case, bracketed IPv6, empty) are not public.
  test("loopback hosts are not public", () => {
    assert.equal(typeof app.isPublicHost, "function", "app.js must export isPublicHost");
    for (const host of LOCAL_HOSTS) assert.equal(app.isPublicHost(host), false, `host ${JSON.stringify(host)}`);
  });

  // Requirement: any other hostname, such as the Cloud Run URL, is public.
  test("non-loopback hosts are public", () => {
    assert.equal(typeof app.isPublicHost, "function", "app.js must export isPublicHost");
    for (const host of PUBLIC_HOSTS) assert.equal(app.isPublicHost(host), true, `host ${host}`);
  });
});

describe("showPublicBanner", () => {
  // Requirement: the banner is unhidden on a public host.
  test("unhides #public-banner on a public host", () => {
    assert.equal(typeof app.showPublicBanner, "function", "app.js must export showPublicBanner");
    const banner = { hidden: true };
    app.showPublicBanner(fakeDoc(banner), "memripal-abc.a.run.app");
    assert.equal(banner.hidden, false);
  });

  // Requirement: the banner stays hidden on every loopback host.
  test("keeps #public-banner hidden on loopback hosts", () => {
    assert.equal(typeof app.showPublicBanner, "function", "app.js must export showPublicBanner");
    for (const host of LOCAL_HOSTS) {
      const banner = { hidden: true };
      app.showPublicBanner(fakeDoc(banner), host);
      assert.equal(banner.hidden, true, `host ${JSON.stringify(host)}`);
    }
  });

  // Requirement: a page without the banner element does not crash.
  test("does nothing when #public-banner is missing", () => {
    assert.equal(typeof app.showPublicBanner, "function", "app.js must export showPublicBanner");
    assert.doesNotThrow(() => app.showPublicBanner(fakeDoc(null), "memripal-abc.a.run.app"));
  });
});
