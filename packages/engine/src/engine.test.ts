import { replay, type OrderEvent, type TrackHub } from "@noir/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalEngine, type LocalEngine } from "./testkit";

const HOME = { lat: -33.95, lng: 18.47, label: "12 Main Rd" };
let k: LocalEngine;
let metrics: { type: string; ms?: number; assigned?: boolean }[];

// st-claremont is at -33.9825, 18.4661. d-near is ~1 km from it, d-far ~15 km.
const putDriver = (id: string, lat: number, lng: number, status: "available" | "offline" = "available") =>
  k.store.upsertDriver({ id, name: id, status, lat, lng, locationAt: k.clock.now });

beforeEach(async () => {
  metrics = [];
  k = await createLocalEngine({ metrics: (m) => metrics.push(m) });
  await k.store.upsertCustomer({ id: "c1", name: "Test Customer" });
  await k.store.upsertCustomer({ id: "c2", name: "Second Customer" });
});
afterEach(() => k.close());

const place = (customerId = "c1", key = "k1", stationId = "st-claremont") =>
  k.engine.placeOrder({ customerId, stationId, fuel: "diesel", litres: 40, dropoff: HOME, idempotencyKey: key });
const accept = (id: string) => k.engine.submit(id, { type: "station_accepted", actor: "station" });
const stateOf = async (id: string) => (await k.engine.detail(id))!.view;

describe("placing orders", () => {
  it("prices from the station, opens a payment intent and logs the first event", async () => {
    const { order, created, clientSecret } = await place();
    expect(created).toBe(true);
    expect(clientSecret).toMatch(/^pi_test_/);
    expect(order.view.totalCents).toBe(40 * 2340);
    expect(order.payment).toMatchObject({ status: "requires_payment", amountCents: 93_600 });
    expect(order.events.map((e) => e.event.type)).toEqual(["order_placed"]);
  });

  it("is idempotent on (customer, key): a retry returns the same order and one payment", async () => {
    const a = await place();
    const b = await place();
    expect(b.created).toBe(false);
    expect(b.order.id).toBe(a.order.id);
    expect((await k.store.listOrders()).length).toBe(1);
  });

  it("rejects an unknown station", async () => {
    await expect(place("c1", "k9", "nope")).rejects.toThrow(/station/);
  });
});

describe("dispatch", () => {
  it("assigns the lowest-ETA driver once the order is accepted and paid, not before", async () => {
    await putDriver("d-far", -33.86, 18.6);
    await putDriver("d-near", -33.975, 18.47);
    const { order } = await place();
    await accept(order.id);
    expect((await stateOf(order.id)).state).toBe("accepted"); // unpaid: no dispatch yet
    expect(await k.payOrder(order.id)).toEqual({ status: "processed" });
    const v = await stateOf(order.id);
    expect(v).toMatchObject({ state: "assigned", driverId: "d-near" });
    expect((await k.store.getDriver("d-near"))!.status).toBe("busy");
    expect((await k.store.getDriver("d-far"))!.status).toBe("available");
    expect(metrics.find((m) => m.type === "assignment")).toMatchObject({ assigned: true });
  });

  it("leaves the order accepted when no driver is available, then assigns when one comes online", async () => {
    const { order } = await place();
    await accept(order.id);
    await k.payOrder(order.id);
    expect((await stateOf(order.id)).state).toBe("accepted");
    await putDriver("d1", -33.975, 18.47, "offline");
    await k.engine.driverOnline("d1", { lat: -33.975, lng: 18.47 });
    expect(await stateOf(order.id)).toMatchObject({ state: "assigned", driverId: "d1" });
  });

  it("sweep cancels an order that waited too long for a driver, as the system, and refunds it", async () => {
    const { order } = await place();
    await accept(order.id);
    await k.payOrder(order.id);
    k.clock.now += 16 * 60_000;
    expect(await k.engine.sweep()).toEqual([order.id]);
    const d = (await k.engine.detail(order.id))!;
    expect(d.view.cancel).toMatchObject({ by: "system", reason: "no_driver_available" });
    expect(d.payment).toMatchObject({ status: "refunded", refundedCents: 93_600 });
  });

  it("a driver declining reassigns to the next-best driver and never back to the decliner", async () => {
    await putDriver("d-near", -33.975, 18.47);
    await putDriver("d-mid", -33.93, 18.45);
    const { order } = await place();
    await accept(order.id);
    await k.payOrder(order.id);
    expect((await stateOf(order.id)).driverId).toBe("d-near");
    const r = await k.engine.submit(order.id, { type: "driver_declined", actor: "driver", actorId: "d-near" });
    expect(r.ok).toBe(true);
    expect(await stateOf(order.id)).toMatchObject({ state: "assigned", driverId: "d-mid", declinedBy: ["d-near"] });
    expect((await k.store.getDriver("d-near"))!.status).toBe("available");
    // d-mid also declines: d-near is barred, so nobody is left.
    await k.engine.submit(order.id, { type: "driver_declined", actor: "driver", actorId: "d-mid" });
    expect(await stateOf(order.id)).toMatchObject({ state: "accepted", driverId: null, declinedBy: ["d-near", "d-mid"] });
  });

  it("two orders racing for one driver: exactly one wins, the other stays accepted", async () => {
    await putDriver("d1", -33.975, 18.47);
    const a = (await place("c1", "a")).order.id;
    const b = (await place("c2", "b")).order.id;
    await Promise.all([accept(a), accept(b)]);
    await Promise.all([k.payOrder(a), k.payOrder(b)]);
    const states = [(await stateOf(a)).state, (await stateOf(b)).state].sort();
    expect(states).toEqual(["accepted", "assigned"]);
    // Finishing the first job hands the driver to the waiting order.
    const winner = (await stateOf(a)).state === "assigned" ? a : b;
    const loser = winner === a ? b : a;
    for (const type of ["driver_departed", "driver_arrived", "delivery_started", "delivery_completed"] as const) {
      expect((await k.engine.submit(winner, { type, actor: "driver", actorId: "d1" })).ok).toBe(true);
    }
    expect(await stateOf(loser)).toMatchObject({ state: "assigned", driverId: "d1" });
  });

  it("a driver going offline mid-assignment returns the order to the queue", async () => {
    await putDriver("d1", -33.975, 18.47);
    const { order } = await place();
    await accept(order.id);
    await k.payOrder(order.id);
    await k.engine.driverOffline("d1");
    expect(await stateOf(order.id)).toMatchObject({ state: "accepted", driverId: null, declinedBy: [] });
    expect((await k.store.getDriver("d1"))!.status).toBe("offline");
  });
});

describe("event log", () => {
  it("replaying the stored events reproduces the projection, and the table is append-only", async () => {
    await putDriver("d1", -33.975, 18.47);
    const { order } = await place();
    await accept(order.id);
    await k.payOrder(order.id);
    await k.engine.submit(order.id, { type: "order_modified", actor: "customer", data: { note: "blue gate" } });
    await k.engine.submit(order.id, { type: "driver_departed", actor: "driver", actorId: "d1" });
    const d = (await k.engine.detail(order.id))!;
    expect(d.events.map((e) => e.seq)).toEqual(d.events.map((_, i) => i + 1));
    expect(replay(d.events.map((e) => e.event as OrderEvent))).toEqual(d.view);
    // The store's typed API has no update/delete; the trigger stops raw SQL too.
    await expect(k.db.execute(sql`update order_events set actor = 'system'`)).rejects.toThrow();
    await expect(k.db.execute(sql`delete from order_events`)).rejects.toThrow();
  });

  it("illegal requests are rejected and leave no trace in the log", async () => {
    const { order } = await place();
    const r = await k.engine.submit(order.id, { type: "delivery_completed", actor: "driver", actorId: "d1" });
    expect(r).toMatchObject({ ok: false });
    expect((await k.engine.detail(order.id))!.events).toHaveLength(1);
  });
});

describe("cancellation and refunds", () => {
  it("customer cancel before payment cancels the intent", async () => {
    const { order } = await place();
    expect((await k.engine.submit(order.id, { type: "order_cancelled", actor: "customer" })).ok).toBe(true);
    expect((await k.engine.detail(order.id))!.payment!.status).toBe("canceled");
  });

  it("customer cancel while a driver is en route refunds minus the cancellation fee and frees the driver", async () => {
    await putDriver("d1", -33.975, 18.47);
    const { order } = await place();
    await accept(order.id);
    await k.payOrder(order.id);
    await k.engine.submit(order.id, { type: "driver_departed", actor: "driver", actorId: "d1" });
    await k.engine.submit(order.id, { type: "order_cancelled", actor: "customer" });
    const d = (await k.engine.detail(order.id))!;
    expect(d.payment).toMatchObject({ status: "refunded", refundedCents: 93_600 - 5_000 });
    expect((await k.store.getDriver("d1"))!.status).toBe("available");
  });

  it("station cancel refunds in full", async () => {
    const { order } = await place();
    await accept(order.id);
    await k.payOrder(order.id);
    await k.engine.submit(order.id, { type: "order_cancelled", actor: "station", data: { reason: "out_of_stock" } });
    expect((await k.engine.detail(order.id))!.payment).toMatchObject({ status: "refunded", refundedCents: 93_600 });
  });

  it("a payment that lands after cancellation is refunded automatically", async () => {
    const { order } = await place();
    await k.engine.submit(order.id, { type: "order_cancelled", actor: "customer" });
    // Cancel already moved the intent to canceled; simulate the provider charging anyway (race).
    await k.store.setPaymentStatus((await k.engine.detail(order.id))!.payment!.intentId, "requires_payment", "canceled");
    await k.payOrder(order.id);
    expect((await k.engine.detail(order.id))!.payment).toMatchObject({ status: "refunded", refundedCents: 93_600 });
  });
});

describe("location downsampling", () => {
  it("persists one point per 30 s per driver when idle, however often it pings", async () => {
    await putDriver("d1", -33.975, 18.47);
    await k.store.upsertDriver({ id: "d1", name: "d1", status: "available", lat: -33.975, lng: 18.47, locationAt: null });
    const t0 = k.clock.now;
    for (let s = 0; s <= 120; s += 5) await k.engine.recordLocation({ driverId: "d1", lat: -33.975 + s * 1e-5, lng: 18.47, t: t0 + s * 1000 });
    const pts = await k.store.listLocations({ driverId: "d1" });
    expect(pts.map((p) => (p.t - t0) / 1000)).toEqual([0, 30, 60, 90, 120]);
  });

  it("persists a delivery's track downsampled while broadcasting every ping", async () => {
    await putDriver("d1", -33.975, 18.47);
    const { order } = await place();
    await accept(order.id);
    await k.payOrder(order.id);
    const seen: number[] = [];
    (k.engine.hub as TrackHub).room(order.id).subscribe((m) => m.type === "position" && seen.push(m.point.t));
    const t0 = k.clock.now;
    for (let s = 0; s <= 60; s += 5) await k.engine.recordLocation({ driverId: "d1", orderId: order.id, lat: -33.97, lng: 18.47, t: t0 + s * 1000 });
    await new Promise((r) => setTimeout(r, 50)); // persist is fire-and-forget
    expect(seen).toHaveLength(13);
    expect((await k.store.listLocations({ orderId: order.id })).length).toBe(3);
  });
});

describe("retention", () => {
  it("deletes location points older than 7 days and keeps newer ones", async () => {
    await putDriver("d1", -33.975, 18.47);
    const day = 86_400_000;
    for (const ageDays of [9, 8, 6, 1]) {
      await k.db.execute(sql`insert into driver_locations (driver_id, lat, lng, recorded_at) values ('d1', -33.9, 18.4, ${new Date(k.clock.now - ageDays * day).toISOString()}::timestamptz)`);
    }
    const before = (await k.store.listLocations({ driverId: "d1" })).length;
    const r = await k.engine.runRetention({ locationDays: 7 });
    const after = (await k.store.listLocations({ driverId: "d1" })).length;
    expect(before).toBeGreaterThan(0);
    expect(r.locations).toBe(before - after);
    expect((await k.store.listLocations({ driverId: "d1" })).every((p) => p.t >= k.clock.now - 7 * day)).toBe(true);
  });

  it("expires only finished simulated orders, with their events and payments", async () => {
    const sim = await k.engine.placeOrder({ customerId: "c1", stationId: "st-cbd", fuel: "diesel", litres: 10, dropoff: HOME, idempotencyKey: "s", isSimulated: true });
    const real = await k.engine.placeOrder({ customerId: "c1", stationId: "st-cbd", fuel: "diesel", litres: 10, dropoff: HOME, idempotencyKey: "r" });
    const openSim = await k.engine.placeOrder({ customerId: "c1", stationId: "st-cbd", fuel: "diesel", litres: 10, dropoff: HOME, idempotencyKey: "o", isSimulated: true });
    await k.engine.submit(sim.order.id, { type: "order_cancelled", actor: "customer" });
    await k.engine.submit(real.order.id, { type: "order_cancelled", actor: "customer" });
    k.clock.now += 25 * 3_600_000;
    expect(await k.engine.runRetention({ simulatedHours: 24 })).toMatchObject({ simulatedOrders: 1 });
    expect(await k.engine.detail(sim.order.id)).toBeNull();
    expect(await k.store.getPaymentByOrder(sim.order.id)).toBeNull();
    expect(await k.engine.detail(real.order.id)).not.toBeNull(); // not simulated: never deleted
    expect(await k.engine.detail(openSim.order.id)).not.toBeNull(); // still open: not finished
    // Real orders' events stay undeletable even though simulated ones can go.
    await expect(k.db.execute(sql`delete from order_events where order_id = ${real.order.id}`)).rejects.toThrow();
  });
});
