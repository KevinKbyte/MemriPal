// @ts-check
// Zero-route Routes tab (MEM-114): the real basemap at a default spot instead of a blank panel, with Load demo
// and Map a new route over it. The buttons click the drawer's #load-demo / #routes-new, so their handlers stay
// the only copy of that logic.

/**
 * Kendall Square, where the demo route walks. Not Meta's Menlo Park HQ: the self-hosted extract
 * (static/real_map.js REAL_MAP_BBOX) only covers Kendall, so a center outside it would render no tiles.
 */
export const EMPTY_MAP_CENTER = Object.freeze({ lat: 42.3664, lon: -71.0832 });
export const EMPTY_MAP_ZOOM = 15;
export const SLOGAN = "Make what's important unforgettable";

/**
 * @param {{ doc: Document, realMap?: { mountAt?: (svg: any, center: { lat: number, lon: number }, zoom: number) => Promise<unknown> } }} deps
 * @returns {{ show(): void, hide(): void }}
 */
export function createEmptyMap({ doc, realMap }) {
  /** @type {HTMLElement | null} */
  let cta = null;

  /** @param {string} text @param {string} action @param {string} targetId */
  const relay = (text, action, targetId) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "btn btn-primary";
    b.textContent = text;
    b.setAttribute("data-action", action);
    b.addEventListener("click", () => doc.getElementById(targetId)?.click());
    return b;
  };

  return {
    show() {
      if (cta) return;
      const svg = doc.getElementById("route-map");
      // Older loaders (and test fakes) have no mountAt: the call to action still shows.
      if (typeof realMap?.mountAt === "function") {
        realMap.mountAt(svg, EMPTY_MAP_CENTER, EMPTY_MAP_ZOOM).catch(() => {});
      }
      cta = doc.createElement("div");
      cta.classList.add("empty-map-cta");
      const title = doc.createElement("p");
      title.className = "empty-map-slogan";
      title.textContent = SLOGAN;
      const row = doc.createElement("div");
      row.className = "btn-row";
      row.append(relay("Load demo", "empty-load-demo", "load-demo"), relay("Map a new route", "empty-new-route", "routes-new"));
      cta.append(title, row);
      svg?.parentElement?.append(cta);
      // The CTA says the same as the MEM-088 text notice, with buttons; two cards would stack over the map.
      doc.getElementById("map-empty")?.setAttribute("hidden", "");
    },
    hide() {
      cta?.remove();
      cta = null;
    },
  };
}
