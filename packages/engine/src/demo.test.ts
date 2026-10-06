import { afterEach, describe, expect, it } from "vitest";
import {
  DEMO_DRIVER_PREFIX,
  FallbackRouteProvider,
  OsrmRouteProvider,
  StraightLineRouteProvider,
  destinationPoint,
  distanceM,
  type LatLng,
  type Route,
  type RouteProvider,
  type TrackHub,
  type TrackPoint,
} from "@noir/core";
import { DEMO_MAX_GAP_MS, DemoRunner, type DemoStepResult } from "./demo";
import { SIM_STATIONS } from "./seed";
import { createLocalEngine, type LocalEngine } from "./testkit";

let k: LocalEngine | undefined;
afterEach(async () => {
  await k?.close();
  k = undefined;
});

const STATION = SIM_STATIONS.find((s) => s.id === "st-claremont")!;
const DROP = destinationPoint(STATION, 20, 5_000);

/** A hand-made road: out of the station, a dog-leg, then to the drop-off. Length is whatever the points make it; duration is set by the test. */
function road(durationS: number): Route {
  const a: LatLng = STATION;
  const b = destinationPoint(a, 0, 2_000);
  const c = destinationPoint(b, 90, 2_500);
  return { points: [a, b, c, DROP], distanceM: 0, durationS, source: "osrm" };
}
class FakeRoutes implements RouteProvider {
  calls = 0;
  constructor(private readonly durationS = 600) {}
  async route() {
    this.calls++;
    return road(this.durationS);
  }
}

async function setup(o: { routes?: RouteProvider; pay?: boolean; cap?: number } = {}) {
  k = await createLocalEngine();
  await k.store.upsertCustomer({ id: "visitor", name: "Visitor" });
  const { order } = await k.engine.placeOrder({ customerId: "visitor", stationId: STATION.id, fuel: "diesel", litres: 30, dropoff: { ...DROP, label: "Newlands" }, idempotencyKey: "k1" });
  if (o.pay !== false) await k.payOrder(order.id);
  const routes = o.routes ?? new FakeRoutes();
  const runner = () => new DemoRunner(k!.engine, routes, { dailyStepCap: o.cap });
  const positions: TrackPoint[] = [];
  (k.engine.hub as TrackHub).room(order.id).subscribe((m) => m.type === "position" && positions.push(m.point));
  return { id: order.id, runner, routes, positions };
}

const ok = (r: DemoStepResult) => {
  if (!r.ok) throw new Error(`step failed: ${r.error.code}: ${r.error.message}`);
  return r;
};

describe("DemoRunner: a whole order through steps alone", () => {
  it("goes from paid to delivered with nothing but step calls, and the driver follows the road", async () => {
    const { id, runner, routes, positions } = await setup();
    const r = runner();
    const t0 = k!.clock.now;
    let steps = 0;
    let last: DemoStepResult | undefined;
    while (steps < 300) {
      k!.clock.now += 2_500;
      steps++;
      last = ok(await r.step(id));
      if (last.done) break;
    }
    const realSeconds = (k!.clock.now - t0) / 1000;
    expect(last).toMatchObject({ ok: true, state: "completed", done: true });

    const events = (await k!.engine.detail(id))!.events.map((e) => e.event.type);
    expect(events).toEqual(["order_placed", "station_accepted", "driver_assigned", "driver_departed", "driver_arrived", "delivery_started", "delivery_completed"]);
    const assigned = (await k!.engine.detail(id))!.events.find((e) => e.event.type === "driver_assigned")!.event.data as { driverId: string };
    expect(assigned.driverId.startsWith(DEMO_DRIVER_PREFIX)).toBe(true);

    // A 600 s (10 minute) road trip: 15 + 45 + 600 + 30 + 240 = 930 simulated seconds, at 10x = 93 real seconds.
    expect(realSeconds).toBeGreaterThanOrEqual(92.5);
    expect(realSeconds).toBeLessThanOrEqual(100);
    expect(steps).toBeLessThanOrEqual(40);

    // One routing lookup, cached with the order.
    expect((routes as FakeRoutes).calls).toBe(1);
    const demo = (await k!.store.getDemo(id))!;
    expect(demo.route?.source).toBe("osrm");
    expect(demo.route!.points.length).toBeGreaterThanOrEqual(4);

    // Pings went through the normal path (the room): from the station, along the dog-leg, to the door, never backwards.
    expect(positions.length).toBeGreaterThan(20);
    expect(distanceM(positions[0]!, STATION)).toBeLessThan(5);
    expect(distanceM(positions.at(-1)!, DROP)).toBeLessThan(5);
    const along = positions.map((p) => distanceM(p, STATION));
    expect(positions.some((p) => distanceM(p, destinationPoint(STATION, 20, 2_500)) > 300 && distanceM(p, STATION) > 800)).toBe(true);
    // Between consecutive pings the car never moves further than the road speed allows at 10x (about 10 km/h * 10 * 2.5 s here, plus slack).
    const speedMs = demo.route!.distanceM / 600;
    for (let i = 1; i < positions.length; i++) expect(distanceM(positions[i - 1]!, positions[i]!)).toBeLessThanOrEqual(speedMs * 10 * 2.5 + 5);
    expect(Math.max(...along)).toBeGreaterThan(1_500);

    // The demo driver goes back to the pool offline, so it is never dispatched to anything else.
    expect((await k!.store.getDriver(assigned.driverId))!.status).toBe("offline");
    expect(await k!.store.countCharges()).toBe(1); // nothing about the demo touched money
  });

  it("a typical 12 km trip (18 minute road estimate) plays in about 2.4 minutes of real time", async () => {
    const { id, runner } = await setup({ routes: new FakeRoutes(1080) });
    const r = runner();
    const t0 = k!.clock.now;
    for (let i = 0; i < 300; i++) {
      k!.clock.now += 2_500;
      if (ok(await r.step(id)).done) break;
    }
    // (60 + 1080 + 30 + 240) / 10 = 141 s
    expect((k!.clock.now - t0) / 1000).toBeGreaterThanOrEqual(140);
    expect((k!.clock.now - t0) / 1000).toBeLessThanOrEqual(146);
  });

  it("reports honest demo speed, progress and an ETA in real seconds", async () => {
    const { id, runner } = await setup();
    const r = runner();
    k!.clock.now += 2_500;
    const first = ok(await r.step(id));
    expect(first.speed).toBe(10);
    expect(first.etaRealS).not.toBeNull();
    expect(first.routeSource).toBe("osrm");
    k!.clock.now += 2_500;
    const second = ok(await r.step(id));
    expect(second.progress).toBeGreaterThan(first.progress);
    expect(second.etaRealS!).toBeLessThan(first.etaRealS!);
  });
});

describe("DemoRunner: idempotent", () => {
  it("a second tab does not double the speed: two callers a second apart add up to wall time", async () => {
    const { id, runner } = await setup();
    const a = runner();
    const b = runner();
    k!.clock.now += 1_000;
    await a.step(id);
    const t0 = k!.clock.now;
    // 30 s of wall time, with tab A and tab B each stepping every 2.5 s, 1.25 s apart.
    for (let i = 0; i < 12; i++) {
      k!.clock.now += 1_250;
      await (i % 2 === 0 ? b : a).step(id);
      k!.clock.now += 1_250;
      await (i % 2 === 0 ? a : b).step(id);
    }
    const demo = (await k!.store.getDemo(id))!;
    expect(demo.demoMs).toBe(k!.clock.now - t0 + 0); // exactly the wall time since the first step
    expect(demo.steps).toBe(1 + 24);
  });

  it("double clicks at the same instant neither advance twice nor break the order", async () => {
    const { id, runner } = await setup();
    const r = runner();
    k!.clock.now += 5_000;
    await Promise.all([r.step(id), r.step(id), r.step(id)]);
    k!.clock.now += 2_000;
    const results = await Promise.all([r.step(id), r.step(id), r.step(id)]);
    results.forEach(ok);
    const demo = (await k!.store.getDemo(id))!;
    expect(demo.demoMs).toBe(2_000); // the three simultaneous calls at +2 s added 2 s once in total, the rest added 0
    const events = (await k!.engine.detail(id))!.events.map((e) => e.event.type);
    expect(events.filter((t) => t === "station_accepted")).toHaveLength(1);
    expect(events.filter((t) => t === "driver_assigned")).toHaveLength(1);
  });

  it("a long pause (hidden tab) does not make the car jump: the clock moves by at most the gap cap", async () => {
    const { id, runner } = await setup();
    const r = runner();
    k!.clock.now += 2_500;
    await r.step(id);
    const before = (await k!.store.getDemo(id))!.demoMs;
    k!.clock.now += 5 * 60_000;
    await r.step(id);
    expect((await k!.store.getDemo(id))!.demoMs - before).toBe(DEMO_MAX_GAP_MS);
  });

  it("looks the route up once even when the first steps race", async () => {
    const { id, runner, routes } = await setup();
    k!.clock.now += 2_500;
    const rs = await Promise.all([runner().step(id), runner().step(id), runner().step(id)]);
    rs.forEach(ok);
    expect((routes as FakeRoutes).calls).toBe(1);
    expect((await k!.store.getDemo(id))!.route).not.toBeNull();
  });

  it("a request that claimed the route lookup and died is replaced by the straight line, not by a second routing request", async () => {
    const { id, runner, routes } = await setup();
    k!.clock.now += 2_500;
    await k!.store.startDemo(id, k!.clock.now); // the first request got this far...
    await k!.store.claimDemoRoute(id); // ...claimed the lookup and then died
    const r = runner();
    const waiting = ok(await r.step(id));
    expect(waiting.preparing).toBe(true); // others wait for it
    k!.clock.now += 20_000;
    const after = ok(await r.step(id));
    expect(after.preparing).toBe(false);
    expect(after.routeSource).toBe("straight");
    expect((routes as FakeRoutes).calls).toBe(0);
  });
});

describe("DemoRunner: roads and fallback", () => {
  it("falls back to the straight-line mover when routing fails, records that, and still delivers", async () => {
    const failing = new OsrmRouteProvider({ userAgent: "t", fetch: (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch });
    const reasons: string[] = [];
    const { id, runner } = await setup({ routes: new FallbackRouteProvider(failing, new StraightLineRouteProvider(), (why) => reasons.push(why)) });
    const r = runner();
    let last: DemoStepResult | undefined;
    for (let i = 0; i < 300; i++) {
      k!.clock.now += 2_500;
      last = ok(await r.step(id));
      if (last.done) break;
    }
    expect(last).toMatchObject({ state: "completed", routeSource: "straight" });
    expect(reasons).toEqual(["network down"]);
    expect((await k!.store.getDemo(id))!.route).toMatchObject({ source: "straight" });
    expect((await k!.store.getDemo(id))!.route!.points).toHaveLength(2);
  });

  it("treats a provider that throws like a failed lookup", async () => {
    const { id, runner } = await setup({ routes: { route: async () => { throw new Error("boom"); } } });
    k!.clock.now += 2_500;
    expect(ok(await runner().step(id)).routeSource).toBe("straight");
  });
});

describe("DemoRunner: refusals", () => {
  it("refuses an unpaid order, a simulated order and an unknown order", async () => {
    const { id, runner } = await setup({ pay: false });
    expect(await runner().step(id)).toMatchObject({ ok: false, error: { code: "payment_required" } });
    expect(await runner().step("nope")).toMatchObject({ ok: false, error: { code: "not_found" } });
    await k!.store.upsertCustomer({ id: "sim-cust-1", name: "S", isSimulated: true });
    const sim = await k!.engine.placeOrder({ customerId: "sim-cust-1", stationId: STATION.id, fuel: "diesel", litres: 10, dropoff: { ...DROP, label: "x" }, idempotencyKey: "s", isSimulated: true });
    await k!.payOrder(sim.order.id);
    expect(await runner().step(sim.order.id)).toMatchObject({ ok: false, error: { code: "not_demoable" } });
  });

  it("stops at the global daily cap and starts again the next UTC day", async () => {
    const { id, runner } = await setup({ cap: 5 });
    const r = runner();
    for (let i = 0; i < 5; i++) {
      k!.clock.now += 2_500;
      ok(await r.step(id));
    }
    k!.clock.now += 2_500;
    expect(await r.step(id)).toMatchObject({ ok: false, error: { code: "daily_cap" } });
    expect(await runner().step(id)).toMatchObject({ ok: false, error: { code: "daily_cap" } });
    k!.clock.now += 24 * 3_600_000;
    ok(await runner().step(id));
  });

  it("the daily cap is shared by every order", async () => {
    const { id, runner } = await setup({ cap: 3 });
    const r = runner();
    for (let i = 0; i < 3; i++) {
      k!.clock.now += 2_500;
      ok(await r.step(id));
    }
    const other = await k!.engine.placeOrder({ customerId: "visitor", stationId: STATION.id, fuel: "diesel", litres: 10, dropoff: { ...DROP, label: "x" }, idempotencyKey: "k2" });
    await k!.payOrder(other.order.id);
    expect(await runner().step(other.order.id)).toMatchObject({ ok: false, error: { code: "daily_cap" } });
  });

  it("says no_driver, and does not start the clock, when all eight demo drivers are busy", async () => {
    const { id, runner } = await setup();
    for (let i = 1; i <= 8; i++) await k!.store.upsertDriver({ id: `${DEMO_DRIVER_PREFIX}0${i}`, name: "busy", status: "busy", lat: 0, lng: 0, locationAt: null, isSimulated: true });
    expect(await runner().step(id)).toMatchObject({ ok: false, error: { code: "no_driver" } });
    expect(await k!.store.getDemo(id)).toBeNull();
  });

  it("will not move an order that a real (non-simulated) driver holds", async () => {
    const { id, runner } = await setup({ pay: false });
    await k!.store.upsertDriver({ id: "drv-real", name: "Real", status: "available", lat: STATION.lat, lng: STATION.lng, locationAt: k!.clock.now });
    await k!.engine.submit(id, { type: "station_accepted", actor: "station" });
    await k!.payOrder(id); // payment triggers dispatch: the only free driver is the real one
    expect((await k!.engine.detail(id))!.view.driverId).toBe("drv-real");
    expect(await runner().step(id)).toMatchObject({ ok: false, error: { code: "other_driver" } });
    expect((await k!.engine.detail(id))!.view.state).toBe("assigned"); // untouched
  });

  it("takes over from a simulator driver that was assigned but has not set off", async () => {
    const { id, runner } = await setup({ pay: false });
    await k!.store.upsertDriver({ id: "sim-drv-01", name: "Sim", status: "available", lat: STATION.lat, lng: STATION.lng, locationAt: k!.clock.now, isSimulated: true });
    await k!.engine.submit(id, { type: "station_accepted", actor: "station" });
    await k!.payOrder(id);
    expect((await k!.engine.detail(id))!.view.driverId).toBe("sim-drv-01");
    const r = runner();
    for (let i = 0; i < 300; i++) {
      k!.clock.now += 2_500;
      if (ok(await r.step(id)).done) break;
    }
    const d = (await k!.engine.detail(id))!;
    expect(d.view.state).toBe("completed");
    expect(d.view.driverId!.startsWith(DEMO_DRIVER_PREFIX)).toBe(true);
    expect((await k!.store.getDriver("sim-drv-01"))!.status).toBe("available"); // handed back untouched
  });

  it("demo drivers are never dispatched to ordinary orders", async () => {
    const { id, runner } = await setup();
    k!.clock.now += 2_500;
    ok(await runner().step(id)); // reserves a demo driver standing at the station
    const normal = await k!.engine.placeOrder({ customerId: "visitor", stationId: STATION.id, fuel: "diesel", litres: 10, dropoff: { ...DROP, label: "x" }, idempotencyKey: "other" });
    await k!.engine.submit(normal.order.id, { type: "station_accepted", actor: "station" });
    await k!.payOrder(normal.order.id);
    expect((await k!.engine.detail(normal.order.id))!.view.driverId).toBeNull();
  });
});
