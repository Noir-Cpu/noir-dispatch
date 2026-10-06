// Node host for the same Hono app and TrackRoom logic the Worker and Durable Object use.
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { FallbackRouteProvider, OsrmRouteProvider, StraightLineRouteProvider, type TrackHub } from "@noir/core";
import type { LocalEngine } from "@noir/engine/local";
import { createApp } from "./app";
import { sameOriginSocket } from "./security";
import { headersFor, parseHeadersFile } from "./static-headers";

export const DEV_ORDER_TOKEN_SECRET = "dev-only-order-token-secret";

export async function startLocalServer(k: LocalEngine, port: number, opts: { open?: boolean } = {}) {
  const hub = k.engine.hub as TrackHub;
  // Dev mode has no GitHub OAuth: the ops console is open unless DEV_AUTH=0 (then it behaves as signed out).
  const api = createApp({
    engine: () => k.engine,
    devPay: (_env, orderId) => k.payOrder(orderId),
    demoClock: Date.now, // the engine clock here is simulated (and runs at SIM_TIME_SCALE); the demo plays in real time
    // Straight lines unless ROUTE_PROVIDER=osrm: dev runs and CI must not lean on the public OSRM demo server.
    routes: () =>
      process.env.ROUTE_PROVIDER === "osrm"
        ? new FallbackRouteProvider(new OsrmRouteProvider({ userAgent: "noir-dispatch-dev/1.0 (+https://github.com/Noir-Cpu/noir-dispatch)" }), new StraightLineRouteProvider(), (why) => console.warn("route lookup failed:", why))
        : new StraightLineRouteProvider(),
    opsSession: opts.open === false ? undefined : async () => ({ login: "dev" }),
  });

  const dist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const relDist = "../web/dist";
  const root = new Hono();
  root.route("/", api);
  // The same headers production serves for static files (Cloudflare reads dist/_headers); see apps/web/public/_headers.
  const headerRules = existsSync(`${dist}/_headers`) ? parseHeadersFile(readFileSync(`${dist}/_headers`, "utf8")) : [];
  root.get("*", async (c, next) => {
    if (!existsSync(dist)) return c.text("web app not built: run `npm run build -w @noir/web`", 404);
    for (const [k, v] of Object.entries(headersFor(headerRules, c.req.path))) c.header(k, v);
    const file = c.req.path.slice(1);
    if (file && !file.endsWith("/") && existsSync(`${dist}/${file}`)) return serveStatic({ root: relDist })(c, next);
    return c.html(readFileSync(`${dist}/index.html`, "utf8")); // single-page-app fallback
  });

  const server = serve({ fetch: (req) => root.fetch(req, { DEV_TOOLS: "1", ORDER_TOKEN_SECRET: DEV_ORDER_TOKEN_SECRET, OPS_ALLOWED_GITHUB: "dev" }), port }) as Server;

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (req, socket, head) => {
    const m = new URL(req.url ?? "", "http://x").pathname.match(/^\/api\/orders\/([^/]+)\/track$/);
    if (!m || !sameOriginSocket(req.headers.origin, req.headers.host) || !(await k.store.getOrder(m[1]!))) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const off = hub.room(m[1]!).subscribe((msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)));
      ws.on("close", off);
      ws.on("error", off);
    });
  });
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    close: () =>
      new Promise<void>((r) => {
        wss.close();
        for (const c of wss.clients) c.terminate();
        server.close(() => r());
        server.closeAllConnections?.();
      }),
  };
}
