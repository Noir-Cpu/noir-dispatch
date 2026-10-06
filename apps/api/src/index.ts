import * as Sentry from "@sentry/cloudflare";
import { FallbackRouteProvider, HaversineEta, OsrmRouteProvider, PaystackProvider, StraightLineRouteProvider, TestPaymentProvider, type PaymentProvider } from "@noir/core";
import { DrizzleStore, createNeonDb } from "@noir/db";
import { Engine, payAsProvider } from "@noir/engine";
import { createApp, type AppServices, type Env } from "./app";
import { createAuth, opsSession, type AuthEnv } from "./auth";
import { DoHub } from "./do-hub";
import { parseRadiusKm } from "./config";
import { cloudflareLimiter } from "./guards";

export { TrackingRoom } from "./tracking-do";

// The fake provider is the default and the only one that works without extra secrets. Paystack is opt-in
// (PAYMENTS_PROVIDER=paystack plus a TEST-mode key; the adapter refuses sk_live_ keys).
function provider(env: Env): PaymentProvider | null {
  if (env.PAYMENTS_PROVIDER === "paystack") return env.PAYSTACK_SECRET_KEY ? new PaystackProvider({ secretKey: env.PAYSTACK_SECRET_KEY }) : null;
  return env.PAYMENT_WEBHOOK_SECRET ? new TestPaymentProvider(env.PAYMENT_WEBHOOK_SECRET) : null;
}

function buildEngine(env: Env): Engine | null {
  const payments = provider(env);
  if (!env.DATABASE_URL || !payments) return null;
  return new Engine({
    store: new DrizzleStore(createNeonDb(env.DATABASE_URL)),
    payments,
    eta: new HaversineEta(),
    config: { deliveryRadiusKm: parseRadiusKm(env.DELIVERY_RADIUS_KM) },
    hub: env.TRACKING ? new DoHub(env.TRACKING as DurableObjectNamespace) : undefined,
  });
}

const services: AppServices = {
  engine: buildEngine,
  trackUpgrade: async (env, orderId, req) => {
    if (!env.TRACKING) return new Response("tracking not configured", { status: 503 });
    return new DoHub(env.TRACKING as DurableObjectNamespace).upgrade(orderId, req);
  },
  // Public OSRM demo server: no guarantee, light use only. One lookup per order (DemoRunner), 3 s timeout, straight-line fallback.
  routes: () =>
    new FallbackRouteProvider(
      new OsrmRouteProvider({ userAgent: "noir-dispatch-demo/1.0 (+https://github.com/Noir-Cpu/noir-dispatch)", timeoutMs: 3000 }),
      new StraightLineRouteProvider(),
      (reason) => console.warn(JSON.stringify({ level: "warn", msg: "route lookup failed, using straight line", reason })),
    ),
  opsSession: (env, req) => opsSession(env as AuthEnv, req),
  authHandler: (env, req) => createAuth(env as AuthEnv, req.url).handler(req),
  rateLimiter: (env) => (env.RATE_LIMIT ? cloudflareLimiter(env.RATE_LIMIT as Parameters<typeof cloudflareLimiter>[0]) : undefined),
  // Only meaningful with the fake provider; app.ts additionally refuses any other provider.
  devPay: async (env, orderId) => {
    const p = provider(env);
    const engine = buildEngine(env);
    return engine && p instanceof TestPaymentProvider ? payAsProvider(engine, p, orderId, Date.now()) : null;
  },
};

const app = createApp(services);

const handler = {
  fetch: app.fetch,
  // Hourly safety net: assign waiting orders and cancel ones that waited too long (dispatch also runs inline on order and
  // driver events). Daily at 03:00 UTC: retention. Not per minute: that keeps Neon compute awake around the clock.
  async scheduled(event: ScheduledController, env: Env) {
    const engine = buildEngine(env);
    if (!engine) return;
    await engine.dispatchPending();
    await engine.sweep();
    const at = new Date(event.scheduledTime);
    if (at.getUTCHours() === 3 && at.getUTCMinutes() === 0) await engine.runRetention({ locationDays: 7, simulatedHours: 24 });
  },
} satisfies ExportedHandler<Env>;

export default Sentry.withSentry((env: Env) => ({ dsn: env.SENTRY_DSN_API, tracesSampleRate: 0 }), handler);
