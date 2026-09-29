import type { LatLng } from "./order-machine";

const R = 6_371_008.8; // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Move `metres` from `from` towards `to`, stopping at `to`. Flat-earth step; fine at city scale. */
export function stepToward(from: LatLng, to: LatLng, metres: number): LatLng {
  const d = haversineMeters(from, to);
  if (d <= metres || d === 0) return { lat: to.lat, lng: to.lng };
  const f = metres / d;
  return { lat: from.lat + (to.lat - from.lat) * f, lng: from.lng + (to.lng - from.lng) * f };
}
