// HTTP-mode simulator: drives the PUBLIC API (place order, station accept, payments, location pings, driver
// transitions) so a deployed Worker shows live movement. Safe to point at production:
//  - every call is authenticated with SIM_TOKEN, and the server only lets that token touch simulated records
//    (plus one exception: it may accept new orders as stand-in station staff);
//  - it spends a hard request budget and never exceeds a request rate;
//  - it is seeded, and ends each burst by asking the server to expire old simulated orders.
// Stateless between bursts: it reads what it needs from GET /api/sim/state each tick.
import { haversineMeters, stepToward, type LatLng } from "@noir/core";
import { CAPE_TOWN_STATIONS } from "@noir/engine";
import { rng, type Rng } from "./rng";

export type HttpSimConfig = {
  baseUrl: string;
  token: string;
  seed: number;
  fetch?: typeof fetch;
  drivers: number;
  /** Keep at least this many simulated orders in flight so the demo is never empty. */
  minActive: number;
  /** Wall-clock length of the burst. */
  durationMs: number;
  tickMs: number;
  /** Hard cap on HTTP requests this burst may make, counting every call. */
  maxRequests: number;
  /** Never exceed this many requests per second. */
  maxRps: number;
  speedKmh: number;
  maxDropoffKm: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
};

export const HTTP_SIM_DEFAULTS = { drivers: 6, minActive: 3, durationMs: 4 * 60_000, tickMs: 5_000, maxRequests: 400, maxRps: 5, speedKmh: 60, maxDropoffKm: 2.5 };

type OrderState = {
  id: string;
  isSimulated: boolean;
  state: string;
  driverId: string | null;
  stationId: string;
  dropoff: LatLng;
  paymentStatus: string | null;
  placedAt: number;
  events: { type: string; at: number }[];
};
type DriverState = { id: string; status: string; lat: number; lng: number };

export type BurstReport = {
  seed: number;
  requests: number;
  budget: number;
  stoppedBy: "duration" | "budget";
  ticks: number;
  ordersPlaced: number;
  transitions: Record<string, number>;
  pings: number;
  cleanup: unknown;
};

export async function runBurst(partial: Partial<HttpSimConfig> & Pick<HttpSimConfig, "baseUrl" | "token" | "seed">): Promise<BurstReport> {
  const cfg = { ...HTTP_SIM_DEFAULTS, ...partial } as HttpSimConfig;
  const f = cfg.fetch ?? fetch;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = cfg.now ?? Date.now;
  const r: Rng = rng(cfg.seed);
  let requests = 0;
  let lastCall = 0;
  const transitions: Record<string, number> = {};
  let pings = 0;
  let ordersPlaced = 0;

  class BudgetExhausted extends Error {}

  async function call<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    if (requests >= cfg.maxRequests) throw new BudgetExhausted();
    requests++;
    const gap = 1000 / cfg.maxRps - (now() - lastCall);
    if (gap > 0) await sleep(gap);
    lastCall = now();
    const res = await f(`${cfg.baseUrl}/api${path}`, {
      method,
      headers: { "content-type": "application/json", "x-sim-token": cfg.token, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new HttpError(res.status, `${method} ${path}: ${(json as { error?: string }).error ?? res.status}`);
    return json;
  }

  // Driver positions are held here during the burst; they start from the server's last stored point.
  const pos = new Map<string, LatLng>();
  const started = now();
  let ticks = 0;
  let stoppedBy: BurstReport["stoppedBy"] = "duration";
  let cleanup: unknown = null;

  try {
    // 1. Make sure the simulated fleet exists and is online (idempotent on the server).
    for (let i = 1; i <= cfg.drivers; i++) {
      const st = CAPE_TOWN_STATIONS[(i - 1) % CAPE_TOWN_STATIONS.length]!;
      const start = { lat: st.lat + r.range(-0.01, 0.01), lng: st.lng + r.range(-0.01, 0.01) };
      await call("POST", "/sim/drivers", { id: driverId(i), name: `Sim driver ${i}`, ...start });
    }

    const seenAssigned = new Set<string>();
    while (now() - started < cfg.durationMs) {
      const tickStart = now();
      const state = await call<{ now: number; orders: OrderState[]; drivers: DriverState[] }>("GET", "/sim/state");
      for (const d of state.drivers) if (!pos.has(d.id)) pos.set(d.id, { lat: d.lat, lng: d.lng });

      // 2. Keep the demo alive: top up simulated orders.
      const activeSim = state.orders.filter((o) => o.isSimulated).length;
      for (let n = activeSim; n < cfg.minActive; n++) {
        const st = r.pick(CAPE_TOWN_STATIONS);
        const ang = r.range(0, 2 * Math.PI);
        const km = cfg.maxDropoffKm * Math.sqrt(r.next());
        await call(
          "POST",
          "/sim/orders",
          {
            customerId: `sim-cust-${r.int(1, 21)}`,
            stationId: st.id,
            fuel: r.next() < 0.6 ? "diesel" : "petrol_95",
            litres: r.int(20, 81),
            dropoff: {
              lat: round6(st.lat + (km / 111.32) * Math.sin(ang)),
              lng: round6(st.lng + (km / (111.32 * Math.cos((st.lat * Math.PI) / 180))) * Math.cos(ang)),
              label: `Simulated address ${r.int(1, 999)}`,
            },
          },
          { "idempotency-key": `http-sim-${cfg.seed}-${ordersPlaced}` },
        );
        ordersPlaced++;
      }

      // 3. Advance every order that needs a nudge.
      const moved = new Set<string>();
      for (const o of state.orders) {
        const age = (type: string) => state.now - ([...o.events].reverse().find((e) => e.type === type)?.at ?? state.now);
        const act = async (actor: string, type: string, actorId?: string) => {
          await call("POST", `/orders/${o.id}/events`, { actor, actorId, type }).catch(tolerate);
          transitions[type] = (transitions[type] ?? 0) + 1;
        };
        if (o.state === "placed" && state.now - o.placedAt > 8_000) await act("station", "station_accepted");
        if (o.isSimulated && o.paymentStatus === "requires_payment" && state.now - o.placedAt > 4_000) {
          await call("POST", `/sim/pay/${o.id}`).catch(tolerate);
          transitions.paid = (transitions.paid ?? 0) + 1;
        }
        if (!o.driverId || !pos.has(o.driverId)) continue; // only simulated drivers are ever in `pos`
        const me = o.driverId;
        const here = pos.get(me);
        if (!here) continue;
        if (o.state === "assigned" && age("driver_assigned") > 4_000) await act("driver", "driver_departed", me);
        else if (o.state === "en_route") {
          const next = stepToward(here, o.dropoff, ((cfg.speedKmh * 1000) / 3600) * (cfg.tickMs / 1000));
          pos.set(me, next);
          moved.add(me);
          await ping(me, next, o.id);
          if (haversineMeters(next, o.dropoff) < 40) {
            await act("driver", "driver_arrived", me);
            await act("driver", "delivery_started", me);
          }
        } else if (o.state === "delivering") {
          await ping(me, here, o.id);
          moved.add(me);
          if (age("delivery_started") > 45_000) await act("driver", "delivery_completed", me);
        } else if (o.state === "arrived") await act("driver", "delivery_started", me);
      }

      // 4. Idle drivers ping now and then (server downsamples to one stored point per 30 s anyway).
      if (ticks % 6 === 0) {
        for (const d of state.drivers) {
          if (moved.has(d.id) || d.status === "busy") continue;
          const p = pos.get(d.id)!;
          const wander = { lat: p.lat + r.range(-0.0005, 0.0005), lng: p.lng + r.range(-0.0005, 0.0005) };
          pos.set(d.id, wander);
          await ping(d.id, wander);
        }
      }

      ticks++;
      const wait = cfg.tickMs - (now() - tickStart);
      if (wait > 0) await sleep(wait);
    }
  } catch (e) {
    if (e instanceof BudgetExhausted) stoppedBy = "budget";
    else throw e;
  }

  // 5. Expire old simulated orders. Uses one request even if the budget is spent (reserve is small and fixed).
  cfg.maxRequests += 1;
  cleanup = await call("POST", "/sim/cleanup").catch((e) => String(e));
  cfg.log?.(`burst done: ${requests}/${cfg.maxRequests} requests, ${ticks} ticks`);
  return { seed: cfg.seed, requests, budget: cfg.maxRequests - 1, stoppedBy, ticks, ordersPlaced, transitions, pings, cleanup };

  async function ping(id: string, p: LatLng, orderId?: string) {
    pings++;
    await call("POST", `/drivers/${id}/location`, { lat: round6(p.lat), lng: round6(p.lng), orderId }).catch(tolerate);
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
// A transition can lose a race (another burst, a cancellation): that is normal, not a failure.
function tolerate(e: unknown) {
  if (e instanceof HttpError && [403, 404, 409, 422].includes(e.status)) return;
  throw e;
}
const driverId = (i: number) => `sim-drv-${String(i).padStart(2, "0")}`;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
