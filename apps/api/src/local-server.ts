// Node host for the same Hono app and TrackRoom logic the Worker and Durable Object use.
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import type { TrackHub } from "@noir/core";
import type { LocalEngine } from "@noir/engine/local";
import { createApp } from "./app";

export async function startLocalServer(k: LocalEngine, port: number) {
  const hub = k.engine.hub as TrackHub;
  const api = createApp({ engine: () => k.engine, devPay: (_env, orderId) => k.payOrder(orderId) });

  const dist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const relDist = "../web/dist";
  const root = new Hono();
  root.route("/", api);
  root.get("*", async (c, next) => {
    if (!existsSync(dist)) return c.text("web app not built: run `npm run build -w @noir/web`", 404);
    const file = c.req.path.slice(1);
    if (file && !file.endsWith("/") && existsSync(`${dist}/${file}`)) return serveStatic({ root: relDist })(c, next);
    return c.html(readFileSync(`${dist}/index.html`, "utf8")); // single-page-app fallback
  });

  const server = serve({ fetch: (req) => root.fetch(req, { DEV_TOOLS: "1" }), port }) as Server;

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (req, socket, head) => {
    const m = new URL(req.url ?? "", "http://x").pathname.match(/^\/api\/orders\/([^/]+)\/track$/);
    if (!m || !(await k.store.getOrder(m[1]!))) return socket.destroy();
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
