// @ts-check
// MEM-025 place context (ADR 0022): EXIF GPS reader and the opt-in place-history state.

const TAG_GPS_IFD = 0x8825;
const TAG_LAT_REF = 1;
const TAG_LAT = 2;
const TAG_LON_REF = 3;
const TAG_LON = 4;
const TYPE_RATIONAL = 5;
const STORAGE_KEY = "memripal.placeHistory";

/**
 * @typedef {{lat: number, lon: number}} Coords
 * @typedef {{title: string, extract: string}} Place
 * @typedef {{type: number, count: number, at: number}} IfdEntry
 */

/**
 * Coords from a JPEG's APP1 Exif GPS IFD, or null. Every read is bounds-checked by DataView, so
 * truncated or malformed input throws inside and comes back as null.
 * @param {Uint8Array | ArrayBuffer} bytes
 * @returns {Coords | null}
 */
export function readGps(bytes) {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (v.getUint16(0) !== 0xffd8) return null;
    let o = 2;
    while (o + 4 <= v.byteLength) {
      const marker = v.getUint16(o);
      // Not a marker, or start of scan: no metadata segments follow.
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null;
      if (marker === 0xffe1 && v.getUint32(o + 4) === 0x45786966 && v.getUint16(o + 8) === 0) {
        return gpsFromTiff(v, o + 10);
      }
      o += 2 + v.getUint16(o + 2);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {DataView} v
 * @param {number} t offset of the TIFF header
 * @returns {Coords | null}
 */
function gpsFromTiff(v, t) {
  const order = v.getUint16(t);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const le = order === 0x4949;
  /** @param {number} p */
  const u16 = (p) => v.getUint16(t + p, le);
  /** @param {number} p */
  const u32 = (p) => v.getUint32(t + p, le);
  if (u16(2) !== 42) return null;
  /**
   * @param {number} p
   * @returns {Map<number, IfdEntry>}
   */
  const ifd = (p) => {
    const out = new Map();
    const n = u16(p);
    for (let i = 0; i < n; i++) {
      const e = p + 2 + i * 12;
      out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return out;
  };
  const pointer = ifd(u32(4)).get(TAG_GPS_IFD);
  if (!pointer) return null;
  const gps = ifd(u32(pointer.at));
  const lat = degrees(gps.get(TAG_LAT), u32);
  const lon = degrees(gps.get(TAG_LON), u32);
  const latRef = ref(gps.get(TAG_LAT_REF), v, t);
  const lonRef = ref(gps.get(TAG_LON_REF), v, t);
  if (lat === null || lon === null || !latRef || !lonRef) return null;
  const signedLat = latRef === "S" ? -lat : lat;
  const signedLon = lonRef === "W" ? -lon : lon;
  if (!(Math.abs(signedLat) <= 90 && Math.abs(signedLon) <= 180)) return null;
  return { lat: signedLat, lon: signedLon };
}

/**
 * Degrees from three RATIONALs (deg, min, sec); null on a wrong type or a zero denominator.
 * @param {IfdEntry | undefined} entry
 * @param {(p: number) => number} u32
 * @returns {number | null}
 */
function degrees(entry, u32) {
  if (!entry || entry.type !== TYPE_RATIONAL || entry.count < 3) return null;
  const p = u32(entry.at);
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const den = u32(p + i * 8 + 4);
    if (den === 0) return null;
    total += u32(p + i * 8) / den / 60 ** i;
  }
  return total;
}

/**
 * The one-letter ASCII ref (N/S/E/W), stored inline in the entry's value field.
 * @param {IfdEntry | undefined} entry
 * @param {DataView} v
 * @param {number} t
 * @returns {string | null}
 */
function ref(entry, v, t) {
  if (!entry) return null;
  const letter = String.fromCharCode(v.getUint8(t + entry.at));
  return "NSEW".includes(letter) ? letter : null;
}

/**
 * Opt-in place-history state: the toggle persists in storage (OFF unless stored "on"); a storage
 * that throws reads as off and never throws on write. A typed place is sent even with the toggle
 * off; a confirmed (looked-up) place only while it is on, and turning it off discards it.
 * @param {{getItem: (k: string) => string | null, setItem: (k: string, v: string) => void}} storage
 */
export function createPlaceState(storage) {
  let on = false;
  try {
    on = storage.getItem(STORAGE_KEY) === "on";
  } catch {
    on = false;
  }
  /** @type {Place | null} */
  let confirmed = null;
  /** @type {string | null} */
  let typed = null;
  return {
    enabled: () => on,
    /** @param {boolean} value */
    setEnabled(value) {
      on = Boolean(value);
      if (!on) confirmed = null;
      try {
        storage.setItem(STORAGE_KEY, on ? "on" : "off");
      } catch {
        // Storage disabled: the choice lasts for this page only.
      }
    },
    /** @param {Place | null} place */
    confirm(place) {
      confirmed = place ? { title: place.title, extract: place.extract } : null;
      if (confirmed) typed = null;
    },
    /** @param {string} title blank clears the typed place */
    setTyped(title) {
      const trimmed = String(title).trim();
      typed = trimmed ? trimmed : null;
      if (typed) confirmed = null;
    },
    /** @returns {Place | null} */
    current() {
      if (typed) return { title: typed, extract: "" };
      return on && confirmed ? { ...confirmed } : null;
    },
  };
}

/**
 * @typedef {ReturnType<typeof createPlaceState>} PlaceState
 * @typedef {{title: string, distance_m: number, extract: string}} NearbyPlace
 * @typedef {{doc: Pick<Document, "getElementById" | "createElement">, fetch: typeof fetch, place: PlaceState}} PlaceDeps
 */

const LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";

/**
 * 4 dp is about 11 m: plenty for a 500 m GeoSearch, and no finer location leaves the browser.
 * @param {number} x
 */
const round4 = (x) => Math.round(x * 1e4) / 1e4;

// Only the latest lookup may draw chips, so a slow answer for an older photo never wins.
let latestLookup = 0;

/**
 * Best-effort lookup: coords (from getCoords) -> POST /place -> chips. Any failure shows no chips.
 * Re-checks the toggle after every await, so switching it off mid-lookup sends and shows nothing.
 * @param {() => Promise<Coords | null>} getCoords
 * @param {PlaceDeps} deps
 */
export async function lookupPlace(getCoords, deps) {
  const token = ++latestLookup;
  const live = () => token === latestLookup && deps.place.enabled();
  showPlaces([], deps);
  try {
    const coords = await getCoords();
    if (!coords || !live()) return;
    const resp = await deps.fetch("/place", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: round4(coords.lat), lon: round4(coords.lon) }),
    });
    const payload = resp.ok ? await resp.json() : null;
    if (!live()) return;
    showPlaces(payload && Array.isArray(payload.places) ? payload.places : [], deps);
  } catch {
    // Place context is optional: the upload flow carries on without it.
  }
}

/**
 * Chips "Near: <title>, <m> m"; a click confirms that place. Wikipedia text only via textContent.
 * @param {unknown[]} places
 * @param {PlaceDeps} deps
 */
export function showPlaces(places, deps) {
  const box = deps.doc.getElementById("places");
  if (!box) return;
  box.replaceChildren();
  const valid = /** @type {NearbyPlace[]} */ (
    places.filter(
      (p) =>
        p !== null &&
        typeof p === "object" &&
        typeof (/** @type {NearbyPlace} */ (p).title) === "string" &&
        typeof (/** @type {NearbyPlace} */ (p).distance_m) === "number" &&
        typeof (/** @type {NearbyPlace} */ (p).extract) === "string",
    )
  );
  if (valid.length === 0) return;
  /** @type {HTMLElement[]} */
  const chips = [];
  for (const p of valid) {
    const chip = deps.doc.createElement("button");
    chip.setAttribute("type", "button");
    chip.setAttribute("aria-pressed", "false");
    chip.setAttribute("title", p.extract);
    chip.textContent = `Near: ${p.title}, ${p.distance_m} m`;
    chip.addEventListener("click", () => {
      deps.place.confirm({ title: p.title, extract: p.extract });
      for (const c of chips) c.setAttribute("aria-pressed", String(c === chip));
    });
    chips.push(chip);
  }
  const credit = deps.doc.createElement("a");
  credit.setAttribute("href", LICENSE_URL);
  credit.setAttribute("target", "_blank");
  credit.setAttribute("rel", "noopener noreferrer");
  credit.textContent = "Place text: Wikipedia, CC BY-SA";
  box.append(...chips, credit);
}

/**
 * navigator.geolocation as {lat, lon} | null; null on denial, timeout or outside a secure context.
 * @returns {Promise<Coords | null>}
 */
export function browserGeolocate() {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 10000, maximumAge: 300000 },
    );
  });
}

/**
 * Page controls: #place-toggle mirrors the stored choice (switching it off clears the chips) and
 * #place-typed sets the typed place.
 * @param {Pick<Document, "getElementById" | "createElement">} doc
 * @param {PlaceState} place
 */
export function wirePlace(doc, place) {
  const toggle = /** @type {HTMLInputElement | null} */ (doc.getElementById("place-toggle"));
  if (toggle) {
    toggle.checked = place.enabled();
    toggle.addEventListener("change", () => {
      place.setEnabled(toggle.checked);
      const box = doc.getElementById("places");
      if (!toggle.checked && box) box.replaceChildren();
    });
  }
  const typed = /** @type {HTMLInputElement | null} */ (doc.getElementById("place-typed"));
  if (typed) typed.addEventListener("input", () => place.setTyped(typed.value));
}
