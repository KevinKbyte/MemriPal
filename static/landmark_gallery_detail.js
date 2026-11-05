// @ts-check
// Landmarks-tab tile detail dialog (MEM-136, ADR 0079): one native <dialog id="landmark-detail"> inside
// #tab-landmarks, rebuilt on every open. Pure builder over an injected doc. Names, addresses, profile lines and
// facts are user or seeded data, so all text goes through textContent; hrefs are http(s) only and the photo src
// is blob:/data:image only.

/** @typedef {import("./landmark_gallery.js").GalleryItem} GalleryItem */
/** @typedef {import("./landmark_facts.js").LandmarkFact} LandmarkFact */

const DIALOG_ID = "landmark-detail";
const TITLE_ID = "landmark-detail-title";
const MAX_FACTS = 3;
const SAFE_PHOTO = /^(blob:|data:image\/(png|jpeg|webp);base64,)/;
const SAFE_HREF = /^https?:\/\//i;

/**
 * Per-dialog state across opens: the element to refocus on close, and an open counter so a photo resolving for
 * an earlier open is dropped.
 * @type {WeakMap<any, { opener: any, seq: number }>}
 */
const states = new WeakMap();

/** @param {unknown} v @returns {string} trimmed text, "" when absent */
const str = (v) => (typeof v === "string" ? v.trim() : "");

/** @param {any} d */
function refocus(d) {
  states.get(d)?.opener?.focus?.();
}

/**
 * Native dialogs fire "close", whose listener refocuses; the attribute fallback refocuses here.
 * @param {any} d
 */
function closeDialog(d) {
  if (typeof d.close === "function") {
    d.close();
    return;
  }
  d.removeAttribute("open");
  refocus(d);
}

/** @param {Document} doc */
function ensureDialog(doc) {
  const existing = doc.getElementById(DIALOG_ID);
  if (existing) return existing;
  const d = doc.createElement("dialog");
  d.id = DIALOG_ID;
  d.className = "lg-detail";
  d.setAttribute("aria-labelledby", TITLE_ID);
  d.addEventListener("close", () => refocus(d));
  d.addEventListener("keydown", (/** @type {any} */ ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault?.();
    closeDialog(d);
  });
  doc.getElementById("tab-landmarks")?.append(d);
  return d;
}

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function make(doc, tag, className, text) {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** @param {Document} doc @param {string} href @param {string} text */
function link(doc, href, text) {
  const a = make(doc, "a", "", text);
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
  return a;
}

/** @param {Document} doc @param {string} title */
function section(doc, title) {
  const s = make(doc, "section", "lg-detail-section");
  s.append(make(doc, "h3", "", title));
  return s;
}

/** @param {GalleryItem} item @returns {{ lat: number, lon: number } | null} */
function coordsOf(item) {
  const lat = item.candidate ? item.poi?.lat : item.station?.coords?.lat;
  const lon = item.candidate ? item.poi?.lng : item.station?.coords?.lon;
  return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon)
    ? { lat, lon } : null;
}

/** @param {Document} doc @param {GalleryItem} item */
function locationSection(doc, item) {
  const address = str(item.candidate ? item.poi?.address : item.station?.address);
  const coords = coordsOf(item);
  if (!address && !coords) return null;
  const s = section(doc, "Location");
  if (address) s.append(make(doc, "p", "lg-detail-address", address));
  if (coords) {
    const lat = coords.lat.toFixed(5);
    const lon = coords.lon.toFixed(5);
    const p = make(doc, "p", "lg-detail-coords", `${lat}, ${lon} `);
    p.append(link(doc, `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`, "Open in Maps"));
    s.append(p);
  }
  return s;
}

/** @param {Document} doc @param {GalleryItem} item */
function profileSection(doc, item) {
  const profile = item.station?.profile;
  const entries = profile && typeof profile === "object"
    ? Object.entries(profile).filter(([k, v]) => str(k) && str(v)) : [];
  if (!entries.length) return null;
  const s = section(doc, "Profile");
  const dl = make(doc, "dl", "lg-detail-profile");
  for (const [k, v] of entries) dl.append(make(doc, "dt", "", k), make(doc, "dd", "", str(v)));
  s.append(dl);
  return s;
}

/**
 * @param {Document} doc
 * @param {GalleryItem} item
 * @param {((id: string) => LandmarkFact[]) | undefined} factsFor
 */
function factsSection(doc, item, factsFor) {
  if (!item.station || typeof factsFor !== "function") return null;
  const raw = factsFor(item.station.id);
  const facts = (Array.isArray(raw) ? raw : []).filter((f) => str(f?.text)).slice(0, MAX_FACTS);
  if (!facts.length) return null;
  const s = section(doc, "Facts");
  const ul = make(doc, "ul", "lg-detail-facts");
  for (const f of facts) {
    const li = make(doc, "li", "", str(f.text));
    const url = str(f.url);
    if (SAFE_HREF.test(url)) li.append(" ", link(doc, url, str(f.title) || url));
    ul.append(li);
  }
  s.append(ul);
  return s;
}

/**
 * @param {Document} doc
 * @param {GalleryItem} item
 * @param {() => void} close
 * @param {((id: string) => unknown) | undefined} onOpenRoute
 */
function routesSection(doc, item, close, onOpenRoute) {
  const names = item.routeNames.join(", ");
  const wrap = make(doc, "div", "lg-detail-routes");
  if (names) wrap.append(make(doc, "p", "", item.candidate ? `Candidate for: ${names}` : `On routes: ${names}`));
  if (item.candidate || !item.routes.length) return wrap;
  const actions = make(doc, "div", "lg-detail-actions");
  item.routes.forEach((id, i) => {
    const name = item.routeNames[i] ?? "";
    const btn = make(doc, "button", "lg-detail-open", name ? `Open route: ${name}` : "Open route");
    btn.setAttribute("type", "button");
    btn.addEventListener("click", () => {
      close();
      onOpenRoute?.(id);
    });
    actions.append(btn);
  });
  wrap.append(actions);
  return wrap;
}

/**
 * Open (or reopen) the detail dialog for one gallery item.
 * @param {GalleryItem} item
 * @param {{
 *   doc: Document,
 *   getPhotoUrl?: (ref: string) => Promise<string | null>,
 *   onOpenRoute?: (routeId: string) => unknown,
 *   factsFor?: (stationId: string) => LandmarkFact[],
 *   opener?: { focus?: () => void } | null,
 * }} deps
 * @returns {{ close(): void }}
 */
export function openGalleryDetail(item, { doc, getPhotoUrl, onOpenRoute, factsFor, opener = null }) {
  const d = /** @type {any} */ (ensureDialog(doc));
  const seq = (states.get(d)?.seq ?? 0) + 1;
  states.set(d, { opener, seq });
  const close = () => closeDialog(d);

  const header = make(doc, "header", "lg-detail-header");
  const thumb = make(doc, "span", "lg-detail-thumb", item.emoji);
  thumb.setAttribute("aria-hidden", "true");
  const title = make(doc, "h2", "lg-detail-title", item.name);
  title.id = TITLE_ID;
  const closeBtn = make(doc, "button", "lg-detail-close", "Close");
  closeBtn.setAttribute("type", "button");
  closeBtn.addEventListener("click", close);
  header.append(thumb, title, closeBtn);

  d.replaceChildren(...[
    header,
    routesSection(doc, item, close, onOpenRoute),
    locationSection(doc, item),
    profileSection(doc, item),
    factsSection(doc, item, factsFor),
  ].filter(Boolean));

  if (item.photo_ref && typeof getPhotoUrl === "function") {
    // A rejected photo read keeps the emoji.
    Promise.resolve(getPhotoUrl(item.photo_ref)).then((url) => {
      if (states.get(d)?.seq !== seq || typeof url !== "string" || !SAFE_PHOTO.test(url)) return;
      const img = doc.createElement("img");
      img.setAttribute("alt", "");
      img.src = url;
      thumb.removeAttribute("aria-hidden");
      thumb.replaceChildren(img);
    }, () => {});
  }

  if (!d.open) {
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
  }
  return { close };
}
