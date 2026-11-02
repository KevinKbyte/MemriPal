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
  // Drawn extent of a station around its point, in screen px: the dot (r 13 + stroke) and the pin arrow
  // (tip 22) at the sides and bottom; the emoji (30 above, ~13 half-height, float and shadow) at the top.
  var PIN_SIDE = 24, PIN_TOP = 48, PIN_BOTTOM = 24;
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
  // Sample observed profile per station (visual, spatial, conceptual: one short line each, as the app's
  // station profile), shown in the station detail.
  var PROFILES = [
    ["Red Line headhouse under a glass canopy", "Main St, west end of the walk", "Where the walk starts"],
    ["Tall glass tower, market at street level", "Main St at Third St", "Offices above, food below"],
    ["Two matching glass towers", "Third St at Kendall St / Potter St", "A pair of homes towers"],
    ["Brick and glass apartment block", "Third St at Munroe St / Linskey Way", "Homes on a quiet stretch"],
    ["Old brick boiler works, tall arched windows", "Third St at Binney St", "Industrial past, offices now"],
    ["Modern office front, park across the street", "100 Binney St, south side", "Where the walk ends"]
  ];
  var CHANNELS = ["kinesthetic", "auditory", "visual", "emotional", "conceptual", "olfactory", "gustatory",
    "spatial"];
  var IMAGINED = { olfactory: true, gustatory: true };
  var reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // One selection shared by the station list and the map markers.
  var buttons = [], details = [], markers = [], selected = -1, liveMap = null;

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

  // HTML element with text set via textContent only (model text never goes through innerHTML, MEM-050).
  function tag(name, cls, text, parent) {
    var node = document.createElement(name);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  // Station detail: where it is (profile), then what is stored there from the study list, if anything.
  function fillDetail(d, i) {
    tag("p", "mp-st-meta", "Station " + (i + 1) + " of " + STATIONS.length, d);
    var prof = tag("dl", "mp-st-dl", null, d);
    ["visual", "spatial", "conceptual"].forEach(function (k, j) {
      tag("dt", null, k, prof);
      tag("dd", null, PROFILES[i][j], prof);
    });
    var list = window.mpDemoList;
    if (!list) {
      tag("p", "mp-st-empty", "No study list on this route yet.", d);
      return;
    }
    var h = tag("h3", null, list.name + " ", d);
    tag("span", "mp-chip", "sample data", h);
    var entry = list.items[i + 1];
    if (!entry) {
      tag("p", "mp-st-empty", "Nothing from this list is stored here yet.", d);
      return;
    }
    tag("p", "mp-st-item", entry.item, d);
    var dl = tag("dl", "mp-st-dl", null, d);
    CHANNELS.forEach(function (c) {
      var dt = tag("dt", null, c + " ", dl);
      if (IMAGINED[c]) tag("span", "mp-chip", "imagined cue", dt);
      tag("dd", null, entry.record[c], dl);
    });
  }

  // Each list item becomes a disclosure: its button keeps the station text, its region holds the detail.
  // The list is the station's one detail view (route-first: the walk works from the list alone); the map
  // markers select into it.
  function buildList() {
    document.querySelectorAll(".mp-route ol > li").forEach(function (li, i) {
      var n = i + 1;
      var btn = tag("button", "mp-st", li.textContent.trim());
      btn.type = "button";
      btn.id = "mp-st-" + n;
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("aria-controls", "mp-st-d-" + n);
      var d = tag("div", "mp-st-detail");
      d.id = "mp-st-d-" + n;
      d.hidden = true;
      d.setAttribute("role", "region");
      d.setAttribute("aria-labelledby", btn.id);
      fillDetail(d, i);
      li.replaceChildren(btn, d);
      btn.addEventListener("click", function () { select(selected === i ? -1 : i, false); });
      buttons[i] = btn;
      details[i] = d;
    });
    document.querySelector(".mp-route").addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || selected < 0) return;
      var b = buttons[selected];
      select(-1, false);
      b.focus();
    });
  }

  // Open station i's detail (i < 0 closes it), ring its marker, and bring its true spot onto the map. A
  // marker click also moves focus into the list item, so keyboard and screen reader users land on the detail.
  function select(i, fromMarker) {
    selected = i;
    buttons.forEach(function (b, j) {
      b.setAttribute("aria-expanded", String(j === i));
      details[j].hidden = j !== i;
    });
    markers.forEach(function (g, j) { g.classList.toggle("lm-selected", j === i); });
    if (i < 0) return;
    if (fromMarker) buttons[i].focus({ preventScroll: true });
    buttons[i].parentNode.scrollIntoView({ block: "nearest" });
    // The phone list grows while a station is open: resize the map first, then check the spot.
    if (liveMap) requestAnimationFrame(function () { liveMap.resize(); showSpot(i); });
  }

  // Centre on the station when its spot is off the map or too near the edge to draw unpinned.
  function showSpot(i) {
    var c = liveMap.getContainer(), p = liveMap.project(STATIONS[i].lngLat);
    if (p.x >= PIN_SIDE && p.x <= c.clientWidth - PIN_SIDE && p.y >= PIN_TOP &&
      p.y <= c.clientHeight - PIN_BOTTOM) return;
    liveMap.easeTo({ center: STATIONS[i].lngLat, duration: reduceMotion ? 0 : 500 });
  }

  // Same structure and classes as docs/design/route/map-shell.js drawRoute/landmark, so map-shell.css styles
  // it; --k is unset here, so its calc(var(--k, 1) * Npx) sizes resolve to N screen px.
  function drawRoute(map) {
    var svg = document.getElementById("overlay");
    var route = el("g", "route tc-0");
    var halo = el("polyline", "route-halo", route);
    var line = el("polyline", "route-line", route);
    var arrows = [];
    var groups = STATIONS.map(function (st, i) {
      var g = el("g", "lm", route);
      g.style.setProperty("--i", i);
      // The true spot, for scripts/screenshot_map.py's pan check (a pinned station is drawn elsewhere).
      g.setAttribute("data-lnglat", st.lngLat.join(","));
      el("title", null, g).textContent = (i + 1) + ". " + st.title;
      // A marker is a button into its station's detail in the list. The 16px hit circle (map-shell.css
      // .lm-hit, pointer-events: all) takes the click through the otherwise pointer-events: none overlay.
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "button");
      g.setAttribute("aria-label", (i + 1) + ". " + st.title);
      g.setAttribute("aria-controls", "mp-st-d-" + (i + 1));
      g.addEventListener("click", function () { select(i, true); });
      g.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        select(i, true);
      });
      el("circle", "lm-hit", g);
      // Shown only while pinned to the map edge; place() rotates it toward the true spot.
      arrows[i] = el("path", "lm-arrow", g);
      arrows[i].setAttribute("d", "M22 0 L14 -6 L14 6 Z");
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
    markers = groups;
    liveMap = map;
    if (selected >= 0) groups[selected].classList.add("lm-selected");
    function place() {
      var pts = ROUTE.map(function (ll) {
        var p = map.project(ll);
        return p.x.toFixed(1) + "," + p.y.toFixed(1);
      }).join(" ");
      halo.setAttribute("points", pts);
      line.setAttribute("points", pts);
      // Like an off-screen marker in a game: a station whose spot is off the map is pressed against the
      // edge at the nearest point to it, with an arrow toward the spot. Stations near the edge are nudged
      // in so they draw whole. Known limitation: several off-map stations in one direction stack on one
      // edge point or corner.
      var c = map.getContainer(), w = c.clientWidth, h = c.clientHeight;
      STATIONS.forEach(function (st, i) {
        var p = map.project(st.lngLat);
        var x = Math.min(Math.max(p.x, PIN_SIDE), w - PIN_SIDE);
        var y = Math.min(Math.max(p.y, PIN_TOP), h - PIN_BOTTOM);
        var off = p.x < 0 || p.y < 0 || p.x > w || p.y > h;
        groups[i].classList.toggle("lm-pinned", off);
        if (off) {
          var deg = Math.atan2(p.y - y, p.x - x) * 180 / Math.PI;
          arrows[i].setAttribute("transform", "rotate(" + deg.toFixed(1) + ")");
        }
        groups[i].setAttribute("transform", "translate(" + x.toFixed(1) + " " + y.toFixed(1) + ")");
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

  // The list and its details work with or without the map (the sketch fallback keeps them).
  buildList();
  if (typeof maplibregl === "undefined" || typeof pmtiles === "undefined") {
    fallback("map libraries missing");
    return;
  }
  // A failed check, or no WebGL (the Map constructor throws), both land on the sketch fallback.
  loadArchive().then(start).catch(function (err) { fallback(err.message); });
})();
