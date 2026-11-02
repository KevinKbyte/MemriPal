// Kendall basemap preview (MEM-076, MEM-077): loads the self-hosted PMTiles extract whole, validates it,
// serves it to MapLibre as "pmtiles://kendall", and draws mock app markers over the canvas.
// Sets <html data-map-state="idle|fallback|error"> so a shooter knows when the page has settled.
(function () {
  var PMTILES_URL = "/static/map/kendall.pmtiles";
  var WORKER_URL = "/static/vendor/maplibre/maplibre-gl-csp-worker.js";
  var MAX_BYTES = 3 * 1024 * 1024;
  // Extract bounds (west, south, east, north), same as scripts/build_map_extract.py.
  var BBOX = [-71.1083, 42.3494, -71.0719, 42.3764];
  var KENDALL = [-71.0865, 42.3625];
  var SVG_NS = "http://www.w3.org/2000/svg";
  var MARKERS = [
    { name: "Kendall/MIT station", lngLat: [-71.08617, 42.36249], tc: 0 },
    { name: "MIT Great Dome", lngLat: [-71.09218, 42.35965], tc: 1 },
    { name: "O'Connell Branch Library", lngLat: [-71.08474, 42.37046], tc: 2 }
  ];

  var root = document.documentElement;
  var q = new URLSearchParams(location.search);
  var forced = q.get("theme");
  if (forced === "dark" || forced === "light") root.setAttribute("data-theme", forced);
  var dark = forced ? forced === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;


  function setState(s) { root.setAttribute("data-map-state", s); }

  function fallback(reason) {
    console.warn("map preview: " + reason);
    document.getElementById("sketch-fallback").hidden = false;
    setState("fallback");
  }

  // Whole-file fetch, then header checks: magic "PMTiles", spec version 3, size cap.
  function loadArchive() {
    return fetch(PMTILES_URL).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      var len = Number(res.headers.get("content-length"));
      if (len > MAX_BYTES) throw new Error("too large: " + len);
      return res.arrayBuffer();
    }).then(function (buf) {
      if (buf.byteLength > MAX_BYTES) throw new Error("too large: " + buf.byteLength);
      var head = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
      if (String.fromCharCode.apply(null, head.subarray(0, 7)) !== "PMTiles") throw new Error("bad magic");
      if (head[7] !== 3) throw new Error("bad version: " + head[7]);
      var file = new File([new Blob([buf])], "kendall");
      return new pmtiles.PMTiles(new pmtiles.FileSource(file));
    });
  }

  function drawMarkers(map) {
    var svg = document.getElementById("overlay");
    var groups = MARKERS.map(function (m, i) {
      var g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", "lm tc-" + m.tc);
      var mark = document.createElementNS(SVG_NS, "g");
      mark.setAttribute("class", "lm-mark");
      var dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("class", "lm-dot");
      var num = document.createElementNS(SVG_NS, "text");
      num.setAttribute("class", "lm-num");
      num.textContent = String(i + 1);
      var title = document.createElementNS(SVG_NS, "title");
      title.textContent = m.name;
      mark.append(dot, num);
      g.append(title, mark);
      return g;
    });
    svg.replaceChildren.apply(svg, groups);
    function place() {
      MARKERS.forEach(function (m, i) {
        var p = map.project(m.lngLat);
        groups[i].setAttribute("transform", "translate(" + p.x.toFixed(1) + " " + p.y.toFixed(1) + ")");
      });
    }
    map.on("move", place);
    map.on("resize", place);
    place();
  }

  function start(archive) {
    var protocol = new pmtiles.Protocol();
    protocol.add(archive);
    maplibregl.addProtocol("pmtiles", protocol.tile);
    maplibregl.setWorkerUrl(WORKER_URL);
    var map = new maplibregl.Map({
      container: "map",
      center: KENDALL,
      bounds: [[BBOX[0], BBOX[1]], [BBOX[2], BBOX[3]]],
      maxBounds: [[BBOX[0], BBOX[1]], [BBOX[2], BBOX[3]]],
      minZoom: 12,
      // Tiles stop at z14; MapLibre overzooms them for display up to 16.
      maxZoom: 16,
      attributionControl: { compact: false },
      fadeDuration: 0
    });
    // The committed styles use root-relative sprite/glyph paths so they work on any origin; MapLibre
    // rejects a relative sprite URL, so prefix this page's origin. String concat, not new URL(): URL
    // would percent-encode the {fontstack}/{range} placeholders.
    function applyTheme() {
      root.setAttribute("data-theme", dark ? "dark" : "light");
      map.setStyle("/static/map/style-" + (dark ? "dark" : "light") + ".json", {
        transformStyle: function (_prev, next) {
          var abs = function (u) { return typeof u === "string" && u.charAt(0) === "/" ? location.origin + u : u; };
          return Object.assign({}, next, { sprite: abs(next.sprite), glyphs: abs(next.glyphs) });
        }
      });
    }
    applyTheme();
    // Flip swaps the style in place (no reload); the SVG markers sit outside the style and keep their
    // positions. data-map-state drops back to "loading" until the new style settles, for the shooter.
    document.getElementById("theme-flip").addEventListener("click", function () {
      dark = !dark;
      setState("loading");
      map.once("idle", function () {
        if (root.getAttribute("data-map-state") !== "error") setState("idle");
      });
      applyTheme();
    });
    map.getCanvas().setAttribute("aria-hidden", "true");
    map.on("error", function (e) {
      console.error("map error: " + (e && e.error ? e.error.message : "unknown"));
      setState("error");
    });
    map.once("load", function () { drawMarkers(map); });
    map.once("idle", function () {
      if (root.getAttribute("data-map-state") !== "error") setState("idle");
    });
  }

  if (typeof maplibregl === "undefined" || typeof pmtiles === "undefined") {
    fallback("map libraries missing");
    return;
  }
  // A failed check, or no WebGL (the Map constructor throws), both land on the sketch fallback.
  loadArchive().then(start).catch(function (err) { fallback(err.message); });
})();
