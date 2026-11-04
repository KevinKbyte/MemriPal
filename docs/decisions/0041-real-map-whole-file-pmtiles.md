# 0041: Real map: bundled PMTiles extract fetched whole into memory, MapLibre 5.24 CSP build, Python extract script

Status: Accepted
Date: 2026-11-02
Source: MEM-074..MEM-078 (`.claude/spec-cache/memripal/references/spec-4.md`); plan `docs/plans/2026-11-02-real-map.md`;
amends [0038](0038-route-first-flow.md) "Amendment 2026-11-01: map source" condition 2.

## Context

ADR 0038 staged option A (MapLibre GL JS + self-hosted Protomaps PMTiles for `geo` routes, SVG sketch otherwise) behind
conditions 1-10. Kev chose to build it (2026-11-02): Kendall Square, Cambridge MA, bbox `(-71.1083, 42.3494, -71.0719,
42.3764)` (min lon, min lat, max lon, max lat), zooms 12-14. Condition 2 left the tile transport open (bundle in `www/`
and verify Range, or wire CORS). Found since:

- Capacitor 8.6 `WebViewLocalServer` answers a Range request with 206 and a correct `Content-Range` but streams
  offset..EOF, unsliced (source at tag 8.6.0; not probed on a device).
- In the shell, `static/api_base.js` `apiUrl()` prefixes root-relative paths with the Cloud Run origin and `cors.py`
  `add_cors` is not wired, so a root-relative tile fetch goes cross-origin and fails in the shell only.
- Capacitor may answer a missing asset with `index.html` and 200; pmtiles then throws "Wrong magic number" inside the
  MapLibre protocol handler: a blank map, not the sketch fallback.
- Starlette serves `.pmtiles` as `text/plain` (no `mimetypes` entry), a type proxies like to gzip.
- `@protomaps/basemaps` `layers()` emits label layers only when `options.lang` is set.
- The only official extractor is the Go `pmtiles extract` CLI (no Go on the host); PyPI `pmtiles` 3.8.1 has `Reader`
  and `Writer` but no bbox extract. Planet builds: `https://build.protomaps.com/YYYYMMDD.pmtiles`, listed at
  `https://build-metadata.protomaps.dev/builds.json` (latest 20261102), about one week retention, Range works, no CORS.
- maplibre-gl 6.x is ESM-only, removes the CSP bundle and requires WebGL2.
- Headless shooters launch Chrome with `--disable-gpu` (ADR 0036); Playwright adds `--enable-unsafe-swiftshader`, but
  WebGL under that combination is unverified.

## Options considered

Tile transport:

- (a) Whole file in memory (chosen). One GET of the committed extract; the body is held as a Blob and read through
  pmtiles' built-in `FileSource`; no Range request anywhere.
  Pros: one code path on web and shell; Capacitor's Range behaviour is irrelevant; works offline in the APK; no CORS
  wiring; `FileSource` returns copies via `Blob.slice`, so MapLibre transferring a tile buffer to its worker cannot
  detach the archive; no custom Source code. Secondary: no per-tile requests reveal where in the bbox the user looks.
  Cons: first paint on the web waits for the whole file (about 25 s at 3 MiB on a 1 Mbps link); the extract must stay
  small (one neighbourhood); APK grows by the extract size.
- (b) HTTP Range via pmtiles' default `FetchSource`.
  Pros: simplest on the web alone (Starlette 0.52 `FileResponse` already answers 206; pmtiles needs only a URL); first
  paint needs the 16 KiB header and root directory plus a few tiles.
  Cons: Capacitor 8.6 returns offset..EOF instead of the requested slice, so correctness needs an on-device probe;
  fetching via the API origin needs CORS (`Range` allowed, `Content-Range`/`ETag` exposed); two behaviours to test.
- (c) Exploded z/x/y tile directory (one file per tile under static/map/).
  Pros: plain static files; no pmtiles runtime; any server works.
  Cons: an extra build step and hundreds of files in git and the APK; every tile URL names a z/x/y, i.e. the viewport,
  in access logs; no single file to validate or budget.

MapLibre version:

- (5.24) maplibre-gl 5.24.0 CSP build (chosen; vendored at 1e46d72).
  Pros: ships `maplibre-gl-csp.js` + `maplibre-gl-csp-worker.js`, a same-origin worker via `setWorkerUrl`, exactly
  ADR 0038 condition 1; a classic script tag, no ES-module worker resolution.
  Cons: the 5.x line gets no new features; a global `maplibregl` instead of imports.
- (6) maplibre-gl 6.16.0.
  Pros: current line; ESM fits the no-bundler module app.
  Cons: no CSP bundle (condition 1 names it); requires WebGL2 (`GPUInitializationError` otherwise) on old WebViews and
  headless shooters; worker resolution via `import.meta.url` untested here.

Extract tool:

- (Python) Own `scripts/build_map_extract.py` on PyPI `pmtiles` 3.8.1 (chosen).
  Pros: stays in the repo's Python/pytest toolchain; testable against a fake in-memory planet; `Reader` over an
  HTTP-Range `get_bytes` plus `Writer` cover the need.
  Cons: re-implements bbox tile enumeration and copy (no overfetch or merging, so more range requests); output must be
  written in ascending tile id to stay clustered. <!-- claim-exempt: planned -->
- (Go) Official `pmtiles extract` CLI.
  Pros: official; overfetch, merging and dedupe built in.
  Cons: a new binary toolchain absent on the host; not testable from pytest; another download to pin.

## Decision

Option (a), maplibre-gl 5.24.0 CSP build, Python extract script. Amends ADR 0038 map-source condition 2: the extract
is bundled (`static/map/kendall.pmtiles`, copied into `www/` by `scripts/build_mobile_web.mjs`) and fetched whole, so
the "verify it answers 206" and CORS branches no longer apply. ADR 0038 conditions 1 and 3-10 stand. Each condition
below is a test or a recorded probe: <!-- claim-exempt: planned -->

1. Whole file: exactly one GET of the extract per session, no `Range` header; tiles read through
   `new PMTiles(new FileSource(new File([blob], "kendall")))`, so `getKey()` is `kendall`, matching the style source
   `pmtiles://kendall`; no custom Source.
2. Same-origin relative URL: the extract URL is module-relative (`new URL("map/kendall.pmtiles", import.meta.url)` from
   a module in `static/`), never root-relative, never via `apiUrl`/`withApiBase`; a test asserts the map module does not
   import `api_base.js`.
3. Validate before use: `res.ok`, bytes 0-6 == `PMTiles`, byte 7 (spec version) == 3, byteLength <= 3 MiB; any failure
   (404, HTML body with 200, truncated body, oversize) -> sketch fallback, never a blank canvas.
4. Progressive: the SVG sketch (`static/route_map.js`) renders first and stays until the map's first `idle`; the fetch
   starts on route-view entry, never at app boot.
5. Budget: committed `static/map/kendall.pmtiles` <= 3 MiB (3,145,728 bytes), zooms 12-14, the Context bbox; a `geo`
   route with any station outside the bbox renders as sketch. <!-- claim-exempt: planned -->
6. MIME: `.pmtiles` served as `application/vnd.pmtiles` (registered with `mimetypes.add_type`), never `text/plain`.
7. Labels: styles built from `layers("kendall", namedFlavor(f), {lang: "en"})`; light and dark style JSON each hold >= 1
   `symbol` layer with a `text-field`.
8. Local assets: style `glyphs` and `sprite` point at `static/map/fonts` and `static/map/sprites/v4/<flavour>`,
   resolved same-origin at load; fetched style fields (`sources.*.url`, `glyphs`, `sprite`) hold 0 `http(s)://` URLs.
9. Planet server-side only: the extract script picks a key from `builds.json` and reads the planet by HTTP Range; the
   browser never contacts a protomaps host; build key, bbox, zooms and output sha256 recorded in `static/map/VERSION`.
10. Headless WebGL: before any map screenshot counts as evidence, a probe records that a WebGL context MapLibre accepts
    is created under the shooters' exact launch args; on failure the flags change via an ADR 0036 amendment.

## Why this over the others

(a) is the only transport whose correctness does not depend on Capacitor's Range handling, which reads wrong for
slices in the 8.6 source and is unprobed on a device; it also gives one code path on both platforms, offline in the
APK, with no CORS. Its cost, a whole-file first paint on slow web links, is bounded by the 3 MiB cap and hidden behind
the sketch that already exists. Privacy is a secondary gain only: uvicorn and Cloud Run logs record path and status,
not Range offsets. (b) is simpler on the web alone but needs a device probe plus CORS in the shell; (c) adds a build
step, many files and per-tile URLs. 5.24 over 6: 6 removed the CSP bundle condition 1 relies on and requires WebGL2.
Python over Go: stays in the tested toolchain; the extra range requests are a one-off build cost.

## Consequences

- Refreshing the extract means re-running the script against a current build key (dated keys 404 after about a week);
  the committed file is the pinned artefact.
- Only Kendall Square gets real streets; elsewhere stays sketch until another extract is built and budgeted.
- APK grows by the extract size (<= 3 MiB).
- Not decided: `Cache-Control` on `/static/map/` (ETag revalidation already applies); no service worker.
- The design gate keeps the stylized SVG (ADR 0038 condition 10); the real map's preview lives outside
  `docs/design/route/`.
