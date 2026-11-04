// Shared index.html id lists for the markup tests (MEM-044, MEM-048, MEM-050, MEM-051, MEM-081). Not a test file itself (no
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

// MEM-050 (plan B5, Part A S3 Station card): the 15 ids the station card adds. The S3 baseline ids
// (#station-baseline*) land with B8, not here.
export const MEM050_IDS = [
  "station-card", "station-name", "station-name-error", "station-profile", "station-taps",
  "tap-sound", "tap-smell", "tap-feel", "tap-mood", "tap-turn",
  "station-save", "station-drop", "station-drop-confirm", "station-drop-cancel", "station-undo",
];

// MEM-050: #station-card is the S3 screen (screens toggle via [hidden], S1 first); the name error shows
// only on a bad name; the drop confirm/cancel pair only once armed; Undo only after a drop (Part A S3).
export const MEM050_MAY_START_HIDDEN = [
  "station-card", "station-name-error", "station-drop-confirm", "station-drop-cancel", "station-undo",
];

// MEM-051 (plan B6, Part A S5/S8): S5 Route view ids B6 adds (B7 adds the list ids, B8 the baseline toggle)
// and the S8 #recall-map / #recall-mode inside the existing #recall.
export const MEM051_IDS = [
  "route-view", "route-map", "route-view-stations", "route-view-practice",
  "route-view-delete", "route-view-delete-confirm", "route-view-delete-cancel", "route-view-undo",
  "recall-map", "recall-mode",
];

// MEM-051: #route-view is a screen (one shown at a time, S1 first); delete confirm/cancel stay hidden until
// armed and Undo until a delete (Part A S5). #recall-map and #recall-mode sit in the already-hidden #recall.
export const MEM051_MAY_START_HIDDEN = ["route-view", "route-view-delete-confirm", "route-view-delete-cancel",
  "route-view-undo"];

// MEM-081 (ADR 0041): the route review's Edit toggle, polite live region and Undo snackbar (with its text).
// #route-undo (a 748a5e1 id) moves inside #route-toast.
export const MEM081_IDS = ["route-edit", "route-live", "route-toast", "route-toast-text"];

// MEM-081: the snackbar shows only after a remove (it mirrors canUndo); #route-undo inside it no longer
// carries hidden itself.
export const MEM081_MAY_START_HIDDEN = ["route-toast"];

// MEM-072 (map-first shell, ADR 0038): the ids the shell adds. Every older id only moves (each still exactly once):
// the four tab panels, the map chip, the route drawer and the Landmarks tab list.
export const MEM072_IDS = [
  "tab-routes", "tab-landmarks", "tab-recall", "tab-settings", "map-chip", "drawer", "landmarks-list",
];

// MEM-072: Routes (the map) is the home tab, so only the other three tab panels start hidden.
export const MEM072_MAY_START_HIDDEN = ["tab-landmarks", "tab-recall", "tab-settings"];

// MEM-088 (Map a new route): the route builder form in the drawer (#route-new with start/end/Find/Cancel, an error
// line, the result block with distance, station list, name and Save) and the map's empty state.
export const MEM088_IDS = [
  "route-new", "route-from", "route-to", "route-find", "route-new-cancel", "route-new-error", "route-new-result",
  "route-distance", "route-new-stations", "route-new-name", "route-new-save", "map-empty",
];

// MEM-088: the builder opens only from "Map a new route", the error shows only on a miss and the result only after a
// found walk. #map-empty starts visible (a fresh origin has no route) and app.js hides it once a route is drawn.
export const MEM088_MAY_START_HIDDEN = ["route-new", "route-new-error", "route-new-result"];
