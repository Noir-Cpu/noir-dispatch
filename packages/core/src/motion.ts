// How a marker should travel between two pings. Pure, so it is unit tested here and driven by requestAnimationFrame in the web app.
import { haversineMeters } from "./geo";
import type { LatLng } from "./order-machine";
import { bearingDeg, cumulativeM, pointAtM, projectOnPolyline } from "./polyline";

export type Glide = {
  /** Position and heading at fraction f of the way, 0 to 1 (clamped). */
  at(f: number): LatLng & { heading: number };
  /** True when the glide follows the route rather than cutting straight across. */
  alongRoute: boolean;
};

/** A ping further than this from the route line is treated as off-route and the marker glides straight instead. */
export const OFF_ROUTE_M = 120;

/**
 * Plan the move from where the marker is drawn now (`from`) to the newly reported position (`to`).
 * With a route, and both points close to it and `to` not behind `from`, the marker follows the road, so it never cuts corners
 * or crosses blocks. Otherwise it glides in a straight line. Either way the heading is the direction of travel.
 */
export function planGlide(route: readonly LatLng[] | null | undefined, from: LatLng, to: LatLng, fallbackHeading = 0): Glide {
  if (route && route.length >= 2) {
    const cum = cumulativeM(route);
    const a = projectOnPolyline(route, from, cum);
    const b = projectOnPolyline(route, to, cum);
    if (a.offM <= OFF_ROUTE_M && b.offM <= OFF_ROUTE_M && b.s >= a.s - 1) {
      return { alongRoute: true, at: (f) => pointAtM(route, a.s + (b.s - a.s) * clamp01(f), cum) };
    }
  }
  const moved = haversineMeters(from, to);
  const heading = moved > 1 ? bearingDeg(from, to) : fallbackHeading;
  return {
    alongRoute: false,
    at: (f) => {
      const t = clamp01(f);
      return { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t, heading };
    },
  };
}

const clamp01 = (f: number) => Math.min(1, Math.max(0, f));

/** Metres of road still to go from `p` to the end of the route (counting how far `p` is off the line), or straight-line to `end` without one. */
export function distanceToGo(route: readonly LatLng[] | null | undefined, p: LatLng, end: LatLng): number {
  if (!route || route.length < 2) return haversineMeters(p, end);
  const cum = cumulativeM(route);
  const pr = projectOnPolyline(route, p, cum);
  return pr.offM > OFF_ROUTE_M ? haversineMeters(p, end) : Math.max(0, cum.at(-1)! - pr.s) + pr.offM;
}
