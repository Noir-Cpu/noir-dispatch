// Marker artwork as inline SVG strings (static, written here, never built from user input). Used by the map and by the legend, so
// the legend shows exactly what is on the map. The three kinds differ in SHAPE and GLYPH, not only colour:
//   station  = square with a fuel pump
//   drop-off = pin with a house
//   driver   = round badge with a heading arrow, white halo and dark outline so it reads on any map tile
// Fixed colours (not theme tokens) on purpose: the tiles are always light, so dark outlines and white halos must not flip in dark mode.

export type MarkerKind = "station" | "dropoff" | "driver" | "driver-idle";

const INK = "#111111";
const WHITE = "#ffffff";
const AMBER = "#ffc21a";
const RED = "#d8321e";

const station = (s: number) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">` +
  `<rect x="1.5" y="1.5" width="29" height="29" fill="${INK}" stroke="${WHITE}" stroke-width="3"/>` +
  `<rect x="8" y="6" width="10" height="17" rx="1.5" fill="${WHITE}"/><rect x="10" y="8.5" width="6" height="4.5" fill="${INK}"/>` +
  `<path d="M18 11h2.2a1.6 1.6 0 0 1 1.6 1.6v6a1.1 1.1 0 0 0 2.2 0V11l-2.6-2.4" fill="none" stroke="${WHITE}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<rect x="6" y="23.5" width="14" height="2.2" fill="${WHITE}"/></svg>`;

const dropoff = (s: number) =>
  `<svg width="${s}" height="${Math.round(s * 1.25)}" viewBox="0 0 32 40" aria-hidden="true" focusable="false">` +
  `<path d="M16 38.5C16 38.5 3 24 3 14.5a13 13 0 0 1 26 0C29 24 16 38.5 16 38.5z" fill="${RED}" stroke="${WHITE}" stroke-width="4" paint-order="stroke"/>` +
  `<path d="M16 38.5C16 38.5 3 24 3 14.5a13 13 0 0 1 26 0C29 24 16 38.5 16 38.5z" fill="${RED}" stroke="${INK}" stroke-width="1.6"/>` +
  `<path d="M16 7.8 8.2 14.4h2.3v7.1h4.1v-4.6h2.8v4.6h4.1v-7.1h2.3z" fill="${WHITE}"/></svg>`;

// A navigation arrow: it points up and the map rotates it to the heading.
const driver = (s: number, idle: boolean) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 40 40" aria-hidden="true" focusable="false">` +
  `<circle cx="20" cy="20" r="18.5" fill="${WHITE}"/>` +
  `<circle cx="20" cy="20" r="15" fill="${idle ? WHITE : AMBER}" stroke="${INK}" stroke-width="2.6"/>` +
  `<path d="M20 8.5 28.5 30 20 25.5 11.5 30z" fill="${INK}" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

export function markerSvg(kind: MarkerKind, size = 32): string {
  if (kind === "station") return station(size);
  if (kind === "dropoff") return dropoff(size);
  return driver(Math.round(size * 1.1), kind === "driver-idle");
}

/** Size and anchor (the point on the icon that sits on the coordinate), by kind. */
export function markerBox(kind: MarkerKind): { w: number; h: number; ax: number; ay: number } {
  if (kind === "station") return { w: 32, h: 32, ax: 16, ay: 16 };
  if (kind === "dropoff") return { w: 32, h: 40, ax: 16, ay: 40 };
  return { w: 35, h: 35, ax: 17.5, ay: 17.5 };
}
