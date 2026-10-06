import {
  stepToward,
  type Driver,
  type LatLng,
  type OrderRecord,
  type TrackHub,
} from "@noir/core";
import { CAPE_TOWN_BOX, SIM_STATIONS, type Engine } from "@noir/engine";
import { percentile, rng, type Rng } from "./rng";

export type SimConfig = {
  seed: number;
  drivers: number;
  ordersPerHour: number;
  /** Virtual seconds per step. Drivers ping active deliveries once per step (strategy doc: every 5 s). */
  tickSeconds: number;
  /** Driver speed. An assumption for the demo, not measured Cape Town traffic. */
  speedKmh: number;
  /** Customers order within this radius of their station. */
  maxDropoffKm: number;
  /** Chance an assigned driver declines. */
  declineRate: number;
};

export const DEFAULT_SIM: SimConfig = { seed: 42, drivers: 50, ordersPerHour: 200, tickSeconds: 5, speedKmh: 40, maxDropoffKm: 4, declineRate: 0.03 };

type Phase = "idle" | "reacting" | "to_station" | "loading" | "to_customer" | "delivering";
type Bot = {
  id: string;
  pos: LatLng;
  wander: LatLng;
  phase: Phase;
  orderId: string | null;
  until: number;
  pingOffset: number;
};
type Scheduled = { at: number; run: () => Promise<unknown> };

export type SimReport = {
  seed: number;
  virtualMinutes: number;
  orders: { placed: number; completed: number; cancelled: number; open: number };
  cancelReasons: Record<string, number>;
  declines: number;
  pings: number;
  persistedLocationRows: number;
  /** Wall-clock ms of the assignment step (rank drivers, claim one, append driver_assigned). Local, in-process. */
  assignmentMs: { n: number; p50: number; p95: number; max: number };
  /** Virtual seconds from order placed to driver assigned; includes the simulated station and payment delays. */
  placedToAssignedSeconds: { n: number; p50: number; p95: number };
  /**
   * Virtual seconds from the order being both accepted and paid to a driver being assigned: the time an
   * order spent waiting for dispatch (no free driver, or a decline and reassignment).
   */
  readyToAssignedSeconds: { n: number; p50: number; p95: number; max: number };
  /** Wall-clock ms from a driver ping entering the engine to an in-process subscriber receiving it. */
  locationToSubscriberMs: { n: number; p50: number; p95: number; max: number };
};

export class Simulation {
  readonly cfg: SimConfig;
  private r: Rng;
  private bots: Bot[] = [];
  private queue: Scheduled[] = [];
  private placed = 0;
  private pings = 0;
  private declines = 0;
  private assignMs: number[] = [];
  private locMs: number[] = [];
  private stopOrders = false;
  /** Orders whose station acceptance is already scheduled (ours and ones placed by real users of the web app). */
  private adopted = new Set<string>();
  private payAt = new Map<string, number>();
  private started = 0;
  private sentAt = 0;
  /** `${orderId}:${t}` -> performance.now() when the ping entered the engine. For latency across a real socket. */
  readonly sends = new Map<string, number>();
  private stationById = new Map(SIM_STATIONS.map((s) => [s.id, s]));

  constructor(
    private readonly o: {
      engine: Engine;
      /** Virtual clock the engine also reads. */
      clock: { now: number };
      /** Fires the signed "customer paid" webhook for an order. */
      pay: (orderId: string) => Promise<unknown>;
      perfNow?: () => number;
      /** Called for each order the simulator places (e.g. to attach a real WebSocket subscriber). */
      onOrderPlaced?: (orderId: string) => void;
      config?: Partial<SimConfig>;
    },
  ) {
    this.cfg = { ...DEFAULT_SIM, ...o.config };
    this.r = rng(this.cfg.seed);
    this.started = o.clock.now;
  }

  private get perf() {
    return this.o.perfNow ?? (() => performance.now());
  }

  /** Called by the caller's engine metrics hook. */
  recordAssignment(ms: number, assigned: boolean) {
    if (assigned) this.assignMs.push(ms);
  }

  private point(): LatLng {
    const b = CAPE_TOWN_BOX;
    return { lat: this.r.range(b.south, b.north), lng: this.r.range(b.west, b.east) };
  }

  async init() {
    const { engine } = this.o;
    for (let i = 0; i < this.cfg.drivers; i++) {
      const pos = this.point();
      const id = `drv-${String(i + 1).padStart(2, "0")}`;
      const d: Driver = { id, name: `Driver ${i + 1}`, status: "offline", lat: pos.lat, lng: pos.lng, locationAt: null };
      await engine.store.upsertDriver(d);
      await engine.driverOnline(id, pos);
      this.bots.push({ id, pos, wander: this.point(), phase: "idle", orderId: null, until: 0, pingOffset: i % 6 });
    }
  }

  private metersPerTick() {
    return ((this.cfg.speedKmh * 1000) / 3600) * this.cfg.tickSeconds;
  }

  private schedule(delaySeconds: number, run: () => Promise<unknown>) {
    this.queue.push({ at: this.o.clock.now + delaySeconds * 1000, run });
  }

  private async spawnOrders() {
    const { engine } = this.o;
    const n = this.r.poisson((this.cfg.ordersPerHour / 3600) * this.cfg.tickSeconds);
    for (let i = 0; i < n; i++) {
      const st = this.r.pick(SIM_STATIONS);
      const ang = this.r.range(0, 2 * Math.PI);
      const km = this.cfg.maxDropoffKm * Math.sqrt(this.r.next());
      const dropoff = {
        lat: st.lat + (km / 111.32) * Math.sin(ang),
        lng: st.lng + (km / (111.32 * Math.cos((st.lat * Math.PI) / 180))) * Math.cos(ang),
        label: `Sim address ${this.placed + 1}`,
      };
      const customerId = `cust-${(this.placed % 40) + 1}`;
      await engine.store.upsertCustomer({ id: customerId, name: `Customer ${(this.placed % 40) + 1}` });
      const { order } = await engine.placeOrder({
        customerId,
        stationId: st.id,
        fuel: this.r.next() < 0.6 ? "diesel" : "petrol_95",
        litres: this.r.int(20, 81),
        dropoff,
        idempotencyKey: `sim-${this.cfg.seed}-${this.placed}`,
      });
      this.placed++;
      const id = order.id;
      this.o.onOrderPlaced?.(id);
      // Stand-in customer: subscribes to live position and records delivery latency.
      (this.o.engine.hub as TrackHub).room(id).subscribe((m) => {
        if (m.type === "position") this.locMs.push(this.perf() - this.sentAt);
      });
      const payDelay = this.r.range(5, 30);
      this.payAt.set(id, this.o.clock.now + payDelay * 1000);
      this.schedule(payDelay, () => this.o.pay(id));
    }
  }

  private async ping(bot: Bot) {
    this.pings++;
    this.sentAt = this.perf();
    if (bot.orderId) this.sends.set(`${bot.orderId}:${this.o.clock.now}`, this.sentAt);
    await this.o.engine.recordLocation({ driverId: bot.id, orderId: bot.orderId, lat: bot.pos.lat, lng: bot.pos.lng, t: this.o.clock.now });
  }

  private async stepBot(bot: Bot, active: Map<string, OrderRecord>, tick: number) {
    const { engine } = this.o;
    const now = this.o.clock.now;
    const mine = [...active.values()].find((o) => o.view.driverId === bot.id);

    // The order vanished or moved on (cancelled by sweep, driver unassigned): go back to roaming.
    if (bot.orderId && (!mine || mine.id !== bot.orderId)) {
      bot.orderId = null;
      bot.phase = "idle";
    }
    if (!bot.orderId && mine) {
      bot.orderId = mine.id;
      bot.phase = "reacting";
      bot.until = now + this.r.range(2, 8) * 1000;
    }

    const order = bot.orderId ? active.get(bot.orderId) : undefined;
    const station = order ? this.stationById.get(order.view.stationId)! : undefined;
    const move = (to: LatLng) => {
      bot.pos = stepToward(bot.pos, to, this.metersPerTick());
      return bot.pos.lat === to.lat && bot.pos.lng === to.lng;
    };
    const act = async (type: "driver_declined" | "driver_departed" | "driver_arrived" | "delivery_started" | "delivery_completed") => {
      const r = await engine.submit(bot.orderId!, { type, actor: "driver", actorId: bot.id });
      return r.ok;
    };

    switch (bot.phase) {
      case "idle": {
        if (move(bot.wander)) bot.wander = this.point();
        break;
      }
      case "reacting":
        if (now >= bot.until) {
          if (this.r.next() < this.cfg.declineRate) {
            this.declines++;
            await act("driver_declined");
            bot.orderId = null;
            bot.phase = "idle";
          } else if (await act("driver_departed")) bot.phase = "to_station";
        }
        break;
      case "to_station":
        if (move(station!)) {
          bot.phase = "loading";
          bot.until = now + this.r.range(60, 120) * 1000;
        }
        break;
      case "loading":
        if (now >= bot.until) bot.phase = "to_customer";
        break;
      case "to_customer":
        if (move(order!.view.dropoff) && (await act("driver_arrived")) && (await act("delivery_started"))) {
          bot.phase = "delivering";
          bot.until = now + this.r.range(120, 240) * 1000;
        }
        break;
      case "delivering":
        if (now >= bot.until && (await act("delivery_completed"))) {
          bot.orderId = null;
          bot.phase = "idle";
        }
        break;
    }
    // Active deliveries ping every tick; idle drivers every 30 s (six ticks).
    if (bot.orderId || (tick + bot.pingOffset) % 6 === 0) await this.ping(bot);
  }

  /** Advance one virtual tick. */
  async step(tick: number) {
    const { engine, clock } = this.o;
    clock.now += this.cfg.tickSeconds * 1000;
    if (!this.stopOrders) await this.spawnOrders();

    const due = this.queue.filter((s) => s.at <= clock.now).sort((a, b) => a.at - b.at);
    this.queue = this.queue.filter((s) => s.at > clock.now);
    for (const s of due) await s.run();

    const active = new Map((await engine.store.listOrders({ active: true })).map((o) => [o.id, o]));
    // Stand-in station staff: accept every new order after a short delay, whoever placed it.
    for (const o of active.values()) {
      if (o.view.state !== "placed" || this.adopted.has(o.id)) continue;
      this.adopted.add(o.id);
      this.schedule(this.r.range(15, 90), () => engine.submit(o.id, { type: "station_accepted", actor: "station" }));
    }
    for (const bot of this.bots) await this.stepBot(bot, active, tick);

    if (tick % 6 === 0) {
      await engine.dispatchPending();
      await engine.sweep();
    }
  }

  /**
   * Stop placing orders after `hours`, then keep stepping until everything settles (or a cap).
   * `timeScale` paces steps against the wall clock (20 = one virtual second per 50 ms); omitted, it runs flat out.
   */
  async runVirtual(hours: number, opts: { timeScale?: number } = {}) {
    const ticks = Math.round((hours * 3600) / this.cfg.tickSeconds);
    const tickMs = opts.timeScale ? (this.cfg.tickSeconds * 1000) / opts.timeScale : 0;
    const start = performance.now();
    let tick = 0;
    const pace = async () => {
      if (!tickMs) return;
      const wait = start + (tick + 1) * tickMs - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    };
    for (; tick < ticks; tick++) {
      await this.step(tick);
      await pace();
    }
    this.stopOrders = true;
    const cap = tick + Math.round((90 * 60) / this.cfg.tickSeconds);
    while (tick < cap && (await this.o.engine.store.listOrders({ active: true })).length > 0) {
      await this.step(tick);
      await pace();
      tick++;
    }
  }

  async report(): Promise<SimReport> {
    const { engine, clock } = this.o;
    const all = await engine.store.listOrders();
    const cancelReasons: Record<string, number> = {};
    const waits: number[] = [];
    const ready: number[] = [];
    for (const o of all) {
      if (o.view.cancel) {
        const k = `${o.view.cancel.by}:${o.view.cancel.reason ?? "none"}`;
        cancelReasons[k] = (cancelReasons[k] ?? 0) + 1;
      }
      const events = await engine.store.listEvents(o.id);
      const asg = events.find((e) => e.event.type === "driver_assigned");
      if (asg) {
        waits.push((asg.event.at - o.view.placedAt) / 1000);
        const acc = events.find((e) => e.event.type === "station_accepted");
        const paid = this.payAt.get(o.id);
        // Orders placed by someone else (the web app) have no recorded pay time; only sim-placed orders count here.
        if (acc && paid !== undefined) ready.push(Math.max(0, (asg.event.at - Math.max(acc.event.at, paid)) / 1000));
      }
    }
    const locations = await engine.store.listLocations({});
    const stat = (xs: number[]) => ({ n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), max: xs.length ? Math.max(...xs) : Number.NaN });
    return {
      seed: this.cfg.seed,
      virtualMinutes: Math.round((clock.now - this.started) / 60_000),
      orders: {
        placed: all.length,
        completed: all.filter((o) => o.view.state === "completed").length,
        cancelled: all.filter((o) => o.view.state === "cancelled").length,
        open: all.filter((o) => !["completed", "cancelled"].includes(o.view.state)).length,
      },
      cancelReasons,
      declines: this.declines,
      pings: this.pings,
      persistedLocationRows: locations.length,
      assignmentMs: stat(this.assignMs),
      placedToAssignedSeconds: { n: waits.length, p50: percentile(waits, 50), p95: percentile(waits, 95) },
      readyToAssignedSeconds: { n: ready.length, p50: percentile(ready, 50), p95: percentile(ready, 95), max: ready.length ? Math.max(...ready) : Number.NaN },
      locationToSubscriberMs: stat(this.locMs),
    };
  }
}
