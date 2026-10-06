import { haversineMeters } from "./geo";
import type { LatLng } from "./order-machine";
import { polylineLengthM, round5, simplifyPolyline } from "./polyline";

export type RouteSource = "osrm" | "straight";

/** A drivable (or, for the fallback, straight-line) path from pickup to drop-off. */
export type Route = {
  /** Vertices from pickup to drop-off. */
  points: LatLng[];
  distanceM: number;
  /** Estimated driving time, seconds. */
  durationS: number;
  source: RouteSource;
};

export interface RouteProvider {
  /** Rejects when no route can be produced (network error, timeout, no road). Wrap with FallbackRouteProvider to never fail. */
  route(from: LatLng, to: LatLng): Promise<Route>;
}

/** Same assumptions as HaversineEta (30 km/h, 1.3x circuity): a ranking aid, not a measured speed. */
export class StraightLineRouteProvider implements RouteProvider {
  constructor(private readonly opts: { speedKmh?: number; circuity?: number } = {}) {}
  async route(from: LatLng, to: LatLng): Promise<Route> {
    const d = haversineMeters(from, to);
    const speedMs = ((this.opts.speedKmh ?? 30) * 1000) / 3600;
    return { points: [from, to], distanceM: d, durationS: (d * (this.opts.circuity ?? 1.3)) / speedMs, source: "straight" };
  }
}

export const OSRM_DEMO_URL = "https://router.project-osrm.org";

/**
 * OSRM `route` service adapter. Defaults to the PUBLIC DEMO SERVER, which is a free demo with no uptime or
 * performance guarantee and a usage policy (identify yourself, light use, about one request a second at most).
 * Callers are expected to ask once per order and cache the answer, and to use FallbackRouteProvider.
 * https://github.com/Project-OSRM/osrm-backend/blob/master/docs/http.md#route-service
 */
export class OsrmRouteProvider implements RouteProvider {
  constructor(
    private readonly opts: {
      /** Identifies this app to the server operator, as the usage policy asks. */
      userAgent: string;
      baseUrl?: string;
      profile?: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {}

  async route(from: LatLng, to: LatLng): Promise<Route> {
    const f = this.opts.fetch ?? fetch;
    // OSRM wants {lng},{lat}.
    const url = `${this.opts.baseUrl ?? OSRM_DEMO_URL}/route/v1/${this.opts.profile ?? "driving"}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 3000);
    try {
      const res = await f(url, { headers: { "user-agent": this.opts.userAgent, accept: "application/json" }, signal: ctl.signal });
      if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
      return parseOsrmRoute(await res.json());
    } catch (e) {
      if (ctl.signal.aborted) throw new Error(`OSRM timed out after ${this.opts.timeoutMs ?? 3000} ms`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Validates an OSRM route response and converts it to a Route. Throws on anything unexpected. */
export function parseOsrmRoute(body: unknown): Route {
  const b = body as { code?: string; routes?: { distance?: number; duration?: number; geometry?: { type?: string; coordinates?: unknown } }[] };
  const r = b?.routes?.[0];
  if (b?.code !== "Ok" || !r) throw new Error(`OSRM returned ${b?.code ?? "no code"}`);
  const coords = r.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) throw new Error("OSRM geometry has fewer than 2 points");
  const points = coords.map((c) => {
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) throw new Error("OSRM geometry has a bad coordinate");
    return { lat: c[1] as number, lng: c[0] as number };
  });
  if (!Number.isFinite(r.duration) || !Number.isFinite(r.distance) || r.duration! <= 0) throw new Error("OSRM route has no usable duration");
  return { points, distanceM: r.distance!, durationS: r.duration!, source: "osrm" };
}

/** Try the primary provider; on any failure use the fallback (the straight-line mover) and say so via `onFallback`. */
export class FallbackRouteProvider implements RouteProvider {
  constructor(
    private readonly primary: RouteProvider,
    private readonly fallback: RouteProvider = new StraightLineRouteProvider(),
    private readonly onFallback?: (reason: string) => void,
  ) {}
  async route(from: LatLng, to: LatLng): Promise<Route> {
    try {
      return await this.primary.route(from, to);
    } catch (e) {
      this.onFallback?.(e instanceof Error ? e.message : String(e));
      return this.fallback.route(from, to);
    }
  }
}

/** Shrink a route before it is stored and sent to browsers: drop vertices within 3 m of the line, round to about 1 m. */
export function compactRoute(r: Route, toleranceM = 3): Route {
  const points = simplifyPolyline(r.points, toleranceM).map((p) => ({ lat: round5(p.lat), lng: round5(p.lng) }));
  return { ...r, points, distanceM: Math.round(polylineLengthM(points)) };
}
