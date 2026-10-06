import { describe, expect, it, vi } from "vitest";
import { haversineMeters } from "./geo";
import { FallbackRouteProvider, OsrmRouteProvider, StraightLineRouteProvider, compactRoute, parseOsrmRoute } from "./route";
import { cumulativeM, destinationPoint, pointAtM, polylineLengthM, projectOnPolyline, remainingFrom, simplifyPolyline } from "./polyline";

// Hand-written fixture in the shape OSRM's route service returns (GeoJSON, [lng, lat]). The coordinates are made up to
// look like a short drive; they are not real road geometry and nothing here touches the network.
const OSRM_OK = {
  code: "Ok",
  routes: [
    {
      distance: 2310.4,
      duration: 301.7,
      geometry: {
        type: "LineString",
        coordinates: [
          [18.4661, -33.9825],
          [18.4661, -33.9811],
          [18.4661, -33.98], // collinear with its neighbours: a simplifier should drop it
          [18.4672, -33.9789],
          [18.4688, -33.9789],
          [18.4701, -33.9772],
          [18.4701, -33.9741],
        ],
      },
    },
  ],
};
const FROM = { lat: -33.9825, lng: 18.4661 };
const TO = { lat: -33.9741, lng: 18.4701 };
const ok = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("OsrmRouteProvider", () => {
  it("asks for lng,lat pairs with full geometry, identifies itself, and parses the polyline", async () => {
    let seen: { url: string; ua: string | null } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, ua: new Headers(init.headers).get("user-agent") };
      return new Response(JSON.stringify(OSRM_OK));
    }) as unknown as typeof fetch;
    const r = await new OsrmRouteProvider({ userAgent: "noir-dispatch-test/0 (+https://example.test)", fetch: f }).route(FROM, TO);
    expect(seen!.url).toBe("https://router.project-osrm.org/route/v1/driving/18.4661,-33.9825;18.4701,-33.9741?overview=full&geometries=geojson");
    expect(seen!.ua).toBe("noir-dispatch-test/0 (+https://example.test)");
    expect(r.source).toBe("osrm");
    expect(r.durationS).toBeCloseTo(301.7);
    expect(r.points).toHaveLength(7);
    expect(r.points[0]).toEqual(FROM); // lat and lng the right way round
    expect(r.points.at(-1)).toEqual(TO);
  });

  it("rejects non-OK answers, bad bodies and HTTP errors", async () => {
    const mk = (f: typeof fetch) => new OsrmRouteProvider({ userAgent: "t", fetch: f }).route(FROM, TO);
    await expect(mk(ok({ code: "NoRoute", routes: [] }))).rejects.toThrow(/NoRoute/);
    await expect(mk(ok({ code: "Ok", routes: [{ duration: 5, distance: 5, geometry: { coordinates: [[1, 2]] } }] }))).rejects.toThrow(/fewer than 2/);
    await expect(mk(ok({}, 429))).rejects.toThrow(/429/);
    expect(() => parseOsrmRoute({ code: "Ok", routes: [{ duration: 0, distance: 1, geometry: { coordinates: [[1, 2], [3, 4]] } }] })).toThrow(/duration/);
    expect(() => parseOsrmRoute({ code: "Ok", routes: [{ duration: 5, distance: 1, geometry: { coordinates: [[1, 2], ["x", 4]] } }] })).toThrow(/bad coordinate/);
  });

  it("gives up after the timeout (aborts the request) instead of hanging", async () => {
    const hang = ((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const t0 = Date.now();
    await expect(new OsrmRouteProvider({ userAgent: "t", fetch: hang, timeoutMs: 40 }).route(FROM, TO)).rejects.toThrow(/timed out after 40 ms/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("uses a 3 second timeout by default", async () => {
    // Fake timers: advance 2.9 s (still waiting), then past 3 s (aborted), without waiting in real time.
    vi.useFakeTimers();
    try {
      const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("x"))))) as unknown as typeof fetch;
      let state = "pending";
      const p = new OsrmRouteProvider({ userAgent: "t", fetch: hang }).route(FROM, TO).catch((e: Error) => (state = e.message));
      await vi.advanceTimersByTimeAsync(2900);
      expect(state).toBe("pending");
      await vi.advanceTimersByTimeAsync(200);
      await p;
      expect(state).toMatch(/timed out after 3000 ms/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FallbackRouteProvider", () => {
  it("returns the primary route when it works, and does not call the fallback", async () => {
    let fell = 0;
    const p = new FallbackRouteProvider(new OsrmRouteProvider({ userAgent: "t", fetch: ok(OSRM_OK) }), new StraightLineRouteProvider(), () => fell++);
    expect((await p.route(FROM, TO)).source).toBe("osrm");
    expect(fell).toBe(0);
  });

  it("falls back to the straight-line route on a network error, a timeout and an HTTP error, and records why", async () => {
    const reasons: string[] = [];
    const boom = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const hang = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("x"))))) as unknown as typeof fetch;
    for (const f of [boom, hang, ok({}, 503)]) {
      const p = new FallbackRouteProvider(new OsrmRouteProvider({ userAgent: "t", fetch: f, timeoutMs: 30 }), new StraightLineRouteProvider(), (r) => reasons.push(r));
      const r = await p.route(FROM, TO);
      expect(r.source).toBe("straight");
      expect(r.points).toEqual([FROM, TO]);
      expect(r.distanceM).toBeCloseTo(haversineMeters(FROM, TO), 3);
      // 1.3x circuity at 30 km/h, the same assumption as HaversineEta
      expect(r.durationS).toBeCloseTo((haversineMeters(FROM, TO) * 1.3) / (30 / 3.6), 3);
    }
    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toMatch(/fetch failed/);
    expect(reasons[1]).toMatch(/timed out/);
    expect(reasons[2]).toMatch(/503/);
  });
});

describe("polyline maths", () => {
  const line = parseOsrmRoute(OSRM_OK).points;
  const cum = cumulativeM(line);

  it("interpolates along the line by distance, clamps at the ends, and reports a heading", () => {
    const total = polylineLengthM(line);
    expect(pointAtM(line, 0, cum)).toMatchObject(FROM);
    expect(pointAtM(line, total + 500, cum)).toMatchObject(TO);
    const mid = pointAtM(line, 100, cum);
    expect(haversineMeters(FROM, mid)).toBeCloseTo(100, 0); // first leg is straight
    expect(mid.heading).toBeLessThan(1); // due north, 0 or 360 degrees
  });

  it("projects a point onto the line and measures how far off it is", () => {
    const on = pointAtM(line, 400, cum);
    const p = projectOnPolyline(line, on, cum);
    expect(p.s).toBeCloseTo(400, 0);
    expect(p.offM).toBeLessThan(0.5);
    const beside = destinationPoint(pointAtM(line, 100, cum), 90, 40);
    const q = projectOnPolyline(line, beside, cum);
    expect(q.offM).toBeCloseTo(40, 0);
  });

  it("remainingFrom starts at the point and keeps only later vertices", () => {
    const rest = remainingFrom(line, 400, cum);
    const here = pointAtM(line, 400, cum);
    expect(rest[0]).toEqual({ lat: here.lat, lng: here.lng });
    expect(rest.at(-1)).toEqual(TO);
    expect(polylineLengthM(rest)).toBeCloseTo(polylineLengthM(line) - 400, 0);
  });

  it("simplifies away vertices on the line and keeps the corners", () => {
    const s = simplifyPolyline(line, 3);
    expect(s.length).toBe(6); // the collinear vertex went
    expect(s[0]).toEqual(FROM);
    expect(s.at(-1)).toEqual(TO);
    const c = compactRoute(parseOsrmRoute(OSRM_OK));
    expect(c.points.length).toBeLessThan(7);
    expect(c.durationS).toBeCloseTo(301.7);
  });

  it("destinationPoint is the inverse of the distance", () => {
    for (const bearing of [0, 90, 180, 270, 33]) expect(haversineMeters(FROM, destinationPoint(FROM, bearing, 12_000))).toBeCloseTo(12_000, 2);
  });
});

import { distanceToGo, planGlide } from "./motion";

describe("planGlide (how the marker moves between pings)", () => {
  const line = parseOsrmRoute(OSRM_OK).points;
  const cum = cumulativeM(line);

  it("follows the road between two pings, so it goes round a corner instead of cutting across it", () => {
    const a = pointAtM(line, 150, cum); // before the first corner
    const b = pointAtM(line, 600, cum); // after it
    const g = planGlide(line, a, b);
    expect(g.alongRoute).toBe(true);
    expect(g.at(0)).toMatchObject({ lat: a.lat, lng: a.lng });
    expect(g.at(1).lat).toBeCloseTo(b.lat, 6);
    // The straight chord between a and b is shorter than the road; the midpoint of the glide stays on the road.
    const mid = g.at(0.5);
    expect(projectOnPolyline(line, mid, cum).offM).toBeLessThan(0.5);
    // every frame stays on the road
    for (let f = 0; f <= 1; f += 0.05) expect(projectOnPolyline(line, g.at(f), cum).offM).toBeLessThan(0.5);
  });

  it("reports the heading of the road segment it is on", () => {
    const g = planGlide(line, pointAtM(line, 10, cum), pointAtM(line, 60, cum));
    expect(g.at(0.5).heading).toBeLessThan(1); // north
    const mid = (cum[3]! + cum[4]!) / 2; // the fourth segment runs due east
    const g2 = planGlide(line, pointAtM(line, mid - 10, cum), pointAtM(line, mid + 10, cum));
    expect(g2.at(0.5).heading).toBeCloseTo(90, 0);
  });

  it("glides straight (and does not jump) when there is no route, when the ping is far off the road, or when it goes backwards", () => {
    const a = FROM;
    const b = destinationPoint(FROM, 90, 400);
    for (const route of [null, undefined, line]) {
      const g = planGlide(route, a, b);
      if (route === line) expect(g.alongRoute).toBe(false); // 400 m east of the road: off-route
      expect(g.at(0.5).lng).toBeCloseTo((a.lng + b.lng) / 2, 6);
      expect(g.at(0.5).heading).toBeCloseTo(90, 0);
    }
    const back = planGlide(line, pointAtM(line, 800, cum), pointAtM(line, 300, cum));
    expect(back.alongRoute).toBe(false);
  });

  it("clamps f to 0..1, so a late animation frame cannot overshoot", () => {
    const g = planGlide(line, pointAtM(line, 100, cum), pointAtM(line, 500, cum));
    expect(g.at(7)).toEqual(g.at(1));
    expect(g.at(-3)).toEqual(g.at(0));
  });

  it("distanceToGo counts the road remaining, and falls back to a straight line", () => {
    const total = polylineLengthM(line);
    expect(distanceToGo(line, pointAtM(line, 500, cum), TO)).toBeCloseTo(total - 500, 0);
    expect(distanceToGo(null, FROM, TO)).toBeCloseTo(haversineMeters(FROM, TO), 3);
    expect(distanceToGo(line, destinationPoint(FROM, 90, 5_000), TO)).toBeGreaterThan(4_000); // off-route: straight line
  });
});
