import { describe, expect, it } from "vitest";
import { HaversineEta, OpenRouteServiceEta, type EtaProvider } from "./eta";
import { haversineMeters, stepToward } from "./geo";
import { rankDrivers } from "./matching";
import { TrackHub, TrackRoom, type TrackMessage, type TrackPoint } from "./tracking";

const station = { lat: -33.98, lng: 18.47 };

describe("geo", () => {
  it("haversine: Cape Town CBD to Bellville is about 17 km", () => {
    const d = haversineMeters({ lat: -33.9187, lng: 18.4318 }, { lat: -33.9, lng: 18.6296 });
    expect(d).toBeGreaterThan(16_000);
    expect(d).toBeLessThan(19_000);
  });
  it("stepToward never overshoots", () => {
    const a = { lat: -33.9, lng: 18.4 };
    const b = { lat: -33.9, lng: 18.401 };
    expect(stepToward(a, b, 1e6)).toEqual(b);
    expect(haversineMeters(a, stepToward(a, b, 30))).toBeCloseTo(30, 0);
  });
});

describe("rankDrivers", () => {
  const eta = new HaversineEta();
  const drivers = [
    { id: "b", lat: -33.9, lng: 18.47 },
    { id: "a", lat: -33.97, lng: 18.47 },
    { id: "c", lat: -33.5, lng: 18.47 },
  ];
  it("orders by ETA, nearest first", async () => {
    const r = await rankDrivers({ candidates: drivers, pickup: station, eta });
    expect(r.map((x) => x.driverId)).toEqual(["a", "b"]); // c is over 30 minutes away
  });
  it("returns nothing when there are no drivers, or all are excluded, or all are too far", async () => {
    expect(await rankDrivers({ candidates: [], pickup: station, eta })).toEqual([]);
    expect(await rankDrivers({ candidates: drivers, pickup: station, eta, exclude: ["a", "b", "c"] })).toEqual([]);
    expect(await rankDrivers({ candidates: drivers, pickup: station, eta, maxEtaSeconds: 10 })).toEqual([]);
  });
  it("ranks by the provider's ETA, not by straight-line distance", async () => {
    // Provider says the nearer driver is stuck behind a river.
    const slowNear: EtaProvider = { etaSeconds: async (os) => os.map((o) => (o.lat === -33.97 ? 3000 : 200)) };
    const r = await rankDrivers({ candidates: drivers.slice(0, 2), pickup: station, eta: slowNear });
    expect(r[0]!.driverId).toBe("b");
  });
  it("only sends the nearest N to the ETA provider, and skips unroutable drivers", async () => {
    let asked = 0;
    const spy: EtaProvider = { etaSeconds: async (os) => ((asked = os.length), os.map((_, i) => (i === 0 ? null : 100 + i))) };
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `d${String(i).padStart(2, "0")}`, lat: -33.98 + i * 0.001, lng: 18.47 }));
    const r = await rankDrivers({ candidates: many, pickup: station, eta: spy, shortlist: 5 });
    expect(asked).toBe(5);
    expect(r.map((x) => x.driverId)).toEqual(["d01", "d02", "d03", "d04"]); // d00 was null
  });
  it("breaks ETA ties by driver id so results are deterministic", async () => {
    const same = [{ id: "z", lat: -33.97, lng: 18.47 }, { id: "y", lat: -33.97, lng: 18.47 }];
    expect((await rankDrivers({ candidates: same, pickup: station, eta })).map((x) => x.driverId)).toEqual(["y", "z"]);
  });
});

describe("OpenRouteServiceEta (adapter, not enabled)", () => {
  it("sends [lng,lat] with the key and reads durations", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ durations: [[120], [null]] }));
    }) as unknown as typeof fetch;
    const ors = new OpenRouteServiceEta({ apiKey: "KEY", fetch: fake });
    const r = await ors.etaSeconds([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }], { lat: 5, lng: 6 });
    expect(r).toEqual([120, null]);
    expect(calls[0]!.url).toBe("https://api.openrouteservice.org/v2/matrix/driving-car");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("KEY");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ locations: [[2, 1], [4, 3], [6, 5]], sources: [0, 1], destinations: [2] });
  });
  it("throws on a non-2xx response", async () => {
    const ors = new OpenRouteServiceEta({ apiKey: "K", fetch: (async () => new Response("no", { status: 403 })) as unknown as typeof fetch });
    await expect(ors.etaSeconds([{ lat: 1, lng: 2 }], { lat: 5, lng: 6 })).rejects.toThrow(/403/);
  });
});

describe("TrackRoom", () => {
  const pt = (t: number, lat = -33.9): TrackPoint => ({ orderId: "o", driverId: "d", lat, lng: 18.4, t });
  it("broadcasts every ping but persists one per downsample window", () => {
    const persisted: number[] = [];
    const room = new TrackRoom({ persist: (p) => void persisted.push(p.t) });
    const got: TrackMessage[] = [];
    room.subscribe((m) => got.push(m));
    for (let s = 0; s <= 90; s += 5) room.ingest(pt(s * 1000));
    expect(got.filter((m) => m.type === "position")).toHaveLength(19);
    expect(persisted).toEqual([0, 30_000, 60_000, 90_000]);
  });
  it("sends late joiners a snapshot with the last position and status", () => {
    const room = new TrackRoom();
    room.ingest(pt(1000));
    room.setStatus("en_route");
    let first: TrackMessage | undefined;
    room.subscribe((m) => (first ??= m));
    expect(first).toMatchObject({ type: "snapshot", status: "en_route", last: { t: 1000 } });
  });
  it("drops out-of-order pings, survives a throwing subscriber, and unsubscribes", () => {
    const room = new TrackRoom();
    const seen: number[] = [];
    room.subscribe((m) => {
      if (m.type === "position") throw new Error("dead socket");
    });
    const off = room.subscribe((m) => m.type === "position" && seen.push(m.point.t));
    expect(room.ingest(pt(2000))).toBe(true);
    expect(room.ingest(pt(1000))).toBe(false);
    expect(seen).toEqual([2000]);
    expect(room.subscriberCount).toBe(1); // throwing subscriber was dropped
    off();
    expect(room.subscriberCount).toBe(0);
  });
  it("a failing persist hook never blocks live delivery", async () => {
    const room = new TrackRoom({ persist: () => Promise.reject(new Error("db down")) });
    const seen: number[] = [];
    room.subscribe((m) => m.type === "position" && seen.push(m.point.t));
    room.ingest(pt(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([1]);
  });
  it("hub returns one room per order and forgets closed ones", () => {
    const hub = new TrackHub();
    expect(hub.room("a")).toBe(hub.room("a"));
    hub.close("a");
    expect(hub.size).toBe(0);
  });
});
