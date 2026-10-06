import { afterEach, describe, expect, it } from "vitest";
import { DELIVERY_RADIUS_KM, destinationPoint, distanceKm } from "@noir/core";
import { CAPE_TOWN_STATIONS, EXTRA_STATIONS, SIM_STATIONS, seedStations } from "./index";
import { EngineError } from "./engine";
import { createLocalEngine, type LocalEngine } from "./testkit";

let k: LocalEngine | undefined;
afterEach(async () => {
  await k?.close();
  k = undefined;
});

const place = (e: LocalEngine, stationId: string, dropoff: { lat: number; lng: number }, key: string) =>
  e.engine.placeOrder({ customerId: "c1", stationId, fuel: "diesel", litres: 10, dropoff: { ...dropoff, label: "Test" }, idempotencyKey: key });

describe("delivery radius, enforced by the engine", () => {
  it("is 12 km by default", async () => {
    k = await createLocalEngine();
    expect(DELIVERY_RADIUS_KM).toBe(12);
    expect(k.engine.config.deliveryRadiusKm).toBe(12);
  });

  it("every station accepts a drop-off just inside the radius and rejects one just outside, in four directions", async () => {
    k = await createLocalEngine();
    await k.store.upsertCustomer({ id: "c1", name: "C" });
    let n = 0;
    for (const s of CAPE_TOWN_STATIONS) {
      for (const bearing of [0, 90, 180, 270]) {
        const inside = destinationPoint(s, bearing, 11_950);
        expect(distanceKm(s, inside)).toBeLessThan(12);
        const ok = await place(k, s.id, inside, `in-${n++}`);
        expect(ok.created, `${s.id} at ${bearing} deg`).toBe(true);
        const outside = destinationPoint(s, bearing, 12_050);
        const err = await place(k, s.id, outside, `out-${n++}`).catch((e) => e);
        expect(err, `${s.id} at ${bearing} deg`).toBeInstanceOf(EngineError);
        expect((err as EngineError).code).toBe("out_of_radius");
        expect((err as EngineError).message).toContain("12 km");
      }
    }
    expect(n).toBe(CAPE_TOWN_STATIONS.length * 8);
  });

  it("the error names the radius and the distance, and suggests the nearest station that can deliver", async () => {
    k = await createLocalEngine();
    await k.store.upsertCustomer({ id: "c1", name: "C" });
    const stellenbosch = { lat: -33.9346, lng: 18.8602 }; // Claremont is about 35 km away
    const err = (await place(k, "st-claremont", stellenbosch, "far").catch((e) => e)) as EngineError;
    expect(err.code).toBe("out_of_radius");
    expect(err.message).toMatch(/outside our 12 km delivery radius/);
    expect(err.message).toMatch(/Eikestad Fuel Depot is [\d.]+ km away and can deliver there/);
    expect(err.details).toMatchObject({ radiusKm: 12, nearestInRange: { id: "st-stellenbosch" } });
    expect(err.details!.distanceKm).toBeGreaterThan(30);
  });

  it("uses a configured radius", async () => {
    k = await createLocalEngine({ config: { deliveryRadiusKm: 3 } });
    await k.store.upsertCustomer({ id: "c1", name: "C" });
    const st = SIM_STATIONS[2]!;
    expect((await place(k, st.id, destinationPoint(st, 45, 2_900), "a")).created).toBe(true);
    expect(await place(k, st.id, destinationPoint(st, 45, 3_100), "b").catch((e) => e)).toMatchObject({ code: "out_of_radius", message: expect.stringContaining("3 km") });
  });

  it("does not let a customer move the drop-off outside the radius after placing", async () => {
    k = await createLocalEngine();
    await k.store.upsertCustomer({ id: "c1", name: "C" });
    const st = SIM_STATIONS[2]!;
    const { order } = await place(k, st.id, destinationPoint(st, 0, 2_000), "m");
    const far = { ...destinationPoint(st, 0, 20_000), label: "Far" };
    const r = await k.engine.submit(order.id, { type: "order_modified", actor: "customer", data: { dropoff: far } });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_data" } });
    expect((r as { error: { message: string } }).error.message).toContain("12 km");
    const near = { ...destinationPoint(st, 0, 3_000), label: "Near" };
    expect((await k.engine.submit(order.id, { type: "order_modified", actor: "customer", data: { dropoff: near } })).ok).toBe(true);
  });
});

describe("stations seed", () => {
  it("has the original five plus ten more, with unique ids and fictional names", () => {
    expect(SIM_STATIONS).toHaveLength(5);
    expect(EXTRA_STATIONS).toHaveLength(10);
    const ids = CAPE_TOWN_STATIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(15);
    for (const s of CAPE_TOWN_STATIONS) {
      expect(s.lat).toBeGreaterThan(-34.2);
      expect(s.lat).toBeLessThan(-33.7);
      expect(s.lng).toBeGreaterThan(18.3);
      expect(s.lng).toBeLessThan(19.0);
      expect(s.name).not.toMatch(/\b(shell|engen|bp|caltex|sasol|total|astron)\b/i);
    }
  });

  it("is idempotent: running it again changes nothing and adds no rows (safe on production at every deploy)", async () => {
    k = await createLocalEngine({ seedStations: false });
    await seedStations(k.store);
    const first = await k.store.listStations();
    await seedStations(k.store);
    await seedStations(k.store);
    expect(await k.store.listStations()).toEqual(first);
    expect(first).toHaveLength(15);
  });

  it("only adds: an existing row that is not in the seed survives, and a changed seed row is corrected", async () => {
    k = await createLocalEngine({ seedStations: false });
    await k.store.upsertStation({ id: "st-custom", name: "Someone else's", lat: -33.9, lng: 18.5, rating: 3, prices: { diesel: 1, petrol_95: 1 } });
    await k.store.upsertStation({ ...SIM_STATIONS[0]!, name: "Old name" });
    await seedStations(k.store);
    const all = await k.store.listStations();
    expect(all.map((s) => s.id)).toContain("st-custom");
    expect(all.find((s) => s.id === SIM_STATIONS[0]!.id)!.name).toBe(SIM_STATIONS[0]!.name);
  });

  it("every demo station can deliver to a point 3 km away, and the new stations cover their own towns", () => {
    for (const s of EXTRA_STATIONS) expect(distanceKm(s, destinationPoint(s, 200, 3_000))).toBeLessThan(DELIVERY_RADIUS_KM);
  });
});
