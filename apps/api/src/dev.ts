// Local dev server: PGlite in memory, the simulator running, WebSocket tracking, and the built web app.
// No Neon, no Cloudflare. `npm run dev:local` from the repo root builds the web app and starts this.
import { createLocalEngine } from "@noir/engine/local";
import { Simulation } from "@noir/sim";
import { startLocalServer } from "./local-server";

const env = process.env;
const port = Number(env.PORT ?? 8787);
const timeScale = Number(env.SIM_TIME_SCALE ?? 1);

let sim: Simulation | undefined;
const k = await createLocalEngine({
  startAt: Date.now(),
  metrics: (m) => m.type === "assignment" && sim?.recordAssignment(m.ms, m.assigned),
});
await startLocalServer(k, port);

if (env.SIM !== "0") {
  sim = new Simulation({
    engine: k.engine,
    clock: k.clock,
    pay: k.payOrder,
    config: { seed: Number(env.SIM_SEED ?? 42), drivers: Number(env.SIM_DRIVERS ?? 20), ordersPerHour: Number(env.SIM_ORDERS_PER_HOUR ?? 30) },
  });
  await sim.init();
  let tick = 0;
  let busy = false;
  setInterval(async () => {
    if (busy) return; // never overlap steps
    busy = true;
    try {
      await sim!.step(tick++);
    } catch (e) {
      console.error("sim step failed", e);
    } finally {
      busy = false;
    }
  }, (sim.cfg.tickSeconds * 1000) / timeScale);
}

console.log(`dispatch dev server on http://localhost:${port} (sim ${env.SIM === "0" ? "off" : `x${timeScale}`}, PGlite in memory)`);
