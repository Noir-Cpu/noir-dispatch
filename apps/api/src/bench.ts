// Local benchmark: `npm run bench -- --hours 1 --seed 42 [--time-scale 20] [--out file.json]`
// Runs the simulator as fast as it can against PGlite, with a real loopback WebSocket subscriber per order.
// Everything here is a local, single-process number. It says nothing about Workers, Neon or a network.
import { writeFileSync } from "node:fs";
import { WebSocket } from "ws";
import { createLocalEngine } from "@noir/engine/local";
import { Simulation, percentile } from "@noir/sim";
import { startLocalServer } from "./local-server";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);

let sim: Simulation;
const k = await createLocalEngine({ metrics: (m) => m.type === "assignment" && sim.recordAssignment(m.ms, m.assigned) });
const server = await startLocalServer(k, 0);

const wsMs: number[] = [];
let wsMessages = 0;
const sockets: WebSocket[] = [];
sim = new Simulation({
  engine: k.engine,
  clock: k.clock,
  pay: k.payOrder,
  config: { seed: num("seed", 42), drivers: num("drivers", 50), ordersPerHour: num("orders-per-hour", 200) },
  onOrderPlaced: (orderId) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/orders/${orderId}/track`);
    ws.on("message", (raw) => {
      const arrived = performance.now();
      const m = JSON.parse(String(raw)) as { type: string; point?: { orderId: string; t: number } };
      if (m.type !== "position" || !m.point) return;
      wsMessages++;
      const sent = sim.sends.get(`${m.point.orderId}:${m.point.t}`);
      if (sent !== undefined) wsMs.push(arrived - sent);
    });
    ws.on("error", () => {});
    sockets.push(ws);
  },
});
await sim.init();
const t0 = performance.now();
await sim.runVirtual(num("hours", 1), { timeScale: args.has("time-scale") ? num("time-scale", 1) : undefined });
await new Promise((r) => setTimeout(r, 500)); // let the last frames arrive
const wall = (performance.now() - t0) / 1000;

const inproc = await sim.report();
const stat = (xs: number[]) => ({ n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), max: xs.length ? Math.max(...xs) : NaN });
const out = {
  note: "local, single-process numbers (PGlite in memory, loopback WebSocket); not a production measurement",
  ...inproc,
  locationToLoopbackWebSocketMs: stat(wsMs),
  wsMessagesReceived: wsMessages,
  wallSeconds: Math.round(wall * 10) / 10,
  config: sim.cfg,
  timeScale: args.has("time-scale") ? num("time-scale", 1) : "flat out (no pacing)",
};
console.log(JSON.stringify(out, null, 2));
if (args.has("out")) writeFileSync(args.get("out")!, JSON.stringify(out, null, 2) + "\n");
for (const s of sockets) s.terminate();
await server.close();
await k.close();
process.exit(0);
