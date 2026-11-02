// Kendall basemap preview (MEM-076, MEM-077): loads the self-hosted PMTiles extract whole, validates it,
// serves it to MapLibre as "pmtiles://kendall", and draws the Kendall/MIT -> Meta (100 Binney St)
// walking route with its numbered stations in an SVG overlay over the canvas.
// Sets <html data-map-state="idle|fallback|error"> so a shooter knows when the page has settled.
(function () {
  var PMTILES_URL = "/static/map/kendall.pmtiles";
  var WORKER_URL = "/static/vendor/maplibre/maplibre-gl-csp-worker.js";
  var MAX_BYTES = 3 * 1024 * 1024;
  // Extract bounds (west, south, east, north), same as scripts/build_map_extract.py.
  var BBOX = [-71.1083, 42.3494, -71.0719, 42.3764];
  var SVG_NS = "http://www.w3.org/2000/svg";
  // Walking route Kendall/MIT station -> Meta, 100 Binney St (~600 m), vertices on real street centerlines.
  var ROUTE = [
    [-71.08560, 42.36238], [-71.08506, 42.36233], [-71.08479, 42.36237], [-71.08469, 42.36240],
    [-71.08441, 42.36265], [-71.08420, 42.36282], [-71.08384, 42.36329], [-71.08347, 42.36385],
    [-71.08277, 42.36509], [-71.08245, 42.36564], [-71.08237, 42.36573], [-71.08120, 42.36558],
    [-71.08090, 42.36554]
  ];
  // Memory-palace stations: each title alone must tell a walker where they are and which way to go next.
  var STATIONS = [
    { lngLat: [-71.08560, 42.36238], emoji: 0x1F687,
      title: "Kendall/MIT station: exit onto Main St and walk east toward the One Broadway tower" },
    { lngLat: [-71.08441, 42.36265], emoji: 0x1F3E2,
      title: "One Broadway tower (Brothers Marketplace at its base): bear left onto Third St" },
    { lngLat: [-71.08347, 42.36385], emoji: 0x1F3D9,
      title: "Watermark Kendall towers at Kendall St / Potter St: keep straight on Third St" },
    { lngLat: [-71.08277, 42.36509], emoji: 0x1F3D8,
      title: "Third Square Apartments at Munroe St / Linskey Way: keep straight on Third St" },
    { lngLat: [-71.08237, 42.36573], emoji: 0x1F9F1,
      title: "Kendall Building (old brick boiler works) at Binney St: turn right onto Binney St" },
    { lngLat: [-71.08090, 42.36554], emoji: 0x1F4BC,
      title: "Meta office, 100 Binney St: on your right, Toomey Park across the street" }
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

  function el(tag, cls, parent) {
    var node = document.createElementNS(SVG_NS, tag);
    if (cls) node.setAttribute("class", cls);
    if (parent) parent.appendChild(node);
    return node;
  }

  // Same structure and classes as docs/design/route/map-shell.js drawRoute/landmark, so map-shell.css styles
  // it; --k is unset here, so its calc(var(--k, 1) * Npx) sizes resolve to N screen px.
  function drawRoute(map) {
    var svg = document.getElementById("overlay");
    var route = el("g", "route tc-0");
    var halo = el("polyline", "route-halo", route);
    var line = el("polyline", "route-line", route);
    var groups = STATIONS.map(function (st, i) {
      var g = el("g", "lm", route);
      g.style.setProperty("--i", i);
      // The true spot, for scripts/screenshot_map.py's pan check (a pinned station is drawn elsewhere).
      g.setAttribute("data-lnglat", st.lngLat.join(","));
      el("title", null, g).textContent = (i + 1) + ". " + st.title;
      var mark = el("g", "lm-mark", g);
      el("circle", "lm-dot", mark);
      el("text", "lm-num", mark).textContent = String(i + 1);
      var emoji = el("text", "lm-emoji", g);
      emoji.setAttribute("aria-hidden", "true");
      // U+FE0F forces colour presentation: 1F3D9/1F3D8 default to monochrome text glyphs otherwise.
      emoji.textContent = String.fromCodePoint(st.emoji, 0xFE0F);
      return g;
    });
    svg.replaceChildren(route);
    function place() {
      var pts = ROUTE.map(function (ll) {
        var p = map.project(ll);
        return p.x.toFixed(1) + "," + p.y.toFixed(1);
      }).join(" ");
      halo.setAttribute("points", pts);
      line.setAttribute("points", pts);
      STATIONS.forEach(function (st, i) {
        var p = map.project(st.lngLat);
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
    var lngs = ROUTE.map(function (p) { return p[0]; });
    var lats = ROUTE.map(function (p) { return p[1]; });
    var map = new maplibregl.Map({
      container: "map",
      // Open framed on the walk, not the whole extract.
      bounds: [[Math.min.apply(null, lngs), Math.min.apply(null, lats)],
        [Math.max.apply(null, lngs), Math.max.apply(null, lats)]],
      fitBoundsOptions: { padding: 60, maxZoom: 16 },
      maxBounds: [[BBOX[0], BBOX[1]], [BBOX[2], BBOX[3]]],
      minZoom: 12,
      // Tiles stop at z14; MapLibre overzooms them for display up to 16.
      maxZoom: 16,
      attributionControl: { compact: false },
      fadeDuration: 0
    });
    window.__map = map;
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
    // Flip swaps the style in place (no reload); the SVG route sits outside the style and keep their
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
    map.once("load", function () { drawRoute(map); });
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
