import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_DRIVER_PREFIX, StraightLineRouteProvider, destinationPoint, type Route, type RouteProvider } from "@noir/core";
import { createLocalEngine, type LocalEngine } from "@noir/engine/local";
import { SIM_STATIONS } from "@noir/engine";
import { createApp, type Env } from "./app";
import { MemoryRateLimiter } from "./guards";
import { parseRadiusKm } from "./config";

const ENV: Env = { DEV_TOOLS: "1", ORDER_TOKEN_SECRET: "test-order-secret", SIM_TOKEN: "sim-secret-token", OPS_ALLOWED_GITHUB: "Noir-Cpu" };
const STATION = SIM_STATIONS.find((s) => s.id === "st-claremont")!;
const DROP = destinationPoint(STATION, 20, 5_000);

let k: LocalEngine;
let routeCalls = 0;
const routes: RouteProvider = {
  async route(from, to): Promise<Route> {
    routeCalls++;
    const mid = destinationPoint(from, 0, 2_000);
    return { points: [from, mid, to], distanceM: 0, durationS: 600, source: "osrm" };
  },
};
beforeEach(async () => {
  k = await createLocalEngine();
  routeCalls = 0;
});
afterEach(async () => {
  await k.close();
});

const build = (over: Partial<Parameters<typeof createApp>[0]> = {}) =>
  createApp({ engine: () => k.engine, devPay: (_e, id) => k.payOrder(id), routes: () => routes, ...over });
const call = (app: ReturnType<typeof createApp>, path: string, init: RequestInit & { env?: Env } = {}) => app.request(path, init, init.env ?? ENV);

async function placePaid(app: ReturnType<typeof createApp>, key = "k") {
  const res = await call(app, "/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ customerId: "visitor", stationId: STATION.id, fuel: "diesel", litres: 30, dropoff: { ...DROP, label: "Newlands, Main Road" } }),
  });
  const j = (await res.json()) as { order: { id: string }; orderToken: string };
  await call(app, `/api/dev/pay/${j.order.id}`, { method: "POST", headers: { "x-order-token": j.orderToken } });
  return { id: j.order.id, token: j.orderToken };
}
const step = (app: ReturnType<typeof createApp>, id: string, token?: string, headers: Record<string, string> = {}, env?: Env) =>
  call(app, `/api/orders/${id}/demo/step`, { method: "POST", headers: { ...(token ? { "x-order-token": token } : {}), ...headers }, env });

describe("POST /orders/:id/demo/step", () => {
  it("takes a paid order to delivered with nothing but step calls", async () => {
    const app = build();
    const { id, token } = await placePaid(app);
    let body: any;
    for (let i = 0; i < 300; i++) {
      k.clock.now += 2_500;
      const res = await step(app, id, token);
      expect(res.status).toBe(200);
      body = await res.json();
      if (body.done) break;
    }
    expect(body).toMatchObject({ state: "completed", done: true, speed: 10, routeSource: "osrm" });
    expect(routeCalls).toBe(1);
    const order = (await (await call(app, `/api/orders/${id}`)).json()) as any;
    expect(order.order.state).toBe("completed");
    expect(order.order.events.map((e: any) => e.type)).toContain("delivery_completed");
    expect(order.order.driverId.startsWith(DEMO_DRIVER_PREFIX)).toBe(true);
  });

  it("serves the cached route to the browser, once the demo has looked it up", async () => {
    const app = build();
    const { id, token } = await placePaid(app);
    expect(((await (await call(app, `/api/orders/${id}/route`)).json()) as any).route).toBeNull();
    k.clock.now += 2_500;
    await step(app, id, token);
    const r = (await (await call(app, `/api/orders/${id}/route`)).json()) as any;
    expect(r.route.source).toBe("osrm");
    expect(r.route.points[0]).toEqual([STATION.lat, STATION.lng].map((n) => Math.round(n * 1e5) / 1e5));
    expect(r.demo.speed).toBe(10);
  });

  it("uses the straight line when no routing is configured (no network call)", async () => {
    const app = build({ routes: undefined });
    const { id, token } = await placePaid(app);
    k.clock.now += 2_500;
    expect(((await (await step(app, id, token)).json()) as any).routeSource).toBe("straight");
  });

  it("403: no token, someone else's token, and the simulator token", async () => {
    const app = build();
    const mine = await placePaid(app, "a");
    const theirs = await placePaid(app, "b");
    expect((await step(app, mine.id)).status).toBe(403);
    expect((await step(app, mine.id, theirs.token)).status).toBe(403);
    expect((await step(app, mine.id, "0".repeat(32))).status).toBe(403);
    expect((await step(app, mine.id, undefined, { "x-sim-token": "sim-secret-token" })).status).toBe(403);
    expect((await k.engine.detail(mine.id))!.view.state).toBe("placed"); // nothing moved
  });

  it("404 when DEV_TOOLS is off or unset, whatever the token", async () => {
    const app = build();
    const { id, token } = await placePaid(app);
    expect((await step(app, id, token, {}, { ...ENV, DEV_TOOLS: "0" })).status).toBe(404);
    expect((await step(app, id, token, {}, { ...ENV, DEV_TOOLS: undefined })).status).toBe(404);
    expect((await step(app, "nope", token)).status).toBe(404);
  });

  it("404 for a real payment provider, even with DEV_TOOLS=1 and a valid token", async () => {
    const app = build();
    const { id, token } = await placePaid(app);
    const real = Object.create(k.engine, { paymentProvider: { get: () => "paystack" } });
    const guarded = build({ engine: () => real });
    expect((await step(guarded, id, token)).status).toBe(404);
    expect(((await (await call(guarded, "/api/config")).json()) as any).demo.available).toBe(false);
    expect((await k.engine.detail(id))!.view.state).toBe("placed");
  });

  it("409 before payment", async () => {
    const app = build();
    const res = await call(app, "/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "u" },
      body: JSON.stringify({ customerId: "v2", stationId: STATION.id, fuel: "diesel", litres: 5, dropoff: { ...DROP, label: "x" } }),
    });
    const j = (await res.json()) as any;
    expect((await step(app, j.order.id, j.orderToken)).status).toBe(409);
  });

  it("429 when one IP steps too often, and when one order is stepped too often from different IPs", async () => {
    const rl = new MemoryRateLimiter(4, 60_000);
    const app = build({ rateLimiter: () => rl });
    const a = await placePaid(app, "a");
    const b = await placePaid(app, "b");
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      k.clock.now += 2_500;
      codes.push((await step(app, a.id, a.token, { "cf-connecting-ip": "1.1.1.1" })).status);
    }
    expect(codes).toEqual([200, 200, 200, 200, 429, 429]);
    // Per IP: the same IP on another order is limited too (its own budget is the IP's).
    expect((await step(app, b.id, b.token, { "cf-connecting-ip": "1.1.1.1" })).status).toBe(429);
    // Per order: another IP on the exhausted order is limited; another IP on a fresh order is fine.
    expect((await step(app, a.id, a.token, { "cf-connecting-ip": "2.2.2.2" })).status).toBe(429);
    expect((await step(app, b.id, b.token, { "cf-connecting-ip": "3.3.3.3" })).status).toBe(200);
  });

  it("429 once the global daily cap is used up, and says so", async () => {
    const app = build();
    const { id, token } = await placePaid(app);
    const env = { ...ENV, DEMO_DAILY_STEP_CAP: "3" };
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      k.clock.now += 2_500;
      codes.push((await step(app, id, token, {}, env)).status);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    k.clock.now += 2_500;
    const res = await step(app, id, token, {}, env);
    expect(((await res.json()) as any).error).toBe("daily_cap");
  });

  it("does not let the burst simulator see or drive demo orders' drivers", async () => {
    const app = build();
    const { id, token } = await placePaid(app);
    for (let i = 0; i < 8; i++) {
      k.clock.now += 2_500;
      await step(app, id, token);
    }
    const state = (await (await call(app, "/api/sim/state", { headers: { "x-sim-token": "sim-secret-token" } })).json()) as any;
    expect(state.drivers).toEqual([]);
    expect(state.orders.map((o: any) => o.id)).not.toContain(id);
  });
});

describe("GET /config and the delivery radius over HTTP", () => {
  it("reports the radius and whether the demo is on", async () => {
    const app = build();
    expect(((await (await call(app, "/api/config")).json()) as any)).toEqual({ deliveryRadiusKm: 12, demo: { available: true, speed: 10 } });
    expect(((await (await call(app, "/api/config", { env: { ...ENV, DEV_TOOLS: "0" } })).json()) as any).demo.available).toBe(false);
  });

  it("rejects an order outside the radius with a 422 that names the radius and a better station", async () => {
    const app = build();
    const stellenbosch = { lat: -33.9346, lng: 18.8602, label: "Stellenbosch, Dorp Street" };
    const res = await call(app, "/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "far" },
      body: JSON.stringify({ customerId: "v", stationId: "st-claremont", fuel: "diesel", litres: 10, dropoff: stellenbosch }),
    });
    expect(res.status).toBe(422);
    const j = (await res.json()) as any;
    expect(j.error).toBe("out_of_radius");
    expect(j.message).toMatch(/outside our 12 km delivery radius/);
    expect(j.message).toMatch(/Eikestad Fuel Depot/);
    expect(j.radiusKm).toBe(12);
    expect(j.nearestInRange.id).toBe("st-stellenbosch");
    expect(await k.store.listOrders()).toHaveLength(0);
    // The same pin is fine with the station that is actually near it.
    const ok = await call(app, "/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "near" },
      body: JSON.stringify({ customerId: "v", stationId: "st-stellenbosch", fuel: "diesel", litres: 10, dropoff: stellenbosch }),
    });
    expect(ok.status).toBe(201);
  });

  it("a configured radius changes the answer, and the simulator endpoint obeys it too", async () => {
    k = (await k.close(), await createLocalEngine({ config: { deliveryRadiusKm: 2 } }));
    const app = build();
    expect(((await (await call(app, "/api/config")).json()) as any).deliveryRadiusKm).toBe(2);
    const body = { customerId: "sim-cust-1", stationId: "st-claremont", fuel: "diesel", litres: 10, dropoff: { ...destinationPoint(STATION, 0, 3_000), label: "x" } };
    const res = await call(app, "/api/sim/orders", { method: "POST", headers: { "content-type": "application/json", "x-sim-token": "sim-secret-token", "idempotency-key": "z" }, body: JSON.stringify(body) });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).message).toContain("2 km");
  });

  it("parseRadiusKm reads the wrangler var and falls back to 12 for anything unusable", () => {
    expect(parseRadiusKm("12")).toBe(12);
    expect(parseRadiusKm("7.5")).toBe(7.5);
    for (const bad of [undefined, "", "  ", "abc", "0", "-3", "Infinity", "NaN"]) expect(parseRadiusKm(bad)).toBe(12);
  });
});

describe("routing fallback through the API", () => {
  it("a straight-line provider is accepted as a RouteProvider", async () => {
    const app = build({ routes: () => new StraightLineRouteProvider() });
    const { id, token } = await placePaid(app);
    k.clock.now += 2_500;
    expect(((await (await step(app, id, token)).json()) as any).routeSource).toBe("straight");
  });
});
