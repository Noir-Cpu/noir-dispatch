import { createLocalEngine } from "@noir/engine/local";
import { replay, type OrderEvent } from "@noir/core";
import { describe, expect, it } from "vitest";
import { percentile, rng } from "./rng";
import { Simulation } from "./simulation";

async function run(seed: number, hours = 0.15) {
  let sim: Simulation;
  const k = await createLocalEngine({ metrics: (m) => m.type === "assignment" && sim.recordAssignment(m.ms, m.assigned) });
  sim = new Simulation({ engine: k.engine, clock: k.clock, pay: k.payOrder, config: { seed, drivers: 20, ordersPerHour: 120 } });
  await sim.init();
  await sim.runVirtual(hours);
  const report = await sim.report();
  return { k, report };
}

// Wall-clock latency fields differ run to run; everything else must match for the same seed.
const deterministic = (r: Awaited<ReturnType<typeof run>>["report"]) => {
  const { assignmentMs: _a, locationToSubscriberMs: _l, ...rest } = r;
  return { ...rest, assigned: _a.n, delivered: _l.n };
};

describe("simulation", () => {
  it("is deterministic for a seed and differs across seeds", async () => {
    const a = await run(7);
    const b = await run(7);
    const c = await run(8);
    expect(deterministic(b.report)).toEqual(deterministic(a.report));
    expect(deterministic(c.report)).not.toEqual(deterministic(a.report));
    await Promise.all([a.k.close(), b.k.close(), c.k.close()]);
  }, 60_000);

  it("finishes every order through the state machine and every event log replays to its projection", async () => {
    const { k, report } = await run(3);
    expect(report.orders.placed).toBeGreaterThan(5);
    expect(report.orders.open).toBe(0);
    expect(report.orders.completed + report.orders.cancelled).toBe(report.orders.placed);
    for (const o of await k.store.listOrders()) {
      const events = (await k.store.listEvents(o.id)).map((e) => e.event as OrderEvent);
      expect(replay(events)).toEqual(o.view);
    }
    // Downsampling: far fewer stored rows than pings.
    expect(report.persistedLocationRows).toBeLessThan(report.pings / 3);
    await k.close();
  }, 60_000);
});

describe("helpers", () => {
  it("rng is reproducible", () => {
    expect([rng(1).next(), rng(1).next()]).toEqual([rng(1).next(), rng(1).next()]);
    const r = rng(5);
    expect(Array.from({ length: 3 }, () => r.int(0, 100))).toEqual((() => { const q = rng(5); return Array.from({ length: 3 }, () => q.int(0, 100)); })());
  });
  it("percentile is nearest-rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNaN();
  });
});
