// Shared index.html id lists for the markup tests (MEM-044, MEM-048). Not a test file itself (no
// describe/test); index_markup.test.mjs and index_markup_routes.test.mjs import it.

// MEM-048 (plan B3, Part A S1/S2/S4): the 14 ids the final markup adds to the 44 live ids.
export const MEM048_IDS = [
  "routes-home", "routes-list", "routes-new", "routes-settings",
  "capture-session", "capture-safety", "capture-safety-ok", "capture-strip", "capture-locate",
  "capture-finish", "capture-count",
  "finish-name", "finish-kind", "finish-save",
];

// MEM-048: the new ids Part A lets start hidden. #capture-session is the S2 screen and screens show one at a
// time toggled via [hidden] with S1 Routes home first (plan A5, Part A SCREENS); #capture-safety is shown on
// the first walk only (Part A S2). Every other new id starts visible.
export const MEM048_MAY_START_HIDDEN = ["capture-session", "capture-safety"];
