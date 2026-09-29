import { transition, type OrderEvent, type OrderView, type Payment } from "@noir/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleStore } from "./store";
import { createPgliteDb } from "./pglite";

let store: DrizzleStore;
let close: () => Promise<void>;
beforeEach(async () => {
  const made = await createPgliteDb();
  close = made.close;
  store = new DrizzleStore(made.db);
  await store.upsertCustomer({ id: "c", name: "C" });
  await store.upsertStation({ id: "s", name: "S", lat: -33.9187, lng: 18.4318, rating: 4.4, prices: { diesel: 2350, petrol_95: 2410 } });
  await store.upsertDriver({ id: "d", name: "D", status: "available", lat: -33.92, lng: 18.43, locationAt: null });
});
afterEach(() => close());

const placed: OrderEvent = {
  type: "order_placed",
  actor: "customer",
  at: 1_000,
  data: { customerId: "c", stationId: "s", fuel: "diesel", litres: 10.5, totalCents: 24_675, dropoff: { lat: -33.931234, lng: 18.441234, label: "x" } },
};
const view = () => (transition(null, placed) as { ok: true; view: OrderView }).view;
const payment = (id: string): Payment => ({
  id: `pay_${id}`, orderId: id, provider: "test", intentId: `pi_${id}`, idempotencyKey: `k_${id}`, amountCents: 24_675, currency: "ZAR", status: "requires_payment", refundId: null, refundedCents: 0,
});

describe("DrizzleStore", () => {
  it("round-trips coordinates as numbers to 6 decimal places", async () => {
    const st = await store.getStation("s");
    expect(st).toMatchObject({ lat: -33.9187, lng: 18.4318, rating: 4.4 });
    await store.insertOrder({ id: "o1", idempotencyKey: "a", view: view(), event: placed, payment: payment("o1") });
    expect((await store.getOrder("o1"))!.view).toEqual(view());
  });

  it("insertOrder is idempotent on (customer, key) and creates the first event and payment", async () => {
    const a = await store.insertOrder({ id: "o1", idempotencyKey: "a", view: view(), event: placed, payment: payment("o1") });
    const b = await store.insertOrder({ id: "o2", idempotencyKey: "a", view: view(), event: placed, payment: payment("o2") });
    expect(a).toEqual({ created: true, id: "o1" });
    expect(b).toEqual({ created: false, id: "o1" });
    expect(await store.listEvents("o1")).toHaveLength(1);
    expect(await store.getPaymentByOrder("o2")).toBeNull();
    expect(await store.getOrder("o2")).toBeNull();
  });

  it("appendEvent refuses a stale version and writes nothing", async () => {
    await store.insertOrder({ id: "o1", idempotencyKey: "a", view: view(), event: placed, payment: payment("o1") });
    const accepted: OrderEvent = { type: "station_accepted", actor: "station", at: 2_000 };
    const next = (transition(view(), accepted) as { ok: true; view: OrderView }).view;
    expect(await store.appendEvent("o1", 1, accepted, next)).toBe(true);
    expect(await store.appendEvent("o1", 1, accepted, next)).toBe(false); // second writer lost the race
    expect((await store.listEvents("o1")).map((e) => e.seq)).toEqual([1, 2]);
    expect((await store.getOrder("o1"))!.view.version).toBe(2);
  });

  it("claims a driver only once", async () => {
    expect(await store.setDriverStatus("d", "busy", "available")).toBe(true);
    expect(await store.setDriverStatus("d", "busy", "available")).toBe(false);
  });

  it("the location gate keeps one point per interval", async () => {
    const at = (s: number) => ({ driverId: "d", orderId: null, lat: -33.9, lng: 18.4, t: 1_000_000 + s * 1000 });
    const results = [];
    for (const s of [0, 5, 29, 30, 31, 60]) results.push(await store.recordLocationIfDue(at(s), 30_000));
    expect(results).toEqual([true, false, false, true, false, true]);
    expect((await store.listLocations({ driverId: "d" })).length).toBe(3);
  });

  it("a payment can be charged once", async () => {
    await store.insertOrder({ id: "o1", idempotencyKey: "a", view: view(), event: placed, payment: payment("o1") });
    const charge = { intentId: "pi_o1", amountCents: 24_675, eventId: "e1", at: 1 };
    expect(await store.recordCharge(charge)).toBe(true);
    expect(await store.recordCharge({ ...charge, eventId: "e2" })).toBe(false);
    expect(await store.countCharges()).toBe(1);
    expect(await store.recordCharge({ ...charge, amountCents: 1 })).toBe(false);
  });
});
