import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { ACTORS, FUELS, WebhookSignatureError, availableActions, type Actor } from "@noir/core";
import { Engine, EngineError } from "@noir/engine";
import { tracing, type OtelEnv } from "./otel";

export type Env = OtelEnv & {
  DATABASE_URL?: string;
  PAYMENT_WEBHOOK_SECRET?: string;
  /** "1" exposes /api/dev/*: pay-as-provider and dispatch tick. Never set in production. */
  DEV_TOOLS?: string;
  SENTRY_DSN_API?: string;
  // Durable Object namespace; typed loosely here so app.ts stays runtime-agnostic.
  TRACKING?: unknown;
};

export type AppServices = {
  /** Build the engine for this request. Returns null when the backing database is not configured. */
  engine: (env: Env) => Engine | null;
  /** Workers only: hand a WebSocket upgrade for one order to its Durable Object. */
  trackUpgrade?: (env: Env, orderId: string, req: Request) => Promise<Response>;
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

export function createApp(services: AppServices) {
  const app = new Hono<{ Bindings: Env; Variables: { engine: Engine } }>().basePath("/api");

  app.use("*", tracing());

  app.get("/health", (c) => c.json({ ok: true }));

  // Everything below needs the engine (and so the database).
  app.use("*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    const engine = services.engine(c.env ?? {});
    if (!engine) return c.json({ error: "database_not_configured" }, 503);
    c.set("engine", engine);
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof EngineError) return c.json({ error: err.code, message: err.message }, err.code === "unknown_station" ? 404 : 422);
    console.error(JSON.stringify({ level: "error", msg: String(err) }));
    return c.json({ error: "internal" }, 500);
  });

  app.get("/stations", async (c) => c.json({ stations: await c.var.engine.store.listStations() }));

  app.get("/drivers", async (c) => c.json({ drivers: await c.var.engine.store.listDrivers() }));

  app.post("/orders", zValidator("json", placeBody), async (c) => {
    const key = c.req.header("idempotency-key");
    if (!key || key.length > 128) return c.json({ error: "idempotency_key_required" }, 400);
    const b = c.req.valid("json");
    const e = c.var.engine;
    await e.store.upsertCustomer({ id: b.customerId, name: b.customerName ?? "Customer" });
    const { order, created, clientSecret } = await e.placeOrder({ ...b, idempotencyKey: key });
    return c.json({ order: present(order), clientSecret }, created ? 201 : 200);
  });

  app.get("/orders", async (c) => {
    const e = c.var.engine;
    const active = c.req.query("active") === "1";
    const list = await e.store.listOrders({ active });
    return c.json({ orders: list.map((o) => ({ id: o.id, ...o.view })) });
  });

  app.get("/orders/:id", async (c) => {
    const d = await c.var.engine.detail(c.req.param("id"));
    return d ? c.json({ order: present(d) }) : c.json({ error: "not_found" }, 404);
  });

  app.post("/orders/:id/events", zValidator("json", eventEnvelope.and(eventBody)), async (c) => {
    const { actor, actorId, ...ev } = c.req.valid("json");
    const r = await c.var.engine.submit(c.req.param("id"), { ...ev, actor, actorId });
    if (!r.ok) return c.json({ error: r.error.code, message: r.error.message }, STATUS[r.error.code] ?? 400);
    return c.json({ order: present((await c.var.engine.detail(c.req.param("id")))!) });
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

  app.post("/drivers/:id/location", zValidator("json", latLng.extend({ orderId: z.string().optional() })), async (c) => {
    const { orderId, ...pos } = c.req.valid("json");
    const driverId = c.req.param("id");
    if (orderId) {
      const o = await c.var.engine.store.getOrder(orderId);
      if (o?.view.driverId !== driverId) return c.json({ error: "not_assigned_driver" }, 403);
    }
    await c.var.engine.recordLocation({ driverId, orderId, ...pos });
    return c.body(null, 204);
  });

  app.post("/drivers/:id/online", zValidator("json", latLng), async (c) => {
    await c.var.engine.driverOnline(c.req.param("id"), c.req.valid("json"));
    return c.body(null, 204);
  });
  app.post("/drivers/:id/offline", async (c) => {
    await c.var.engine.driverOffline(c.req.param("id"));
    return c.body(null, 204);
  });

  // Raw body: the signature covers the exact bytes, so parse nothing before verifying.
  app.post("/payments/webhook", async (c) => {
    try {
      const r = await c.var.engine.handleWebhook(await c.req.text(), c.req.header("x-test-signature") ?? null);
      return c.json(r);
    } catch (e) {
      if (e instanceof WebhookSignatureError) return c.json({ error: "bad_signature" }, 400);
      throw e;
    }
  });

  // Called by a timer (dev server) or an external scheduler; not user-facing.
  app.post("/dispatch/tick", async (c) => {
    const assigned = await c.var.engine.dispatchPending();
    const cancelled = await c.var.engine.sweep();
    return c.json({ assigned, cancelled });
  });

  app.post("/dev/pay/:orderId", async (c) => {
    if (c.env?.DEV_TOOLS !== "1" || !services.devPay) return c.json({ error: "not_found" }, 404);
    return c.json(await services.devPay(c.env, c.req.param("orderId")));
  });

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
