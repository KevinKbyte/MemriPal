// Covers: MEM-137
// Requirement: the seeded Kendall demo route carries no facing-dependent direction words. A cue like "bear left",
// "turn right", "on your right" or "walk east" is relative to the way the walker faces, so it is wrong whenever
// they face another way, and the route map already draws the route (Kev, 2026-11-04; follows MEM-135). The route
// name, every station name and every station cue text (profile visual/spatial/conceptual and tap values) must
// not match /\b(left|right|bear|turn(s|ed)?|east|west|north|south)\b/i.
// Contract (RED; GREEN rewrites the text in static/demo_route.js, and the matching docs/design/map/preview.js
// STATIONS titles, which static/demo_route.test.mjs pins the station names to).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { DEMO_ROUTE } from "./demo_route.js";

const DIRECTION = /\b(left|right|bear|turn(s|ed)?|east|west|north|south)\b/i;

/** Every user-visible text string of a demo station, labelled for the failure message. */
function stationTexts(s) {
  const out = [[`station ${s.n} name`, s.name]];
  for (const [k, v] of Object.entries(s.profile ?? {})) out.push([`station ${s.n} profile.${k}`, v]);
  for (const [k, v] of Object.entries(s.taps ?? {})) out.push([`station ${s.n} taps.${k}`, v]);
  return out;
}

describe("demo route text has no facing-dependent directions (MEM-137)", () => {
  test("precondition: 6 stations, each with a name and profile text", () => {
    assert.equal(DEMO_ROUTE.stations.length, 6);
    for (const s of DEMO_ROUTE.stations) {
      assert.ok(typeof s.name === "string" && s.name.trim() !== "", `station ${s.n} has a name`);
      assert.ok(s.profile && Object.keys(s.profile).length > 0, `station ${s.n} has profile text`);
    }
  });

  test("the pattern catches the direction words it must ban and spares look-alikes", () => {
    for (const bad of ["bear left onto Third St", "Turn right", "turns", "turned", "walk east", "on your right", "North"]) {
      assert.match(bad, DIRECTION, bad);
    }
    for (const ok of ["Brothers Marketplace", "keep straight on Third St", "Eastern", "bright", "returns", "Kendall walk"]) {
      assert.doesNotMatch(ok, DIRECTION, ok);
    }
  });

  test("the route name has no direction word", () => {
    assert.doesNotMatch(DEMO_ROUTE.name, DIRECTION);
  });

  test("no station name or cue text has a direction word", () => {
    const hits = DEMO_ROUTE.stations
      .flatMap(stationTexts)
      .filter(([, text]) => typeof text === "string" && DIRECTION.test(text))
      .map(([where, text]) => `${where}: ${JSON.stringify(text)}`);
    assert.deepEqual(hits, [], `facing-dependent directions found:\n${hits.join("\n")}`);
  });
});

// Covers: MEM-137
// Requirement: each demo station's conceptual cue is anchored to that station and makes no unverified claim.
// Station 1 is Kendall/MIT, not Alewife: the Alewife words on its sign name the Red Line's destination, not this
// place, so its conceptual cue must not mention Alewife and must name the KENDALL sign. Station 6's "Meta's logo is
// an infinity loop" claim was never web-checked, so its conceptual cue must not mention a logo and must describe
// the sculpture itself (its mesh). (Kev, 2026-11-04.)
describe("demo route conceptual cues are anchored to their stations (MEM-137)", () => {
  const station = (n) => DEMO_ROUTE.stations.find((s) => s.n === n);

  test("station 1 conceptual cue names the KENDALL sign, not Alewife", () => {
    const text = station(1)?.profile?.conceptual;
    assert.equal(typeof text, "string", "station 1 has a conceptual cue");
    assert.doesNotMatch(text, /alewife/i, `station 1 conceptual mentions Alewife: ${JSON.stringify(text)}`);
    assert.ok(text.includes("KENDALL"), `station 1 conceptual names the KENDALL sign: ${JSON.stringify(text)}`);
  });

  test("station 6 conceptual cue describes the mesh, with no unverified logo claim", () => {
    const text = station(6)?.profile?.conceptual;
    assert.equal(typeof text, "string", "station 6 has a conceptual cue");
    assert.doesNotMatch(text, /logo/i, `station 6 conceptual makes a logo claim: ${JSON.stringify(text)}`);
    assert.match(text, /mesh/i, `station 6 conceptual describes the mesh: ${JSON.stringify(text)}`);
  });
});
