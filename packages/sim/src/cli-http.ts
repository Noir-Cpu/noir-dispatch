// Run one burst against a deployed (or local) API:
//   SIM_TOKEN=... npm run sim:http -w @noir/sim -- --url https://noir-dispatch-api.noir-cpu.workers.dev --seed 1
import { runBurst } from "./http-sim";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const num = (k: string) => (args.has(k) ? Number(args.get(k)) : undefined);
const token = process.env.SIM_TOKEN;
if (!token) throw new Error("set SIM_TOKEN");
const baseUrl = (args.get("url") ?? process.env.SIM_URL ?? "").replace(/\/$/, "");
if (!baseUrl) throw new Error("pass --url");

const report = await runBurst({
  baseUrl,
  token,
  seed: num("seed") ?? Date.now() % 1_000_000,
  durationMs: num("seconds") ? num("seconds")! * 1000 : undefined,
  maxRequests: num("max-requests"),
  drivers: num("drivers"),
  minActive: num("min-active"),
  log: console.log,
});
console.log(JSON.stringify(report, null, 2));
