import { haversineMeters } from "./geo";
import type { EtaProvider } from "./eta";
import type { LatLng } from "./order-machine";

export type DriverCandidate = LatLng & { id: string };
export type Ranked = { driverId: string; etaSeconds: number };

export type MatchOptions = {
  candidates: DriverCandidate[];
  pickup: LatLng;
  eta: EtaProvider;
  /** Drivers who declined this order. */
  exclude?: readonly string[];
  /** Drivers slower than this are not offered the job. */
  maxEtaSeconds?: number;
  /** Only this many nearest-by-straight-line drivers reach the (possibly paid or rate-limited) ETA provider. */
  shortlist?: number;
};

/** Rank available drivers by ETA to the pickup, best first. Empty when nobody qualifies. */
export async function rankDrivers(o: MatchOptions): Promise<Ranked[]> {
  const exclude = new Set(o.exclude ?? []);
  const near = o.candidates
    .filter((d) => !exclude.has(d.id))
    .map((d) => ({ d, m: haversineMeters(d, o.pickup) }))
    .sort((a, b) => a.m - b.m || (a.d.id < b.d.id ? -1 : 1))
    .slice(0, o.shortlist ?? 8)
    .map((x) => x.d);
  if (near.length === 0) return [];
  const etas = await o.eta.etaSeconds(near, o.pickup);
  const max = o.maxEtaSeconds ?? 30 * 60;
  return near
    .map((d, i) => ({ driverId: d.id, etaSeconds: etas[i] ?? Number.POSITIVE_INFINITY }))
    .filter((r) => r.etaSeconds <= max)
    .sort((a, b) => a.etaSeconds - b.etaSeconds || (a.driverId < b.driverId ? -1 : 1));
}
