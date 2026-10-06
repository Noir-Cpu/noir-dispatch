import { haversineMeters } from "./geo";
import type { LatLng } from "./order-machine";

/**
 * How far from a station (straight line) we will deliver. A product rule for the demo, not a measurement:
 * the real distance driven is longer. Configurable with the DELIVERY_RADIUS_KM wrangler var.
 */
export const DELIVERY_RADIUS_KM = 12;

export type StationLike = { id: string; name: string; lat: number; lng: number };
export type StationRange<S extends StationLike = StationLike> = { station: S; distanceKm: number; inRange: boolean };

/** Straight-line kilometres between a station and a point. */
export const distanceKm = (a: LatLng, b: LatLng) => haversineMeters(a, b) / 1000;

/** True when the point is within `radiusKm` of the station, boundary included. */
export const withinRadius = (station: LatLng, point: LatLng, radiusKm: number = DELIVERY_RADIUS_KM) => distanceKm(station, point) <= radiusKm;

/** Every station with its distance to `point` and whether it can deliver there, nearest first (ties by id). */
export function stationRanges<S extends StationLike>(stations: readonly S[], point: LatLng, radiusKm: number = DELIVERY_RADIUS_KM): StationRange<S>[] {
  return stations
    .map((station) => {
      const d = distanceKm(station, point);
      return { station, distanceKm: d, inRange: d <= radiusKm };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm || (a.station.id < b.station.id ? -1 : 1));
}

export type RangeAdvice<S extends StationLike = StationLike> = {
  radiusKm: number;
  chosen: StationRange<S> | null;
  ok: boolean;
  /** Nearest station that can deliver to the point (the chosen one when it can), or null when none can. */
  nearestInRange: StationRange<S> | null;
  /** Nearest station overall, in range or not. */
  nearest: StationRange<S> | null;
  /** Kind, plain-English sentence for the UI and the API error. Null when the chosen station is in range. */
  message: string | null;
};

const km1 = (n: number) => (n < 100 ? n.toFixed(1) : String(Math.round(n)));
/** One decimal, or two when rounding would make "12.0 km" look inside a 12 km radius it is just outside. */
const kmOut = (n: number, radiusKm: number) => (Number(n.toFixed(1)) <= radiusKm ? n.toFixed(2) : km1(n));

/** The one place the out-of-range wording lives, so the server error and the order form say the same thing. */
export function rangeAdvice<S extends StationLike>(stations: readonly S[], stationId: string, point: LatLng, radiusKm: number = DELIVERY_RADIUS_KM): RangeAdvice<S> {
  const ranges = stationRanges(stations, point, radiusKm);
  const chosen = ranges.find((r) => r.station.id === stationId) ?? null;
  const nearest = ranges[0] ?? null;
  const nearestInRange = ranges.find((r) => r.inRange) ?? null;
  if (!chosen) return { radiusKm, chosen, ok: false, nearest, nearestInRange, message: "That station does not exist." };
  if (chosen.inRange) return { radiusKm, chosen, ok: true, nearest, nearestInRange, message: null };
  const base = `That drop-off is ${kmOut(chosen.distanceKm, radiusKm)} km from ${chosen.station.name}, outside our ${radiusKm} km delivery radius.`;
  const message = nearestInRange
    ? `${base} ${nearestInRange.station.name} is ${km1(nearestInRange.distanceKm)} km away and can deliver there.`
    : nearest
      ? `${base} No station reaches that point: the nearest is ${nearest.station.name}, ${km1(nearest.distanceKm)} km away. Try a point inside one of the circles on the map.`
      : base;
  return { radiusKm, chosen, ok: false, nearest, nearestInRange, message };
}
