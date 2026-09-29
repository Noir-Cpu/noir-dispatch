// Run: npm run sim -w @noir/sim -- --hours 1 --seed 42
// Local, in-process run against PGlite. Numbers it prints are local and not production measurements.
import { writeFileSync } from "node:fs";
import { createLocalEngine } from "@noir/engine/local";
import { Simulation, type SimConfig } from "./simulation";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);

const hours = num("hours", 1);
const config: Partial<SimConfig> = {
  seed: num("seed", 42),
  drivers: num("drivers", 50),
  ordersPerHour: num("orders-per-hour", 200),
};

let sim: Simulation;
const k = await createLocalEngine({ metrics: (m) => m.type === "assignment" && sim.recordAssignment(m.ms, m.assigned) });
sim = new Simulation({ engine: k.engine, clock: k.clock, pay: k.payOrder, config });
await sim.init();
const t0 = performance.now();
await sim.runVirtual(hours);
const wallSeconds = (performance.now() - t0) / 1000;
const report = { ...(await sim.report()), config: sim.cfg, wallSeconds: Math.round(wallSeconds * 10) / 10 };
console.log(JSON.stringify(report, null, 2));
if (args.has("out")) writeFileSync(args.get("out")!, JSON.stringify(report, null, 2) + "\n");
await k.close();
