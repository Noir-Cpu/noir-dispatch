// On-demand demo ("Run demo"). The browser calls step() every 2 to 3 seconds while the visitor watches their own order.
// A step is stateless and cheap: it reads the demo clock from the database, works out where the order should be by now,
// applies any transitions that are due through the normal engine path, and sends one location ping. Nothing runs in the
// background, so Neon compute is only used while a visitor is actually watching (docs/adr/0016).
import {
  DEMO_DRIVER_PREFIX,
  DEMO_TIME_COMPRESSION,
  StraightLineRouteProvider,
  compactRoute,
  demoDriverPosition,
  demoTimeline,
  distanceM,
  isDemoDriverId,
  type DemoRecord,
  type OrderState,
  type OrderView,
  type RouteProvider,
  type RouteSource,
  type Station,
} from "@noir/core";
import type { Engine, SubmitInput } from "./engine";

/** The demo clock never advances more than this per step, so a hidden or throttled tab cannot make the car jump. */
export const DEMO_MAX_GAP_MS = 6_000;
/** A demo order accepts at most this many steps (6+ minutes at one step per 2 s), whatever the clients do. */
export const DEMO_MAX_STEPS_PER_ORDER = 300;
export const DEMO_DEFAULT_DAILY_STEP_CAP = 400;
/** Drivers in the demo pool: demo-drv-01 to demo-drv-08. */
export const DEMO_POOL_SIZE = 8;
/** A route lookup that was claimed but never stored (a crashed request) is replaced by the straight line after this long. */
const ROUTE_CLAIM_STALE_MS = 15_000;

export type DemoErrorCode = "not_found" | "not_demoable" | "payment_required" | "no_driver" | "other_driver" | "step_limit" | "daily_cap";

export type DemoStepOk = {
  ok: true;
  state: OrderState;
  /** The order has finished (delivered or cancelled): stop calling. */
  done: boolean;
  /** The route is still being looked up by another request: nothing advanced this time. */
  preparing: boolean;
  /** Time compression: one real second is this many simulated seconds. */
  speed: number;
  progress: number;
  /** Real seconds until arrival at the drop-off at the current pace, or null once arrived. */
  etaRealS: number | null;
  routeSource: RouteSource | null;
  driverId: string | null;
};
export type DemoStepResult = DemoStepOk | { ok: false; error: { code: DemoErrorCode; message: string } };

const fail = (code: DemoErrorCode, message: string): DemoStepResult => ({ ok: false, error: { code, message } });
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const demoDriverId = (i: number) => `${DEMO_DRIVER_PREFIX}${String(i).padStart(2, "0")}`;

export class DemoRunner {
  /** Once the daily cap has been hit on an isolate, further steps that day are refused without touching the database. */
  private readonly capped = { day: null as string | null };

  constructor(
    private readonly engine: Engine,
    private readonly routes: RouteProvider,
    private readonly opts: {
      dailyStepCap?: number;
      compression?: number;
      capMemo?: { day: string | null };
      onRoute?: (info: { source: RouteSource }) => void;
      /** Wall clock for the demo. Defaults to the engine's clock, which is Date.now on the Worker; the dev server's engine clock is simulated, so it passes Date.now. */
      now?: () => number;
    } = {},
  ) {
    if (opts.capMemo) this.capped = opts.capMemo;
  }

  private now() {
    return this.opts.now ? this.opts.now() : this.engine.now();
  }

  private get compression() {
    return this.opts.compression ?? DEMO_TIME_COMPRESSION;
  }

  async step(orderId: string): Promise<DemoStepResult> {
    const e = this.engine;
    const store = e.store;
    const rec = await store.getOrder(orderId);
    if (!rec) return fail("not_found", "order not found");
    // Only orders placed through the public flow: simulator orders have their own driver, and are not the visitor's.
    if (rec.isSimulated) return fail("not_demoable", "simulator orders cannot run the demo");
    const base = { speed: this.compression, routeSource: null as RouteSource | null, driverId: rec.view.driverId };
    if (rec.view.state === "completed" || rec.view.state === "cancelled") {
      return { ok: true, state: rec.view.state, done: true, preparing: false, progress: rec.view.state === "completed" ? 1 : 0, etaRealS: null, ...base };
    }
    const pay = await store.getPaymentByOrder(orderId);
    if (pay?.status !== "succeeded") return fail("payment_required", "pay for the order before running the demo");
    const station = await store.getStation(rec.view.stationId);
    if (!station) return fail("not_found", "station not found");

    const day = utcDay(this.now());
    const cap = this.opts.dailyStepCap ?? DEMO_DEFAULT_DAILY_STEP_CAP;
    if (this.capped.day === day || !(await store.bumpDemoUsage(day, cap))) {
      this.capped.day = day;
      return fail("daily_cap", "The demo has reached its limit for today. It resets at midnight UTC.");
    }

    let demo = await store.getDemo(orderId);
    let view = rec.view;
    if (!demo) {
      // A simulator driver may already hold a visitor's order (the burst simulator accepts new orders and dispatch then assigns one).
      // Before the car has set off, the demo takes the job over so the visitor sees the same driver all the way.
      const held = view.driverId && !isDemoDriverId(view.driverId) ? await store.getDriver(view.driverId) : null;
      const takeover = !!held?.isSimulated && view.state === "assigned";
      if (held && !takeover) return fail("other_driver", "Another driver already has this order, so the demo cannot move it.");
      // The clock does not start until a driver is reserved, so a full pool never leaves a half-run demo behind.
      if ((!view.driverId || takeover) && !(await this.ensureDriver(station))) return fail("no_driver", "All demo drivers are busy. Try again in a minute.");
      await store.startDemo(orderId, this.now());
      demo = (await store.getDemo(orderId))!;
      if (takeover) {
        await e.submit(orderId, { type: "driver_unassigned", actor: "system", data: { reason: "demo_takeover" } }); // dispatch then picks the demo driver at the station
        view = (await store.getOrder(orderId))?.view ?? view;
      }
    }
    if (demo.steps >= DEMO_MAX_STEPS_PER_ORDER) return fail("step_limit", "This demo has run for as long as it is allowed to.");

    if (!demo.route) {
      demo = await this.ensureRoute(demo, station, view);
      if (!demo.route) return { ok: true, state: view.state, done: false, preparing: true, progress: 0, etaRealS: null, ...base };
    }
    const route = demo.route;
    const advanced = await store.advanceDemo(orderId, this.now(), DEMO_MAX_GAP_MS);
    if (!advanced) return fail("not_found", "demo not found");

    // The demo clock, in simulated seconds, decides everything below. Two tabs add up to wall time, not double.
    const simS = (advanced.demoMs / 1000) * this.compression;
    const travelS = route.durationS;
    const tl = demoTimeline(travelS);

    if (view.driverId && !isDemoDriverId(view.driverId)) return fail("other_driver", "Another driver already has this order, so the demo cannot move it.");
    for (let i = 0; i < 8; i++) {
      const ev = await this.nextEvent(view, orderId, station, tl, simS);
      if (!ev) break;
      await e.submit(orderId, ev);
      // Re-read: acceptance dispatches a driver straight after the event is stored, and a lost race means someone else moved it.
      const fresh = (await store.getOrder(orderId))?.view;
      if (!fresh) break;
      const moved = fresh.state !== view.state || fresh.driverId !== view.driverId;
      view = fresh;
      if (!moved) break; // lost a race or nothing to do: whoever won has already advanced it
      if (view.state === "cancelled") break;
    }

    const driverId = view.driverId;
    if (driverId && !isDemoDriverId(driverId)) return fail("other_driver", "Another driver took this order, so the demo cannot move it.");
    const live = driverId && ["assigned", "en_route", "arrived", "delivering"].includes(view.state);
    if (driverId && live) {
      const pos = demoDriverPosition(route.points, tl, simS);
      await e.recordLocation({ driverId, orderId, lat: pos.lat, lng: pos.lng, t: this.now() });
    }
    if (view.state === "completed" && driverId) await store.setDriverStatus(driverId, "offline"); // back to the pool; never dispatchable again

    const done = view.state === "completed" || view.state === "cancelled";
    return {
      ok: true,
      state: view.state,
      done,
      preparing: false,
      speed: this.compression,
      progress: Math.min(1, simS / tl.doneAt),
      etaRealS: simS < tl.arriveAt && view.state !== "cancelled" ? Math.max(0, (tl.arriveAt - simS) / this.compression) : null,
      routeSource: route.source,
      driverId,
    };
  }

  /** The next transition that is due for this order, or null. */
  private async nextEvent(view: OrderView, orderId: string, station: Station, tl: ReturnType<typeof demoTimeline>, simS: number): Promise<SubmitInput | null> {
    const driver = { actor: "driver" as const, actorId: view.driverId ?? undefined };
    switch (view.state) {
      case "placed":
        if (simS < tl.acceptAt) return null;
        await this.ensureDriver(station); // normal dispatch then assigns it on acceptance (it is at the station, so its ETA is about zero)
        return { type: "station_accepted", actor: "station" };
      case "accepted":
        // Acceptance already tried to dispatch. If it found nobody (pool was full), keep trying on later steps.
        if (!view.driverId) {
          await this.ensureDriver(station);
          await this.engine.tryAssign(orderId);
        }
        return null;
      case "assigned":
        return simS >= tl.departAt ? { type: "driver_departed", ...driver } : null;
      case "en_route":
        return simS >= tl.arriveAt ? { type: "driver_arrived", ...driver } : null;
      case "arrived":
        return simS >= tl.startAt ? { type: "delivery_started", ...driver } : null;
      case "delivering":
        return simS >= tl.doneAt ? { type: "delivery_completed", ...driver } : null;
      default:
        return null;
    }
  }

  /** At most one routing request per order: one caller claims the lookup, the rest wait for it or, if it died, use the straight line. */
  private async ensureRoute(demo: DemoRecord, station: Station, view: OrderView): Promise<DemoRecord> {
    const store = this.engine.store;
    const to = { lat: view.dropoff.lat, lng: view.dropoff.lng };
    if (!demo.routePending && (await store.claimDemoRoute(demo.orderId))) {
      let r;
      try {
        r = compactRoute(await this.routes.route({ lat: station.lat, lng: station.lng }, to));
      } catch {
        r = compactRoute(await new StraightLineRouteProvider().route({ lat: station.lat, lng: station.lng }, to)); // a provider that throws is treated like a failed lookup
      }
      await store.setDemoRoute(demo.orderId, r);
      this.opts.onRoute?.({ source: r.source });
    } else if (demo.routePending && this.now() - demo.startedAt > ROUTE_CLAIM_STALE_MS) {
      await store.setDemoRoute(demo.orderId, compactRoute(await new StraightLineRouteProvider().route({ lat: station.lat, lng: station.lng }, to)));
    }
    return (await store.getDemo(demo.orderId)) ?? demo;
  }

  /**
   * An available demo driver standing at the station, reserving one from the pool when there is none. Returns its id, or
   * null when all eight are busy. Claiming goes through guarded status updates, so two callers cannot take the same driver.
   */
  private async ensureDriver(station: Station): Promise<string | null> {
    const store = this.engine.store;
    const here = (await store.listDrivers({ status: "available" })).find((d) => isDemoDriverId(d.id) && distanceM(d, station) < 100);
    if (here) return here.id;
    for (let i = 1; i <= DEMO_POOL_SIZE; i++) {
      const id = demoDriverId(i);
      const d = await store.getDriver(id);
      if (d?.status === "busy") continue;
      if (!d) await store.upsertDriver({ id, name: `Demo driver ${i}`, status: "offline", lat: station.lat, lng: station.lng, locationAt: null, isSimulated: true });
      // Leftover "available" drivers (an order was cancelled) are reset to offline first; either way the claim is exclusive.
      if (d?.status === "available" && !(await store.setDriverStatus(id, "offline", "available"))) continue;
      if (!(await store.setDriverStatus(id, "available", "offline"))) continue;
      await store.upsertDriver({ id, name: `Demo driver ${i}`, status: "available", lat: station.lat, lng: station.lng, locationAt: this.now(), isSimulated: true });
      return id;
    }
    return null;
  }
}

