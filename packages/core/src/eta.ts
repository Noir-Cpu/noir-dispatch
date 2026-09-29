import { haversineMeters } from "./geo";
import type { LatLng } from "./order-machine";

/** Seconds of travel from each origin to `destination`; null when unroutable. */
export interface EtaProvider {
  etaSeconds(origins: LatLng[], destination: LatLng): Promise<(number | null)[]>;
}

/**
 * Default provider: straight-line distance, inflated by a circuity factor, at a constant urban speed.
 * Both numbers are assumptions (not measured against Cape Town traffic); they only need to rank drivers sensibly.
 */
export class HaversineEta implements EtaProvider {
  constructor(private readonly opts: { speedKmh?: number; circuity?: number } = {}) {}
  async etaSeconds(origins: LatLng[], destination: LatLng) {
    const speedMs = ((this.opts.speedKmh ?? 30) * 1000) / 3600;
    const circuity = this.opts.circuity ?? 1.3;
    return origins.map((o) => (haversineMeters(o, destination) * circuity) / speedMs);
  }
}

/**
 * OpenRouteService matrix adapter. NOT ENABLED: it needs an API key (free tier, rate limited) and
 * nothing in the default wiring constructs it. Pass `fetch` to test without the network.
 * https://openrouteservice.org/dev/#/api-docs/v2/matrix/{profile}/post
 */
export class OpenRouteServiceEta implements EtaProvider {
  constructor(
    private readonly opts: { apiKey: string; baseUrl?: string; profile?: string; fetch?: typeof fetch },
  ) {}

  async etaSeconds(origins: LatLng[], destination: LatLng) {
    if (origins.length === 0) return [];
    const f = this.opts.fetch ?? fetch;
    const url = `${this.opts.baseUrl ?? "https://api.openrouteservice.org"}/v2/matrix/${this.opts.profile ?? "driving-car"}`;
    const res = await f(url, {
      method: "POST",
      headers: { authorization: this.opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        // ORS wants [lng, lat]. Destination is the last location.
        locations: [...origins.map((o) => [o.lng, o.lat]), [destination.lng, destination.lat]],
        sources: origins.map((_, i) => i),
        destinations: [origins.length],
        metrics: ["duration"],
      }),
    });
    if (!res.ok) throw new Error(`OpenRouteService ${res.status}`);
    const body = (await res.json()) as { durations: (number | null)[][] };
    return body.durations.map((row) => row[0] ?? null);
  }
}
