import { HaversineEta, TestPaymentProvider, type EtaProvider } from "@noir/core";
import { DrizzleStore } from "@noir/db";
import { createPgliteDb } from "@noir/db/pglite";
import { payAsProvider } from "./pay-as-provider";
import { Engine, type EngineConfig, type EngineMetric } from "./engine";
import { seedStations } from "./seed";

export const WEBHOOK_SECRET = "local-test-webhook-secret";

/** In-memory Postgres (PGlite) engine with a controllable clock. Dev server, simulator and tests share it. */
export async function createLocalEngine(o: { eta?: EtaProvider; config?: Partial<EngineConfig>; startAt?: number; metrics?: (m: EngineMetric) => void; dataDir?: string; seedStations?: boolean } = {}) {
  const { db, close } = await createPgliteDb(o.dataDir);
  const store = new DrizzleStore(db);
  if (o.seedStations !== false) await seedStations(store);
  const provider = new TestPaymentProvider(WEBHOOK_SECRET);
  const clock = { now: o.startAt ?? Date.parse("2026-01-15T08:00:00Z") };
  let n = 0;
  const engine = new Engine({
    store,
    payments: provider,
    eta: o.eta ?? new HaversineEta(),
    clock: () => clock.now,
    newId: () => `ord_${String(++n).padStart(6, "0")}`,
    config: o.config,
    metrics: o.metrics,
  });
  const payOrder = (orderId: string, eventId?: string) => payAsProvider(engine, provider, orderId, clock.now, eventId);
  return { engine, store, db, provider, clock, close, payOrder };
}
export type LocalEngine = Awaited<ReturnType<typeof createLocalEngine>>;
