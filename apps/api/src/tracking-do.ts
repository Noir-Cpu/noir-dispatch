import { DurableObject } from "cloudflare:workers";
import { DrizzleStore, createNeonDb } from "@noir/db";
import { TrackRoom, type TrackMessage, type TrackPoint } from "@noir/core";
import type { Env } from "./app";
import { MAX_SOCKETS_PER_ROOM } from "./security";

type DoEnv = Env;

/**
 * One instance per active delivery (named by order id). The logic lives in TrackRoom (packages/core,
 * unit tested); this class only adapts hibernatable WebSockets and SQLite storage to it.
 * Live positions stay in memory. Only the downsampled track (one point per 30 s) is written: to this
 * object's SQLite storage and, when DATABASE_URL is set, to Postgres driver_locations.
 */
export class TrackingRoom extends DurableObject<DoEnv> {
  private room: TrackRoom;

  constructor(ctx: DurableObjectState, env: DoEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("create table if not exists track (t integer primary key, order_id text, driver_id text, lat real, lng real)");
    sql.exec("create table if not exists meta (k text primary key, v text)");

    this.room = new TrackRoom({ persist: (p) => this.persist(p) });
    const track = sql.exec("select t, order_id, driver_id, lat, lng from track order by t").toArray().map(
      (r): TrackPoint => ({ t: Number(r.t), orderId: String(r.order_id), driverId: String(r.driver_id), lat: Number(r.lat), lng: Number(r.lng) }),
    );
    const status = sql.exec("select v from meta where k = 'status'").toArray()[0]?.v;
    this.room.restore({ status: status === undefined ? null : String(status), track });
    // One subscriber fans out to every accepted socket, including ones that survived hibernation.
    this.room.subscribe((m) => this.broadcast(m));
  }

  private persist(p: TrackPoint) {
    this.ctx.storage.sql.exec("insert or replace into track (t, order_id, driver_id, lat, lng) values (?, ?, ?, ?, ?)", p.t, p.orderId, p.driverId, p.lat, p.lng);
    if (this.env.DATABASE_URL) {
      // Fire and forget: a slow database must not delay live delivery.
      void new DrizzleStore(createNeonDb(this.env.DATABASE_URL)).recordLocationIfDue(p, 0).catch(() => {});
    }
  }

  private broadcast(m: TrackMessage) {
    if (m.type === "snapshot") return; // snapshots go to the joining socket only
    const text = JSON.stringify(m);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        /* closed socket */
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/ws") {
      if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_ROOM) return new Response("room full", { status: 429, headers: { "retry-after": "30" } });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const s = this.room.snapshot();
      pair[1].send(JSON.stringify({ type: "snapshot", ...s } satisfies TrackMessage));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    if (path === "/publish") {
      this.room.ingest((await request.json()) as TrackPoint);
      return new Response(null, { status: 204 });
    }
    if (path === "/status") {
      const { status } = (await request.json()) as { status: string };
      this.ctx.storage.sql.exec("insert or replace into meta (k, v) values ('status', ?)", status);
      this.room.setStatus(status);
      return new Response(null, { status: 204 });
    }
    if (path === "/close") {
      for (const ws of this.ctx.getWebSockets()) ws.close(1000, "delivery finished");
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }

  // Viewers only listen; ignore anything they send. A client that sends anyway is closed so it cannot hold the room open with traffic.
  webSocketMessage(ws: WebSocket) {
    try {
      ws.close(1008, "viewers do not send");
    } catch {
      /* already closed */
    }
  }
  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      /* already closed */
    }
  }
}
