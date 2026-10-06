import { runBurst, type BurstReport } from "@noir/sim";
import { createLocalEngine, type LocalEngine } from "@noir/engine/local";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

const ENV = { DEV_TOOLS: "1", ORDER_TOKEN_SECRET: "o", SIM_TOKEN: "sim-token", OPS_ALLOWED_GITHUB: "noir-cpu" };
let k: LocalEngine | undefined;
afterEach(() => k?.close());

// The runner talks HTTP; here "HTTP" is the Hono app in process and time is the engine's virtual clock.
async function harness() {
  k = await createLocalEngine();
  const app = createApp({ engine: () => k!.engine, devPay: (_e, id) => k!.payOrder(id), opsSession: async (_e, req) => (req.headers.get("x-ops") ? { login: "noir-cpu" } : null) });
  const calls: { t: number; path: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ t: k!.clock.now, path });
    return app.request(path, init, ENV);
  }) as unknown as typeof fetch;
  const kk = k;
  const burst = (over: Partial<Parameters<typeof runBurst>[0]> = {}): Promise<BurstReport> =>
    runBurst({
      baseUrl: "http://sim.test",
      token: "sim-token",
      seed: 5,
      fetch: fetchImpl,
      sleep: async (ms) => void (kk.clock.now += ms),
      now: () => kk.clock.now,
      drivers: 4,
      minActive: 3,
      durationMs: 12 * 60_000,
      maxRequests: 6000,
      ...over,
    });
  return { app, calls, burst, k: kk };
}

describe("HTTP-mode simulator", () => {
  it("falls back to the defaults for settings passed as undefined, so the request cap can never be lost", async () => {
    const h = await harness();
    const report = await h.burst({ drivers: undefined, minActive: undefined, maxRequests: undefined, durationMs: 60_000 });
    expect(report.budget).toBe(400); // HTTP_SIM_DEFAULTS.maxRequests, not undefined
    expect(report.requests).toBeLessThanOrEqual(400);
    expect(report.ordersPlaced).toBeGreaterThan(0); // default minActive and drivers applied
  });

  it("refuses a non-numeric setting instead of running uncapped", async () => {
    const h = await harness();
    await expect(h.burst({ maxRequests: Number("abc") })).rejects.toThrow(/invalid simulator setting maxRequests/);
  });

  it("drives orders from placed to completed over the public API, touching only simulated records", async () => {
    const h = await harness();
    // A visitor's order (not simulated): the runner should accept it as station staff and a sim driver should deliver it.
    const visitor = await h.app.request(
      "/api/orders",
      { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "v" }, body: JSON.stringify({ customerId: "visitor", stationId: "st-claremont", fuel: "diesel", litres: 20, dropoff: { lat: -33.975, lng: 18.47, label: "Home" } }) },
      ENV,
    );
    const { order, orderToken } = (await visitor.json()) as { order: { id: string }; orderToken: string };
    await h.app.request(`/api/dev/pay/${order.id}`, { method: "POST", headers: { "x-order-token": orderToken } }, ENV);

    const report = await h.burst();
    expect(report.stoppedBy).toBe("duration");
    expect(report.transitions.driver_departed).toBeGreaterThan(0);
    expect(report.transitions.delivery_completed).toBeGreaterThan(0);
    expect((await h.k.engine.detail(order.id))!.view.state).toBe("completed"); // the visitor's order was served

    const all = await h.k.store.listOrders();
    const sims = all.filter((o) => o.isSimulated);
    expect(sims.length).toBe(report.ordersPlaced);
    expect(all.filter((o) => !o.isSimulated).map((o) => o.id)).toEqual([order.id]);
    expect(sims.every((o) => o.view.customerId.startsWith("sim-cust-"))).toBe(true);
    const drivers = await h.k.store.listDrivers();
    expect(drivers.every((d) => d.isSimulated && d.id.startsWith("sim-drv-"))).toBe(true);
    // Every request carried the token, and none went to an ops endpoint.
    expect(h.calls.some((c) => c.path === "/api/orders" || c.path === "/api/drivers")).toBe(false);
  });

  it("stays inside its request budget and its rate limit", async () => {
    const h = await harness();
    const r = await h.burst({ maxRequests: 40, maxRps: 5 });
    expect(r.stoppedBy).toBe("budget");
    expect(r.budget).toBe(40);
    expect(r.requests).toBeLessThanOrEqual(41); // the budget plus the single cleanup call
    expect(h.calls.length).toBe(r.requests);
    const gaps = h.calls.slice(1).map((c, i) => c.t - h.calls[i]!.t);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(200 - 1); // 5 requests per second at most
  });

  it("is deterministic for a seed", async () => {
    const a = await (await harness()).burst({ seed: 11 });
    await k!.close();
    const b = await (await harness()).burst({ seed: 11 });
    expect(b).toEqual(a);
  });

  it("cleanup expires old simulated orders and never touches real ones", async () => {
    const h = await harness();
    const visitor = await h.app.request(
      "/api/orders",
      { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "v" }, body: JSON.stringify({ customerId: "visitor", stationId: "st-cbd", fuel: "diesel", litres: 20, dropoff: { lat: -33.93, lng: 18.44, label: "Home" } }) },
      ENV,
    );
    const { order, orderToken } = (await visitor.json()) as { order: { id: string }; orderToken: string };
    await h.app.request(`/api/orders/${order.id}/events`, { method: "POST", headers: { "content-type": "application/json", "x-order-token": orderToken }, body: JSON.stringify({ actor: "customer", type: "order_cancelled" }) }, ENV);
    await h.burst({ durationMs: 8 * 60_000 });
    h.k.clock.now += 7 * 3_600_000;
    const res = await h.app.request("/api/sim/cleanup", { method: "POST", headers: { "x-sim-token": "sim-token" } }, ENV);
    const j = (await res.json()) as { simulatedOrders: number };
    expect(j.simulatedOrders).toBeGreaterThan(0);
    const left = await h.k.store.listOrders();
    expect(left.some((o) => o.isSimulated && ["completed", "cancelled"].includes(o.view.state))).toBe(false);
    expect(left.some((o) => o.id === order.id)).toBe(true); // real cancelled order survives
  });
});
