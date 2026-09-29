import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalEngine, type LocalEngine } from "@noir/engine/local";
import { createApp } from "./app";
import { normaliseAuth } from "./otel";

let k: LocalEngine;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  k = await createLocalEngine();
  app = createApp({ engine: () => k.engine, devPay: (_e, id) => k.payOrder(id) });
});
afterEach(() => k.close());

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const order = {
  customerId: "c1",
  stationId: "st-cbd",
  fuel: "diesel",
  litres: 30,
  dropoff: { lat: -33.93, lng: 18.44, label: "Home" },
};

describe("api", () => {
  it("reports health without a database", async () => {
    const bare = createApp({ engine: () => null });
    expect((await bare.request("/api/health")).status).toBe(200);
    expect((await bare.request("/api/stations")).status).toBe(503);
  });

  it("places an order (idempotently), lists stations, exposes per-actor actions", async () => {
    const res = await app.request("/api/orders", json(order, { "idempotency-key": "abc" }), { DEV_TOOLS: "1" });
    expect(res.status).toBe(201);
    const { order: o, clientSecret } = (await res.json()) as any;
    expect(o).toMatchObject({ state: "placed", totalCents: 30 * 2350, payment: { status: "requires_payment" } });
    expect(clientSecret).toMatch(/^pi_test_/);
    expect(o.actions.customer).toContain("order_cancelled");
    expect(o.actions.station).toContain("station_accepted");
    expect(o.actions.driver).toEqual([]);
    const again = await app.request("/api/orders", json(order, { "idempotency-key": "abc" }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).order.id).toBe(o.id);
    const st = (await (await app.request("/api/stations")).json()) as any;
    expect(st.stations).toHaveLength(5);
  });

  it("requires an idempotency key and validates the body", async () => {
    expect((await app.request("/api/orders", json(order))).status).toBe(400);
    expect((await app.request("/api/orders", json({ ...order, litres: -1 }, { "idempotency-key": "x" }))).status).toBe(400);
    expect((await app.request("/api/orders", json({ ...order, stationId: "nope" }, { "idempotency-key": "x" }))).status).toBe(404);
  });

  it("maps state-machine rejections to HTTP status and never lets callers act as the system", async () => {
    const { order: o } = (await (await app.request("/api/orders", json(order, { "idempotency-key": "k" }))).json()) as any;
    const ev = (body: unknown) => app.request(`/api/orders/${o.id}/events`, json(body));
    expect((await ev({ actor: "customer", type: "station_accepted" })).status).toBe(403);
    expect((await ev({ actor: "driver", actorId: "d1", type: "driver_departed" })).status).toBe(409);
    expect((await ev({ actor: "system", type: "order_cancelled" })).status).toBe(400);
    expect((await ev({ actor: "station", type: "driver_assigned" })).status).toBe(400);
    expect((await ev({ actor: "station", type: "station_accepted" })).status).toBe(200);
    expect((await ev({ actor: "station", type: "station_accepted" })).status).toBe(409);
    const cancel = await ev({ actor: "customer", type: "order_cancelled", data: { reason: "changed mind" } });
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as any).order).toMatchObject({ state: "cancelled", payment: { status: "canceled" } });
    expect((await ev({ actor: "customer", type: "order_cancelled" })).status).toBe(409);
  });

  it("dev pay goes through the signed webhook and is off unless DEV_TOOLS=1", async () => {
    const { order: o } = (await (await app.request("/api/orders", json(order, { "idempotency-key": "k" }))).json()) as any;
    expect((await app.request(`/api/dev/pay/${o.id}`, { method: "POST" })).status).toBe(404);
    const res = await app.request(`/api/dev/pay/${o.id}`, { method: "POST" }, { DEV_TOOLS: "1" });
    expect(await res.json()).toEqual({ status: "processed" });
  });

  it("rejects webhooks with bad signatures at the HTTP layer", async () => {
    const res = await app.request("/api/payments/webhook", { method: "POST", body: "{}", headers: { "x-test-signature": "t=1,v1=00" } });
    expect(res.status).toBe(400);
  });

  it("rejects driver location for an order the driver does not hold", async () => {
    const { order: o } = (await (await app.request("/api/orders", json(order, { "idempotency-key": "k" }))).json()) as any;
    const res = await app.request("/api/drivers/d9/location", json({ lat: -33.9, lng: 18.4, orderId: o.id }));
    expect(res.status).toBe(403);
  });

  it("404s an unknown order and asks for a websocket on /track", async () => {
    expect((await app.request("/api/orders/nope")).status).toBe(404);
    expect((await app.request("/api/orders/nope/track")).status).toBe(426);
  });
});

describe("tracing helpers", () => {
  it.each([
    ["Basic abc", "Basic abc"],
    ["abc", "Basic abc"],
  ])("%j -> %s", (raw, want) => expect(normaliseAuth(raw)).toBe(want));
});
