import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalEngine, type LocalEngine } from "@noir/engine/local";
import { CAPE_TOWN_STATIONS } from "@noir/engine";
import { createApp, type Env } from "./app";
import { MemoryRateLimiter, isAllowedLogin, parseAllowList } from "./guards";
import { normaliseAuth } from "./otel";

const ENV: Env = { DEV_TOOLS: "1", ORDER_TOKEN_SECRET: "test-order-secret", SIM_TOKEN: "sim-secret-token", OPS_ALLOWED_GITHUB: "Noir-Cpu, friend" };

let k: LocalEngine;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  k = await createLocalEngine();
  app = build();
});
afterEach(() => k.close());

// A stand-in for Better Auth: the header names who is "signed in".
const build = (over: Partial<Parameters<typeof createApp>[0]> = {}) =>
  createApp({
    engine: () => k.engine,
    devPay: (_e, id) => k.payOrder(id),
    opsSession: async (_e, req) => {
      const login = req.headers.get("x-test-ops");
      return login ? { login } : null;
    },
    ...over,
  });

const req = (path: string, init: RequestInit & { env?: Env } = {}) => app.request(path, init, init.env ?? ENV);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  req(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const order = { customerId: "c1", stationId: "st-cbd", fuel: "diesel", litres: 30, dropoff: { lat: -33.93, lng: 18.44, label: "Home" } };
const OPS = { "x-test-ops": "Noir-Cpu" };
const SIM = { "x-sim-token": "sim-secret-token" };

async function placeOrder(key = "k", body = order) {
  const res = await post("/api/orders", body, { "idempotency-key": key });
  const j = (await res.json()) as any;
  return { res, o: j.order, token: j.orderToken as string };
}

describe("orders API", () => {
  it("reports health without a database", async () => {
    const bare = createApp({ engine: () => null });
    expect((await bare.request("/api/health")).status).toBe(200);
    expect((await bare.request("/api/stations")).status).toBe(503);
  });

  it("places an order idempotently and returns an order token, stations, and per-actor actions", async () => {
    const { res, o, token } = await placeOrder("abc");
    expect(res.status).toBe(201);
    expect(o).toMatchObject({ state: "placed", totalCents: 30 * 2350, payment: { status: "requires_payment" } });
    expect(token).toHaveLength(32);
    expect(o.actions.customer).toContain("order_cancelled");
    expect(o.actions.driver).toEqual([]);
    const again = await post("/api/orders", order, { "idempotency-key": "abc" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).order.id).toBe(o.id);
    expect(((await (await req("/api/stations")).json()) as any).stations).toHaveLength(CAPE_TOWN_STATIONS.length);
  });

  it("requires an idempotency key and validates the body", async () => {
    expect((await post("/api/orders", order)).status).toBe(400);
    expect((await post("/api/orders", { ...order, litres: -1 }, { "idempotency-key": "x" })).status).toBe(400);
    expect((await post("/api/orders", { ...order, stationId: "nope" }, { "idempotency-key": "x" })).status).toBe(404);
  });

  it("404s an unknown order and asks for a websocket on /track", async () => {
    expect((await req("/api/orders/nope")).status).toBe(404);
    expect((await req("/api/orders/nope/track")).status).toBe(426);
  });
});

describe("role boundary", () => {
  it("a customer can cancel their own order with its token", async () => {
    const { o, token } = await placeOrder();
    const res = await post(`/api/orders/${o.id}/events`, { actor: "customer", type: "order_cancelled" }, { "x-order-token": token });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).order).toMatchObject({ state: "cancelled", payment: { status: "canceled" } });
  });

  it("a customer cannot cancel or modify someone else's order (no token, or another order's token)", async () => {
    const mine = await placeOrder("a");
    const theirs = await placeOrder("b", { ...order, customerId: "c2" });
    for (const headers of [{}, { "x-order-token": mine.token }, { "x-order-token": "0".repeat(32) }] as Record<string, string>[]) {
      const cancel = await post(`/api/orders/${theirs.o.id}/events`, { actor: "customer", type: "order_cancelled" }, headers);
      expect(cancel.status).toBe(403);
      const modify = await post(`/api/orders/${theirs.o.id}/events`, { actor: "customer", type: "order_modified", data: { note: "x" } }, headers);
      expect(modify.status).toBe(403);
    }
    expect(((await (await req(`/api/orders/${theirs.o.id}`)).json()) as any).order.state).toBe("placed");
  });

  it("claiming a customer id does not help: the token is what proves ownership", async () => {
    const theirs = await placeOrder("b", { ...order, customerId: "victim" });
    const res = await post(`/api/orders/${theirs.o.id}/events`, { actor: "customer", actorId: "victim", type: "order_cancelled" });
    expect(res.status).toBe(403);
  });

  it("anonymous callers cannot act as station or system", async () => {
    const { o, token } = await placeOrder();
    expect((await post(`/api/orders/${o.id}/events`, { actor: "station", type: "station_accepted" }, { "x-order-token": token })).status).toBe(403);
    expect((await post(`/api/orders/${o.id}/events`, { actor: "system", type: "order_cancelled" }, OPS)).status).toBe(400);
    expect((await post(`/api/orders/${o.id}/events`, { actor: "station", type: "driver_assigned" }, OPS)).status).toBe(400);
  });

  it("ops can act as station", async () => {
    const { o } = await placeOrder();
    expect((await post(`/api/orders/${o.id}/events`, { actor: "station", type: "station_accepted" }, OPS)).status).toBe(200);
  });

  it("a driver cannot call ops endpoints, and neither can a customer or the simulator", async () => {
    const { token } = await placeOrder();
    const asDriver = { "x-order-token": token, "content-type": "application/json" };
    for (const [method, path] of [["GET", "/api/orders"], ["GET", "/api/drivers"], ["POST", "/api/dispatch/tick"], ["POST", "/api/ops/retention"]] as const) {
      expect((await req(path, { method, headers: asDriver })).status, `${method} ${path}`).toBe(401);
      expect((await req(path, { method, headers: SIM })).status, `sim ${method} ${path}`).toBe(401);
    }
    expect((await req("/api/orders", { headers: { "x-test-ops": "stranger" } })).status).toBe(401); // signed in but not allow-listed
    expect((await req("/api/orders", { headers: OPS })).status).toBe(200);
    expect((await req("/api/orders", { headers: { "x-test-ops": "FRIEND" } })).status).toBe(200); // case-insensitive allow-list
  });

  it("a driver id alone cannot act on an order it does not hold", async () => {
    const { o } = await placeOrder();
    await post(`/api/orders/${o.id}/events`, { actor: "station", type: "station_accepted" }, OPS);
    await k.store.upsertDriver({ id: "anon-drv", name: "A", status: "available", lat: -33.9, lng: 18.4, locationAt: k.clock.now });
    const res = await post(`/api/orders/${o.id}/events`, { actor: "driver", actorId: "anon-drv", type: "driver_departed" });
    expect(res.status).toBe(409); // order is accepted, not assigned to anyone
    expect((await post("/api/drivers/anon-drv/location", { lat: -33.9, lng: 18.4, orderId: o.id })).status).toBe(403);
  });

  it("simulated drivers can only be driven by the simulator (or ops)", async () => {
    await post("/api/sim/drivers", { id: "sim-drv-01", name: "Sim 1", lat: -33.95, lng: 18.47 }, SIM);
    expect((await post("/api/drivers/sim-drv-01/location", { lat: -33.9, lng: 18.4 })).status).toBe(403);
    expect((await post("/api/drivers/sim-drv-01/offline", {})).status).toBe(403);
    expect((await post("/api/drivers/sim-drv-01/location", { lat: -33.9, lng: 18.4 }, SIM)).status).toBe(204);
  });

  it("the simulator token cannot touch real customers' orders, or real drivers", async () => {
    const { o } = await placeOrder();
    expect((await post(`/api/orders/${o.id}/events`, { actor: "customer", type: "order_cancelled" }, SIM)).status).toBe(403);
    expect((await post(`/api/orders/${o.id}/events`, { actor: "station", type: "order_cancelled" }, SIM)).status).toBe(403);
    expect((await post(`/api/orders/${o.id}/events`, { actor: "station", type: "station_accepted" }, SIM)).status).toBe(200); // the one exception: play station staff
    await k.store.upsertDriver({ id: "real-drv", name: "R", status: "available", lat: -33.9, lng: 18.4, locationAt: k.clock.now });
    expect((await post("/api/drivers/real-drv/location", { lat: -33.9, lng: 18.4 }, SIM)).status).toBe(403);
    expect((await post("/api/sim/pay/" + o.id, {}, SIM)).status).toBe(403); // not a simulated order
    expect((await post("/api/sim/drivers", { id: "sim-drv-02", name: "x", lat: 0, lng: 0 })).status).toBe(403); // no token
    expect((await post("/api/sim/orders", { ...order, customerId: "c1" }, { ...SIM, "idempotency-key": "z" })).status).toBe(400); // must be sim-cust-*
  });

  it("the simulator flow: place, pay, drive, and see only simulated data", async () => {
    await post("/api/sim/drivers", { id: "sim-drv-01", name: "Sim 1", lat: -33.975, lng: 18.47 }, SIM);
    const placed = await post("/api/sim/orders", { ...order, customerId: "sim-cust-1", stationId: "st-claremont" }, { ...SIM, "idempotency-key": "s1" });
    const { id } = (await placed.json()) as { id: string };
    await post(`/api/orders/${id}/events`, { actor: "station", type: "station_accepted" }, SIM);
    expect(await (await post(`/api/sim/pay/${id}`, {}, SIM)).json()).toEqual({ status: "processed" });
    const state = (await (await req("/api/sim/state", { headers: SIM })).json()) as any;
    expect(state.orders[0]).toMatchObject({ id, isSimulated: true, state: "assigned", driverId: "sim-drv-01" });
    expect(state.drivers.map((d: any) => d.id)).toEqual(["sim-drv-01"]);
    expect((await req("/api/sim/state")).status).toBe(403);
  });
});

describe("rate limiting", () => {
  it("limits role-declaring requests per client, and the limit does not leak across clients", async () => {
    const rl = new MemoryRateLimiter(3, 60_000);
    const limited = build({ rateLimiter: () => rl });
    const hit = (ip: string) =>
      limited.request("/api/orders", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "q" + Math.random(), "cf-connecting-ip": ip }, body: JSON.stringify(order) }, ENV);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await hit("1.1.1.1")).status);
    expect(codes).toEqual([201, 201, 201, 429, 429]);
    expect((await hit("2.2.2.2")).status).toBe(201);
  });

  it("the window resets", async () => {
    let t = 0;
    const rl = new MemoryRateLimiter(2, 1000, () => t);
    expect([await rl.allow("a"), await rl.allow("a"), await rl.allow("a")]).toEqual([true, true, false]);
    t = 1001;
    expect(await rl.allow("a")).toBe(true);
  });
});

describe("payments switch", () => {
  it("dev pay works with the fake provider and the order token, and not without either", async () => {
    const { o, token } = await placeOrder();
    expect((await post(`/api/dev/pay/${o.id}`, {})).status).toBe(403);
    expect((await post(`/api/dev/pay/${o.id}`, {}, { "x-order-token": token })).status).toBe(200);
    expect((await post(`/api/dev/pay/${o.id}`, {}, { "x-order-token": token }, )).status).toBe(200); // replay is harmless
    const off = await app.request(`/api/dev/pay/${o.id}`, { method: "POST", headers: { "x-order-token": token } }, { ...ENV, DEV_TOOLS: "0" });
    expect(off.status).toBe(404);
  });

  it("DEV_TOOLS can never enable the pay endpoint for a real provider", async () => {
    const { o, token } = await placeOrder();
    const real = Object.create(k.engine, { paymentProvider: { get: () => "paystack" } });
    const guarded = build({ engine: () => real });
    const res = await guarded.request(`/api/dev/pay/${o.id}`, { method: "POST", headers: { "x-order-token": token } }, ENV);
    expect(res.status).toBe(404);
    const sim = await guarded.request(`/api/sim/pay/${o.id}`, { method: "POST", headers: SIM }, ENV);
    expect(sim.status).toBe(403);
  });

  it("rejects webhooks with bad signatures at the HTTP layer", async () => {
    const res = await req("/api/payments/webhook", { method: "POST", body: "{}", headers: { "x-test-signature": "t=1,v1=00" } });
    expect(res.status).toBe(400);
  });
});

describe("guards", () => {
  it("allow-list defaults to Noir-Cpu and matches case-insensitively", () => {
    expect(parseAllowList(undefined)).toEqual(["noir-cpu"]);
    expect(parseAllowList("")).toEqual(["noir-cpu"]);
    expect(isAllowedLogin("NOIR-CPU", undefined)).toBe(true);
    expect(isAllowedLogin("someone", undefined)).toBe(false);
    expect(isAllowedLogin(undefined, undefined)).toBe(false);
  });
  it.each([
    ["Basic abc", "Basic abc"],
    ["abc", "Basic abc"],
  ])("tracing header %j -> %s", (raw, want) => expect(normaliseAuth(raw)).toBe(want));
});
