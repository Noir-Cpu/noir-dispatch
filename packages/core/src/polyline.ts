// Pure polyline maths shared by the API (demo movement), the route provider and the web map. No I/O, no
// dependencies, so the browser bundle can import it without pulling in the rest of the core.

import { haversineMeters } from "./geo";
import type { LatLng } from "./order-machine";

const R = 6_371_008.8; // mean Earth radius, metres (same as geo.ts)
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export const distanceM = haversineMeters;

/** Initial bearing from a to b in degrees clockwise from north, 0 to 360. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** The point `meters` from `from` along `bearing` (great circle). Inverse of distanceM, to float precision. */
export function destinationPoint(from: LatLng, bearing: number, meters: number): LatLng {
  const d = meters / R;
  const b = rad(bearing);
  const lat1 = rad(from.lat);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = rad(from.lng) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lng: deg(lng2) };
}

/** Distance from the start to every vertex, metres. First entry is 0. */
export function cumulativeM(points: readonly LatLng[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1]! + distanceM(points[i - 1]!, points[i]!));
  return out;
}

export const polylineLengthM = (points: readonly LatLng[]) => cumulativeM(points).at(-1) ?? 0;

/** Position and heading `s` metres along the line, clamped to its ends. */
export function pointAtM(points: readonly LatLng[], s: number, cum: readonly number[] = cumulativeM(points)): LatLng & { heading: number } {
  if (points.length === 0) throw new Error("empty polyline");
  if (points.length === 1) return { ...points[0]!, heading: 0 };
  const total = cum.at(-1)!;
  const t = Math.min(Math.max(s, 0), total);
  let i = 1;
  while (i < points.length - 1 && cum[i]! < t) i++;
  const a = points[i - 1]!;
  const b = points[i]!;
  const seg = cum[i]! - cum[i - 1]!;
  const f = seg > 0 ? (t - cum[i - 1]!) / seg : 0;
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, heading: bearingDeg(a, b) };
}

/** Nearest point on the line to `p`: distance along the line, and how far `p` is off it. Local flat-earth maths per segment. */
export function projectOnPolyline(points: readonly LatLng[], p: LatLng, cum: readonly number[] = cumulativeM(points)): { s: number; offM: number } {
  if (points.length < 2) return { s: 0, offM: points[0] ? distanceM(points[0], p) : 0 };
  const kx = Math.cos(rad(p.lat)) * (Math.PI / 180) * R;
  const ky = (Math.PI / 180) * R;
  let best = { s: 0, offM: Number.POSITIVE_INFINITY };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
    const bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const f = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const off = Math.hypot(ax + dx * f, ay + dy * f);
    if (off < best.offM) best = { s: cum[i - 1]! + (cum[i]! - cum[i - 1]!) * f, offM: off };
  }
  return best;
}

/** The part of the line after `s` metres, starting at the point itself. */
export function remainingFrom(points: readonly LatLng[], s: number, cum: readonly number[] = cumulativeM(points)): LatLng[] {
  if (points.length === 0) return [];
  const start = pointAtM(points, s, cum);
  const rest = points.filter((_, i) => cum[i]! > s);
  return [{ lat: start.lat, lng: start.lng }, ...rest];
}

/** Douglas-Peucker. Keeps the ends; drops vertices closer than `toleranceM` to the simplified line. */
export function simplifyPolyline(points: readonly LatLng[], toleranceM: number): LatLng[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = projectOnPolyline([points[lo]!, points[hi]!], points[i]!).offM;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (at >= 0 && worst > toleranceM) {
      keep[at] = 1;
      stack.push([lo, at], [at, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export const round5 = (n: number) => Math.round(n * 1e5) / 1e5; // about 1 m
