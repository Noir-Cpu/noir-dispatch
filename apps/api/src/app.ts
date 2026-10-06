import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createMiddleware } from "hono/factory";
import { ACTORS, DEMO_TIME_COMPRESSION, FUELS, StraightLineRouteProvider, WebhookSignatureError, availableActions, isDemoDriverId, type Actor, type RouteProvider } from "@noir/core";
import { DEMO_DEFAULT_DAILY_STEP_CAP, DemoRunner, Engine, EngineError, type DemoErrorCode } from "@noir/engine";
import { tracing, type OtelEnv } from "./otel";
import { MemoryRateLimiter, isAllowedLogin, orderToken, safeEqual, type RateLimiter } from "./guards";

export type Env = OtelEnv & {
  DATABASE_URL?: string;
  PAYMENT_WEBHOOK_SECRET?: string;
  /** Selects the payment provider. Anything but "paystack" means the fake test provider. */
  PAYMENTS_PROVIDER?: string;
  PAYSTACK_SECRET_KEY?: string;
  /** "1" exposes the demo "pay" endpoint. It only works with the fake provider; see devPayAllowed. */
  DEV_TOOLS?: string;
  /** Secret behind order tokens (customer capability for their own order). */
  ORDER_TOKEN_SECRET?: string;
  /** Shared secret held by the simulator runner. */
  SIM_TOKEN?: string;
  OPS_ALLOWED_GITHUB?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SENTRY_DSN_API?: string;
  /** Plain wrangler var: straight-line km from the chosen station within which orders are accepted. Default 12. */
  DELIVERY_RADIUS_KM?: string;
  /** Plain wrangler var: global cap on demo steps per UTC day (bounds Neon compute). Default 400. */
  DEMO_DAILY_STEP_CAP?: string;
  // Durable Object namespace and rate-limit binding; typed loosely so app.ts stays runtime-agnostic.
  TRACKING?: unknown;
  RATE_LIMIT?: unknown;
};

export type AppServices = {
  /** Build the engine for this request. Returns null when the backing database is not configured. */
  engine: (env: Env) => Engine | null;
  /** Workers only: hand a WebSocket upgrade for one order to its Durable Object. */
  trackUpgrade?: (env: Env, orderId: string, req: Request) => Promise<Response>;
  /** Signed-in ops user for this request, or null. */
  opsSession?: (env: Env, req: Request) => Promise<{ login: string } | null>;
  /** Auth handler mounted at /api/auth/* (Better Auth). */
  authHandler?: (env: Env, req: Request) => Promise<Response>;
  rateLimiter?: (env: Env) => RateLimiter | undefined;
  /** Routing for the on-demand demo (one lookup per order). Omitted means straight lines, with no network call. */
  routes?: (env: Env) => RouteProvider;
  /** Wall clock for the demo; omit to use the engine's clock (Date.now on the Worker). The dev server's engine clock is simulated. */
  demoClock?: () => number;
  /** Dev only: a signed "customer paid" event through the real webhook path. */
  devPay?: (env: Env, orderId: string) => Promise<unknown>;
};

const latLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const dropoff = latLng.extend({ label: z.string().min(1).max(120) });

const placeBody = z.object({
  customerId: z.string().min(1).max(64),
  customerName: z.string().min(1).max(80).optional(),
  stationId: z.string().min(1).max(64),
  fuel: z.enum(FUELS),
  litres: z.number().positive().max(500),
  dropoff,
  note: z.string().max(200).optional(),
});

const reason = z.object({ reason: z.string().max(120).optional() }).optional();
// The system actor and its events are not reachable from the API.
const eventBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("station_accepted") }),
  z.object({ type: z.literal("driver_declined"), data: reason }),
  z.object({ type: z.literal("driver_departed") }),
  z.object({ type: z.literal("driver_arrived") }),
  z.object({ type: z.literal("delivery_started") }),
  z.object({ type: z.literal("delivery_completed") }),
  z.object({ type: z.literal("order_cancelled"), data: reason }),
  z.object({ type: z.literal("order_modified"), data: z.object({ dropoff: dropoff.optional(), note: z.string().max(200).optional() }) }),
]);
const eventEnvelope = z.object({ actor: z.enum(ACTORS).exclude(["system"]), actorId: z.string().max(64).optional() });

const DEMO_STATUS: Record<DemoErrorCode, 403 | 404 | 409 | 429 | 503> = {
  not_found: 404,
  not_demoable: 403,
  payment_required: 409,
  other_driver: 409,
  no_driver: 503,
  step_limit: 429,
  daily_cap: 429,
};

const STATUS: Record<string, 400 | 403 | 404 | 409 | 422> = {
  no_order: 404,
  not_found: 404,
  already_placed: 409,
  terminal: 409,
  illegal_state: 409,
  conflict: 409,
  forbidden_actor: 403,
  not_assigned_driver: 403,
  invalid_data: 422,
};

type Vars = { engine: Engine; sim: boolean; ops: { login: string } | null };

export function createApp(services: AppServices) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>().basePath("/api");
  const memory = new MemoryRateLimiter(60, 60_000);
  const demoMemory = new MemoryRateLimiter(60, 60_000);
  const demoCapMemo = { day: null as string | null }; // per isolate: once today's cap is hit, stop asking the database

  app.use("*", tracing());

  app.get("/health", (c) => c.json({ ok: true }));

  // Better Auth (GitHub sign-in for the ops console). Needs no engine.
  app.on(["GET", "POST"], "/auth/*", (c) =>
    services.authHandler ? services.authHandler(c.env ?? {}, c.req.raw) : c.json({ error: "auth_not_configured" }, 404),
  );

  // Everything below needs the engine (and so the database), and knows who is calling.
  app.use("*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    const env = c.env ?? {};
    const engine = services.engine(env);
    if (!engine) return c.json({ error: "database_not_configured" }, 503);
    c.set("engine", engine);
    c.set("sim", safeEqual(c.req.header("x-sim-token"), env.SIM_TOKEN));
    const ops = services.opsSession ? await services.opsSession(env, c.req.raw).catch(() => null) : null;
    c.set("ops", ops && isAllowedLogin(ops.login, env.OPS_ALLOWED_GITHUB) ? ops : null);
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof EngineError) return c.json({ error: err.code, message: err.message, ...err.details }, err.code === "unknown_station" ? 404 : 422);
    console.error(JSON.stringify({ level: "error", msg: String(err) }));
    return c.json({ error: "internal" }, 500);
  });

  // Every request that declares a role (customer, driver, station) passes through this limiter, per client address.
  // Simulator runs are exempt server-side because they are limited by their own budget and token.
  const limited = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
    if (c.var.sim) return next();
    const limiter = services.rateLimiter?.(c.env ?? {}) ?? memory;
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    if (!(await limiter.allow(`${ip}:${c.req.method}`))) return c.json({ error: "rate_limited" }, 429);
    return next();
  });

  const requireOps = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
    if (!c.var.ops) return c.json({ error: "ops_sign_in_required" }, 401);
    return next();
  });

  // The on-demand demo exists only with DEV_TOOLS=1 and the fake payment provider, whatever else is configured.
  const demoAllowed = (c: { env: Env | undefined; var: Vars }) => c.env?.DEV_TOOLS === "1" && c.var.engine.paymentProvider === "test";

  const tokenOk = async (c: { env: Env | undefined }, orderId: string, given: string | undefined) => {
    const secret = c.env?.ORDER_TOKEN_SECRET;
    return !!secret && safeEqual(given, await orderToken(secret, orderId));
  };

  // ---- public ---------------------------------------------------------------------------------

  // What the web app needs to know about this deployment. No database access.
  app.get("/config", (c) =>
    c.json({
      deliveryRadiusKm: c.var.engine.config.deliveryRadiusKm,
      demo: { available: demoAllowed(c), speed: DEMO_TIME_COMPRESSION },
    }),
  );

  app.get("/stations", async (c) => c.json({ stations: await c.var.engine.store.listStations() }));

  app.get("/ops/me", (c) => (c.var.ops ? c.json({ login: c.var.ops.login }) : c.json({ error: "ops_sign_in_required" }, 401)));

  app.post("/orders", limited, zValidator("json", placeBody), async (c) => {
    const key = c.req.header("idempotency-key");
    if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
    const b = c.req.valid("json");
    const e = c.var.engine;
    // Customers are anonymous: the customer id is a label, ownership of the order is the order token.
    await e.store.upsertCustomer({ id: b.customerId, name: b.customerName ?? "Customer" });
    const { order, created, clientSecret } = await e.placeOrder({ ...b, idempotencyKey: key });
    const secret = c.env?.ORDER_TOKEN_SECRET;
    return c.json({ order: present(order), clientSecret, orderToken: secret ? await orderToken(secret, order.id) : null }, created ? 201 : 200);
  });

  // An order id is unguessable and acts as a read capability for that order's page.
  app.get("/orders/:id", async (c) => {
    const d = await c.var.engine.detail(c.req.param("id"));
    return d ? c.json({ order: present(d) }) : c.json({ error: "not_found" }, 404);
  });

  app.post("/orders/:id/events", limited, zValidator("json", eventEnvelope.and(eventBody)), async (c) => {
    const { actor, actorId, ...ev } = c.req.valid("json");
    const id = c.req.param("id");
    const e = c.var.engine;
    const rec = await e.store.getOrder(id);
    if (!rec) return c.json({ error: "not_found" }, 404);
    const forbidden = (why: string) => c.json({ error: "forbidden", message: why }, 403);
    const ops = c.var.ops;
    const sim = c.var.sim;

    if (actor === "customer") {
      // Only the holder of this order's token (or ops); the simulator only for its own orders.
      const owns = await tokenOk(c, id, c.req.header("x-order-token"));
      if (!(owns || ops || (sim && rec.isSimulated))) return forbidden("not your order");
    } else if (actor === "station") {
      // Stations are staff, not anonymous. The simulator plays station staff and may accept any new order.
      const simOk = sim && (rec.isSimulated || ev.type === "station_accepted");
      if (!(ops || simOk)) return forbidden("station actions need an ops sign-in");
    } else if (actor === "driver") {
      // Anonymous drivers are allowed (demo), but the machine still requires actorId to be the assigned driver,
      // and simulated drivers can only be driven by the simulator.
      const driver = actorId ? await e.store.getDriver(actorId) : null;
      if (driver?.isSimulated && !(sim || ops)) return forbidden("simulated driver");
      if (sim && !driver?.isSimulated) return forbidden("simulator may only drive simulated drivers");
    }
    const r = await e.submit(id, { ...ev, actor, actorId });
    if (!r.ok) return c.json({ error: r.error.code, message: r.error.message }, STATUS[r.error.code] ?? 400);
    return c.json({ order: present((await e.detail(id))!) });
  });

  // The road route cached for an order that has run the demo (null for everything else): a read capability like the order itself.
  app.get("/orders/:id/route", async (c) => {
    const demo = await c.var.engine.store.getDemo(c.req.param("id"));
    return c.json({
      route: demo?.route ? { points: demo.route.points.map((p) => [p.lat, p.lng]), source: demo.route.source, distanceM: demo.route.distanceM, durationS: demo.route.durationS } : null,
      demo: demo ? { startedAt: demo.startedAt, speed: DEMO_TIME_COMPRESSION } : null,
    });
  });

  // One step of the on-demand demo. Guards, in order: feature on (DEV_TOOLS=1 and the fake provider) else 404; rate limits per IP
  // and per order else 429; the order's own token else 403. Idempotent by construction: see DemoRunner.
  app.post("/orders/:id/demo/step", async (c) => {
    if (!demoAllowed(c)) return c.json({ error: "not_found" }, 404);
    const id = c.req.param("id");
    const limiter = services.rateLimiter?.(c.env ?? {}) ?? demoMemory;
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    if (!(await limiter.allow(`demo-ip:${ip}`)) || !(await limiter.allow(`demo-order:${id}`))) return c.json({ error: "rate_limited" }, 429);
    if (!(await c.var.engine.store.getOrder(id))) return c.json({ error: "not_found" }, 404);
    if (!(await tokenOk(c, id, c.req.header("x-order-token")))) return c.json({ error: "forbidden", message: "not your order" }, 403);
    const cap = Number(c.env?.DEMO_DAILY_STEP_CAP);
    const runner = new DemoRunner(c.var.engine, services.routes?.(c.env ?? {}) ?? new StraightLineRouteProvider(), {
      dailyStepCap: Number.isFinite(cap) && cap > 0 ? cap : DEMO_DEFAULT_DAILY_STEP_CAP,
      capMemo: demoCapMemo,
      now: services.demoClock,
    });
    const r = await runner.step(id);
    if (!r.ok) return c.json({ error: r.error.code, message: r.error.message }, DEMO_STATUS[r.error.code]);
    const { ok: _ok, ...body } = r;
    return c.json(body);
  });

  app.get("/orders/:id/track", async (c) => {
    if (c.req.header("upgrade") !== "websocket" || !services.trackUpgrade) return c.json({ error: "websocket_required" }, 426);
    // Only real orders get a room, so arbitrary ids cannot spin up Durable Objects.
    if (!(await c.var.engine.store.getOrder(c.req.param("id")))) return c.json({ error: "not_found" }, 404);
    return services.trackUpgrade(c.env, c.req.param("id"), c.req.raw);
  });

  app.get("/orders/:id/locations", async (c) =>
    c.json({ points: await c.var.engine.store.listLocations({ orderId: c.req.param("id") }) }),
  );

  // ---- drivers (anonymous demo driver app, or the simulator for simulated drivers) ---------------

  const driverGate = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
    const d = await c.var.engine.store.getDriver(c.req.param("id")!);
    if (!d) return c.json({ error: "unknown_driver" }, 404);
    if (d.isSimulated && !(c.var.sim || c.var.ops)) return c.json({ error: "forbidden", message: "simulated driver" }, 403);
    if (c.var.sim && !d.isSimulated) return c.json({ error: "forbidden", message: "simulator may only drive simulated drivers" }, 403);
    return next();
  });

  app.post("/drivers/:id/location", limited, driverGate, zValidator("json", latLng.extend({ orderId: z.string().optional() })), async (c) => {
    const { orderId, ...pos } = c.req.valid("json");
    const driverId = c.req.param("id");
    if (orderId) {
      const o = await c.var.engine.store.getOrder(orderId);
      if (o?.view.driverId !== driverId) return c.json({ error: "not_assigned_driver" }, 403);
    }
    await c.var.engine.recordLocation({ driverId, orderId, ...pos });
    return c.body(null, 204);
  });
  app.post("/drivers/:id/online", limited, driverGate, zValidator("json", latLng), async (c) => {
    await c.var.engine.driverOnline(c.req.param("id"), c.req.valid("json"));
    return c.body(null, 204);
  });
  app.post("/drivers/:id/offline", limited, driverGate, async (c) => {
    await c.var.engine.driverOffline(c.req.param("id"));
    return c.body(null, 204);
  });

  // ---- payments -------------------------------------------------------------------------------

  // Raw body: the signature covers the exact bytes, so parse nothing before verifying.
  app.post("/payments/webhook", async (c) => {
    try {
      const e = c.var.engine;
      return c.json(await e.handleWebhook(await c.req.text(), c.req.header(e.signatureHeader) ?? null));
    } catch (e) {
      if (e instanceof WebhookSignatureError) return c.json({ error: "bad_signature" }, 400);
      throw e;
    }
  });

  // Demo "pay" button. Refuses unless the provider is the fake one, whatever DEV_TOOLS says, so this switch
  // can never reach a real-money path. Needs the order's own token.
  app.post("/dev/pay/:orderId", limited, async (c) => {
    const id = c.req.param("orderId");
    const devPayAllowed = c.env?.DEV_TOOLS === "1" && c.var.engine.paymentProvider === "test" && !!services.devPay;
    if (!devPayAllowed) return c.json({ error: "not_found" }, 404);
    const rec = await c.var.engine.store.getOrder(id);
    if (!rec) return c.json({ error: "not_found" }, 404);
    if (!(await tokenOk(c, id, c.req.header("x-order-token"))) && !c.var.ops) return c.json({ error: "forbidden", message: "not your order" }, 403);
    return c.json(await services.devPay!(c.env, id));
  });

  // ---- ops (GitHub sign-in, allow-listed) --------------------------------------------------------

  app.get("/orders", requireOps, async (c) => {
    const active = c.req.query("active") === "1";
    const list = await c.var.engine.store.listOrders({ active });
    return c.json({ orders: list.map((o) => ({ id: o.id, isSimulated: o.isSimulated, ...o.view })) });
  });
  app.get("/drivers", requireOps, async (c) => c.json({ drivers: await c.var.engine.store.listDrivers() }));

  const tick = async (c: { var: Vars }) => ({ assigned: await c.var.engine.dispatchPending(), cancelled: await c.var.engine.sweep() });
  app.post("/dispatch/tick", requireOps, async (c) => c.json(await tick(c)));
  app.post("/ops/retention", requireOps, async (c) => c.json(await c.var.engine.runRetention()));

  // ---- simulator runner (shared-secret token; touches simulated records only) ----------------------

  const requireSim = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
    if (!c.var.sim) return c.json({ error: "forbidden" }, 403);
    return next();
  });

  app.post("/sim/drivers", requireSim, zValidator("json", latLng.extend({ id: z.string().regex(/^sim-drv-\d{2,3}$/), name: z.string().max(40) })), async (c) => {
    const b = c.req.valid("json");
    const e = c.var.engine;
    const existing = await e.store.getDriver(b.id);
    if (!existing) await e.store.upsertDriver({ id: b.id, name: b.name, status: "offline", lat: b.lat, lng: b.lng, locationAt: null, isSimulated: true });
    else if (!existing.isSimulated) return c.json({ error: "forbidden" }, 403);
    if (!existing || existing.status === "offline") await e.driverOnline(b.id, { lat: b.lat, lng: b.lng });
    return c.body(null, 204);
  });

  app.post("/sim/orders", requireSim, zValidator("json", placeBody.omit({ customerName: true })), async (c) => {
    const key = c.req.header("idempotency-key");
    if (!key) return c.json({ error: "idempotency_key_required" }, 400);
    const b = c.req.valid("json");
    if (!b.customerId.startsWith("sim-cust-")) return c.json({ error: "invalid_customer" }, 400);
    const e = c.var.engine;
    await e.store.upsertCustomer({ id: b.customerId, name: "Simulated customer", isSimulated: true });
    const { order } = await e.placeOrder({ ...b, idempotencyKey: key, isSimulated: true });
    return c.json({ id: order.id });
  });

  app.post("/sim/pay/:orderId", requireSim, async (c) => {
    const rec = await c.var.engine.store.getOrder(c.req.param("orderId"));
    if (!rec?.isSimulated || !services.devPay || c.var.engine.paymentProvider !== "test") return c.json({ error: "forbidden" }, 403);
    return c.json(await services.devPay(c.env, rec.id));
  });

  // What the runner needs in one request: active simulated orders, new orders awaiting a station, simulated drivers.
  app.get("/sim/state", requireSim, async (c) => {
    const e = c.var.engine;
    const [orders, drivers] = await Promise.all([e.store.listOrders({ active: true }), e.store.listDrivers()]);
    const detail = async (o: (typeof orders)[number]) => {
      const events = await e.store.listEvents(o.id);
      const pay = await e.store.getPaymentByOrder(o.id);
      return { id: o.id, isSimulated: o.isSimulated, ...o.view, paymentStatus: pay?.status ?? null, events: events.map((x) => ({ type: x.event.type, at: x.event.at })) };
    };
    // Demo drivers belong to the on-demand demo (driven by visitors' own steps), so the burst simulator must not touch them.
    const simDrivers = new Set(drivers.filter((d) => d.isSimulated && !isDemoDriverId(d.id)).map((d) => d.id));
    // Its own orders, new orders awaiting station staff, and visitors' orders a simulated driver is carrying.
    const relevant = orders.filter((o) => o.isSimulated || o.view.state === "placed" || (o.view.driverId && simDrivers.has(o.view.driverId)));
    return c.json({
      now: e.now(),
      orders: await Promise.all(relevant.map(detail)),
      drivers: drivers.filter((d) => d.isSimulated && !isDemoDriverId(d.id)),
    });
  });

  app.post("/sim/cleanup", requireSim, async (c) => c.json({ ...(await c.var.engine.runRetention({ simulatedHours: 6 })), cancelled: await c.var.engine.sweep() }));

  return app;
}

/** Order detail plus what each actor may do next, so UIs render buttons from the server's rules. */
function present(d: Awaited<ReturnType<Engine["detail"]>> & object) {
  const actions = Object.fromEntries((ACTORS.filter((a) => a !== "system") as Actor[]).map((a) => [a, availableActions(d.view, a)]));
  return {
    id: d.id,
    ...d.view,
    payment: d.payment && { status: d.payment.status, amountCents: d.payment.amountCents, refundedCents: d.payment.refundedCents },
    events: d.events.map((e) => ({ seq: e.seq, type: e.event.type, actor: e.event.actor, actorId: e.event.actorId ?? null, at: e.event.at, data: e.event.data ?? null })),
    actions,
  };
}
