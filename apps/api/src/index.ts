import * as Sentry from "@sentry/cloudflare";
import { HaversineEta, TestPaymentProvider } from "@noir/core";
import { DrizzleStore, createNeonDb } from "@noir/db";
import { Engine, payAsProvider } from "@noir/engine";
import { createApp, type AppServices, type Env } from "./app";
import { DoHub } from "./do-hub";

export { TrackingRoom } from "./tracking-do";

// The test provider is the only wired provider; Paystack/Stripe adapters are stubs (see README).
function buildEngine(env: Env): Engine | null {
  if (!env.DATABASE_URL || !env.PAYMENT_WEBHOOK_SECRET) return null;
  return new Engine({
    store: new DrizzleStore(createNeonDb(env.DATABASE_URL)),
    payments: new TestPaymentProvider(env.PAYMENT_WEBHOOK_SECRET),
    eta: new HaversineEta(),
    hub: env.TRACKING ? new DoHub(env.TRACKING as DurableObjectNamespace) : undefined,
  });
}

const services: AppServices = {
  engine: buildEngine,
  trackUpgrade: async (env, orderId, req) => {
    if (!env.TRACKING) return new Response("tracking not configured", { status: 503 });
    return new DoHub(env.TRACKING as DurableObjectNamespace).upgrade(orderId, req);
  },
  devPay: async (env, orderId) => {
    const engine = buildEngine(env);
    return engine ? payAsProvider(engine, new TestPaymentProvider(env.PAYMENT_WEBHOOK_SECRET!), orderId, Date.now()) : null;
  },
};

const app = createApp(services);

const handler = {
  fetch: app.fetch,
  // Once a minute: assign waiting orders and cancel ones that waited too long.
  async scheduled(_event: ScheduledController, env: Env) {
    const engine = buildEngine(env);
    if (!engine) return;
    await engine.dispatchPending();
    await engine.sweep();
  },
} satisfies ExportedHandler<Env>;

export default Sentry.withSentry((env: Env) => ({ dsn: env.SENTRY_DSN_API, tracesSampleRate: 0 }), handler);
